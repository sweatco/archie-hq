import Anthropic from '@anthropic-ai/sdk';
import { Budget, PRICING, reserveEstimate } from './budget.js';
import type { Corpus } from './schema.js';

type Draft = { id: string; question: string; required: string[]; forbidden: string[]; ability: string };

export async function draftRealLabels(corpus: Corpus, ledgerPath: string): Promise<{ drafted: number; failures: string[] }> {
  const client = new Anthropic();
  const budget = new Budget(ledgerPath, 100); await budget.open();
  let drafted = 0;
  const failures: string[] = [];
  for (const history of corpus.histories.filter((h) => h.source === 'archie')) {
    const cases = corpus.cases.filter((c) => c.historyId === history.id);
    if (cases.every((c) => c.reason?.startsWith('Model-drafted'))) continue;
    const evidence = cases.map((c) => {
      const span = c.evidence[0];
      const event = history.events.find((e) => e.source.ref === span.ref && e.source.start === span.start);
      return { id: c.id, queryAt: c.queryAt, messageAt: event?.at, message: event?.text.slice(0, 4000) };
    });
    const prompt = `Draft four precise memory-evaluation questions from these original requester messages. Each case must ask about a specific fact, instruction, decision, or unresolved point actually in its own cited message. Keep current and historical decisions distinct. If a message cannot support a clear case, return empty required claims and explain uncertainty in the question. Do not use an assistant assertion as fact. Do not assume an external document or live state is available. Return only JSON array of four objects with id, question, required (short atomic claims), forbidden (specific misleading claims), ability. IDs must match exactly.\n\n${JSON.stringify(evidence)}`;
    const reserved = reserveEstimate('claude-sonnet-5', Buffer.byteLength(prompt), 4096);
    let index: number;
    try { index = await budget.reserve(`label:${history.id}`, reserved); }
    catch (error) { failures.push(`${history.id}: ${String(error)}`); break; }
    try {
      const response = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 4096,
        system: 'You write evidence-linked evaluation drafts for a human reviewer. Be literal and conservative.',
        messages: [{ role: 'user', content: prompt }] });
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const rows = JSON.parse(text) as Draft[];
      if (!Array.isArray(rows) || rows.length !== cases.length || rows.some((r, i) => r.id !== cases[i].id || typeof r.question !== 'string' || !Array.isArray(r.required) || !Array.isArray(r.forbidden))) {
        throw new Error('draft response shape/IDs invalid');
      }
      const cost = (response.usage.input_tokens * PRICING.models['claude-sonnet-5'].input + response.usage.output_tokens * PRICING.models['claude-sonnet-5'].output) / 1_000_000;
      await budget.settle(index, cost, 'ok');
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i], r = rows[i];
        c.question = r.question.trim();
        c.required = r.required.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
        c.forbidden = r.forbidden.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
        c.ability = r.ability || c.ability;
        c.reason = 'Model-drafted from cited original requester message; human review required before gating.';
        drafted++;
      }
    } catch (error) {
      await budget.settle(index, null, 'error');
      failures.push(`${history.id}: ${String(error)}`);
    }
  }
  return { drafted, failures };
}
