/**
 * Research MCP Tool (web-research)
 *
 * In-process MCP server exposing a single `web_research` tool. It does ONLY the
 * research: classify query complexity via Haiku → call the Perplexity Agent API
 * → optional AWS Bedrock Guardrails scan → return raw findings as structured
 * JSON (`content`, `source_urls`).
 *
 * It is intentionally side-effect-free (no file writes, no knowledge.log). The
 * host concerns — persisting the report to `shared/` and wrapping the result in
 * defensive tags — live in the PostToolUse hook (`./hook.ts`), wired in
 * `spawn.ts`. Per-task budgeting is enforced separately by the host-side
 * PreToolUse guard (`METERED_TOOLS` in src/system/tool-budgets.ts).
 */

import crypto from 'node:crypto';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z, toJSONSchema } from 'zod';
import { logger } from '../../system/logger.js';

// ============================================================================
// Preset Classification (Haiku)
// ============================================================================

const PresetSchema = z.object({
  preset: z.enum(['fast-search', 'pro-search', 'deep-research']),
  reasoning: z.string(),
});

// Mirror the title-generator pattern: strip the JSON Schema dialect URL
// ($schema) — some SDK structured-output validators reject it, which caused
// classification to silently fail and always fall back to pro-search.
const rawPresetSchema = toJSONSchema(PresetSchema) as Record<string, unknown>;
const { $schema: _dropSchema, ...presetJsonSchema } = rawPresetSchema;

const CLASSIFIER_SYSTEM_PROMPT = `You are a research query classifier. Analyze the query and select the most appropriate Perplexity search preset.

Presets:
- fast-search: Simple factual lookups, definitions, single-entity queries, quick answers
- pro-search: Multi-faceted questions, comparisons, current events, moderate research
- deep-research: Comprehensive analysis, market research, technical deep-dives, broad strategic topics

Respond with JSON only.`;

export type ResearchPreset = z.infer<typeof PresetSchema>['preset'];

/**
 * Classify query complexity to select the right Perplexity preset.
 * Uses Haiku with structured JSON output (same lean shape as the title
 * generator, which is the proven-working one-shot pattern).
 * Falls back to pro-search on any failure.
 */
export async function classifyPreset(topic: string, context?: string): Promise<ResearchPreset> {
  const prompt = `Classify this research query and select the appropriate Perplexity preset.

Research topic: ${topic}${context ? `\nContext: ${context}` : ''}

Respond with JSON only.`;

  try {
    let result: z.infer<typeof PresetSchema> | null = null;

    for await (const event of query({
      prompt,
      options: {
        model: 'haiku',
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        executable: 'node',
        env: {
          NODE_ENV: process.env.NODE_ENV || 'development',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          PATH: process.env.PATH,
        },
        tools: [],
        maxTurns: 2,
        outputFormat: {
          type: 'json_schema',
          schema: presetJsonSchema,
        },
      },
    })) {
      if (event.type !== 'result') continue;
      if (event.subtype === 'success') {
        const parsed = PresetSchema.safeParse((event as any).structured_output);
        if (parsed.success) {
          result = parsed.data;
          logger.agent('research', `Classified as ${result.preset}: ${result.reasoning}`);
        } else {
          logger.warn('research', `preset schema validation failed: ${parsed.error.message}`);
        }
      } else {
        logger.warn('research', `preset classification failed: ${event.subtype}`);
      }
    }

    return result?.preset ?? 'pro-search';
  } catch (error) {
    logger.warn('research', 'Preset classification failed, defaulting to pro-search', error);
    return 'pro-search';
  }
}

// ============================================================================
// Perplexity Agent API
// ============================================================================

interface PerplexityResponse {
  output_text: string;
  citations: string[];
}

/**
 * Call Perplexity Agent API with the selected preset.
 */
