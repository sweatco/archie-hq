# Proposal: Full LLM Guard Integration

> **Superseded option — filing review 2026-11-11.** Retain the rejected/trialed alternative and its rationale. Current source supports optional Bedrock scanning; that does not establish provider configuration or production effectiveness. Current contract: [Web research](../architecture/web-research.md).

> **Status:** Previously trialed and removed; superseded in production by AWS Bedrock Guardrails. Retained as a reference design in case a self-hosted DLP layer is revisited.

## Summary

Deploy LLM Guard as a self-hosted Docker service to provide DLP (Data Loss Prevention) scanning at three interception points in the research pipeline.

## Current State

The prompt injection defense architecture (implemented in v9) includes five defense layers. Layer 2 (content/DLP scanning) is currently filled by AWS Bedrock Guardrails, not LLM Guard:

- **Implemented:** Sandwich defense hooks, structured JSON output schema, research budgets, defense tagging, AWS Bedrock Guardrails scanning of research input/output (see `scanWithGuardrail` in `src/mcp/research-tools.ts`)
- **Not implemented:** LLM Guard Docker service, DLP scanner profiles, automated LLM-Guard scanning at the three interception points described below
- **Previously implemented and removed:** An earlier LLM Guard integration was wired in and later removed (too heavy, pattern matching judged unreliable for prompt-injection detection — see `docs/architecture/security.md` "What Is NOT Yet Implemented")

The research pipeline in `src/mcp/research-tools.ts` already calls a guardrail-style scanner on input and output; swapping or augmenting that with LLM Guard would reuse the same call sites.

## Design

### Three Interception Points

1. **Point A — Outbound query scanning** (`PreToolUse` on WebSearch): Detect API keys, PII, encoded data being smuggled out in search queries
2. **Point B — Outbound URL scanning** (`PreToolUse` on WebFetch): Detect exfiltrated data in URL paths and query parameters
3. **Point C — Inbound content sanitization** (`PostToolUse` on WebSearch/WebFetch): Strip zero-width characters, block known injection patterns

### Scanner Profiles

| Point | Scanners | Purpose |
|-------|----------|---------|
| A (outbound query) | Secrets, Anonymize, InvisibleText, Regex, Gibberish, TokenLimit | Catch encoded exfiltration |
| B (outbound URL) | Secrets, Anonymize, InvisibleText, Regex | Catch data in URLs |
| C (inbound content) | InvisibleText, BanSubstrings | Strip hidden instructions |

### Deployment

LLM Guard runs as a Docker Compose service alongside the main application:

```yaml
services:
  llm-guard:
    image: protectai/llm-guard-api:latest
    ports:
      - "8000:8000"
    volumes:
      - ./llm-guard-config:/app/config
```

### Fail-Open Behavior

If LLM Guard is unavailable, scanning is skipped (fail-open). The other defense layers (sandwich defense, structured output, budgets) continue to provide protection.

## When to Build

Deploy when:
- Observability (Defense 5) reveals injection attempts getting through research summaries
- The system handles sensitive data that justifies the infrastructure overhead
- Research volume increases beyond what manual review can cover

## Related

- [Architecture: Security](../architecture/security.md) — current defense layers
- [Plans: v9](../plans/v9-prompt-injection-defense.md) — full defense design
- Meta Prompt Guard 2 (86M parameter BERT model) is another option for content pre-screening