async function callPerplexity(preset: string, input: string): Promise<PerplexityResponse> {
  const apiKey = process.env.PERPLEXITY_API_KEY!;

  const response = await fetch('https://api.perplexity.ai/v1/agent', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      preset,
      model: 'anthropic/claude-sonnet-4-6',
      input,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Perplexity API error ${response.status}: ${body}`);
  }

  const data = await response.json() as any;
  // Perplexity Agent API follows OpenAI Responses API format:
  // `output` is an array with search_results and message items
  let text = '';
  const citations: string[] = [];

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          // Extract text
          if (block.type === 'output_text' && typeof block.text === 'string') {
            text += block.text;
          }
          // Extract citations from annotations
          if (Array.isArray(block.annotations)) {
            for (const ann of block.annotations) {
              if (ann.type === 'url_citation' && ann.url) {
                citations.push(ann.url);
              }
            }
          }
        }
      }
      // Extract URLs from search_results items
      if (item.type === 'search_results' && Array.isArray(item.results)) {
        for (const result of item.results) {
          if (result.url) {
            citations.push(result.url);
          }
        }
      }
    }
  }

  // Fallback: top-level fields
  if (!text && typeof data.output_text === 'string') text = data.output_text;
  if (citations.length === 0 && Array.isArray(data.citations)) citations.push(...data.citations);

  return { output_text: text, citations: [...new Set(citations)] };
}

// ============================================================================
// AWS Bedrock Guardrails (optional — input DLP + output injection scanning)
// ============================================================================

import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';

let bedrockClient: BedrockRuntimeClient | null = null;
let guardrailWarningLogged = false;

function getBedrockGuardrail(): { client: BedrockRuntimeClient; id: string; version: string } | null {
  const guardrailId = process.env.BEDROCK_GUARDRAIL_ID;
  if (!guardrailId) {
    if (!guardrailWarningLogged) {
      logger.warn('research', 'BEDROCK_GUARDRAIL_ID not set — research scanning disabled');
      guardrailWarningLogged = true;
    }
    return null;
  }

  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      ...(process.env.AWS_REGION && { region: process.env.AWS_REGION }),
    });
  }

  return {
    client: bedrockClient,
    id: guardrailId,
    version: process.env.BEDROCK_GUARDRAIL_VERSION || 'DRAFT',
  };
}

/**
 * Scan text via Bedrock Guardrails. Returns blocked status.
 * Fails open on errors — scanning is best-effort.
 */
async function scanWithGuardrail(
  text: string,
  source: 'INPUT' | 'OUTPUT',
): Promise<{ blocked: boolean; reason?: string }> {
  const guardrail = getBedrockGuardrail();
  if (!guardrail) return { blocked: false };

  try {
    const result = await guardrail.client.send(new ApplyGuardrailCommand({
      guardrailIdentifier: guardrail.id,
      guardrailVersion: guardrail.version,
      source,
      content: [{ text: { text } }],
    }));

    if (result.action === 'GUARDRAIL_INTERVENED') {
      const reason = result.actionReason || `${source} blocked by guardrail`;
      logger.warn('research', `Guardrail BLOCKED ${source}: ${reason}`);
      // Log detailed assessment info
      if (result.assessments) {
        for (const assessment of result.assessments) {
          if (assessment.contentPolicy?.filters?.length) {
            logger.warn('research', `  Content policy: ${JSON.stringify(assessment.contentPolicy.filters)}`);
          }
          if (assessment.sensitiveInformationPolicy?.piiEntities?.length) {
            logger.warn('research', `  PII detected: ${JSON.stringify(assessment.sensitiveInformationPolicy.piiEntities)}`);
          }
          if (assessment.sensitiveInformationPolicy?.regexes?.length) {
            logger.warn('research', `  Regex matches: ${JSON.stringify(assessment.sensitiveInformationPolicy.regexes)}`);
          }
        }
      }
      return { blocked: true, reason };
    }

    logger.agent('research', `Guardrail ${source} scan passed`);
    return { blocked: false };
  } catch (error) {
    const err = error as any;
    logger.warn('research', `Guardrail scan failed for ${source}, proceeding without scan`);
    logger.warn('research', `  Error: ${err.name || 'Unknown'}: ${err.message || String(error)}`);
    if (err.$metadata) {
      logger.warn('research', `  HTTP ${err.$metadata.httpStatusCode}, request: ${err.$metadata.requestId}`);
    }
    return { blocked: false };
  }
}

// ============================================================================
// Web Research Tool
// ============================================================================

function createWebResearchTool() {
  return tool(
    'web_research',
    'Research a topic using web search. Classifies query complexity and delegates to the appropriate search engine. Returns findings as markdown. Use for any task requiring up-to-date information from the internet.',
    {
      topic: z.string().describe('The topic to research'),
      context: z.string().optional().describe('Optional context about why this research is needed and what to focus on'),
    },
    async (args) => {
      // Check if Perplexity API is configured
      if (!process.env.PERPLEXITY_API_KEY) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Web research is not available: PERPLEXITY_API_KEY is not configured.',
            }),
          }],
          isError: true,
        };
      }

      // Per-task budgeting is enforced host-side by the PreToolUse guard
      // (METERED_TOOLS); by the time the handler runs, the call is within budget.
      // shortId is a console-log label only — persistence is keyed by the host
      // using the SDK tool_use_id (see ./hook.ts).
      const shortId = crypto.randomUUID().slice(0, 8);

      logger.agent(`research:${shortId}`, 'Starting research');
      logger.agent(`research:${shortId}`, `  Topic: ${args.topic}`);
      if (args.context) {
        logger.agent(`research:${shortId}`, `  Context: ${args.context}`);
      }

      try {
        // Step 1: Input scan — check for PII/secrets before sending externally
        const queryText = args.context ? `${args.topic}\n\n${args.context}` : args.topic;
        const inputScan = await scanWithGuardrail(queryText, 'INPUT');
        if (inputScan.blocked) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Research blocked: input contains sensitive data — ${inputScan.reason}`,
              }),
            }],
            isError: true,
          };
        }

        // Step 2: Classify preset
        const preset = await classifyPreset(args.topic, args.context);
        logger.agent(`research:${shortId}`, `  Preset: ${preset}`);

        // Step 3: Call Perplexity
        const input = args.context
          ? `${args.topic}\n\nContext: ${args.context}`
          : args.topic;

        const response = await callPerplexity(preset, input);
        logger.agent(`research:${shortId}`, `  Received ${response.output_text.length} chars, ${response.citations.length} citations`);

        // Step 4: Output scan — check for prompt injection in results
        const outputScan = await scanWithGuardrail(response.output_text, 'OUTPUT');
        if (outputScan.blocked) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Research blocked: output flagged for prompt injection — ${outputScan.reason}`,
              }),
            }],
            isError: true,
          };
        }

        // Step 5: Build markdown with sources
        let markdown = response.output_text;
        if (response.citations.length > 0) {
          markdown += '\n\n## Sources\n\n';
          markdown += response.citations.map((url, i) => `${i + 1}. ${url}`).join('\n');
        }

        // Step 6: Return raw result. Persistence + defensive wrapping are the
        // host's job — done in the PostToolUse hook (./hook.ts).
        const result = {
          content: markdown,
          source_urls: response.citations,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`research:${shortId}`, 'Research failed', error);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Research failed: ${message}`,
            }),
          }],
        };
      }
    }
  );
}

export function createResearchMcpServer() {
  return createSdkMcpServer({
    name: 'research-tools',
    version: '1.0.0',
    tools: [createWebResearchTool()],
  });
}
