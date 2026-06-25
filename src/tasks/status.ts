/**
 * Task status controller — composes the single first-person "Archie is …" line
 * shown while a task is working. The line is surface-agnostic: the same string
 * is rendered to Slack (assistant-thread status), the CLI (live indicator), and
 * the logs. This module owns the *composition*; renderers live elsewhere.
 *
 * It tracks which agents are active and what each is currently doing (fed from
 * the SDK tool-call stream and the agent active/idle transitions) and renders
 * ONE status string from the whole team, following these rules:
 *
 *   • The PM is the persona. When the PM is active it speaks — even if a
 *     specialist is also working — because the PM is doing the user-facing
 *     coordination/synthesis. (In practice the PM goes idle after delegating, so
 *     specialists naturally show through during delegation and the PM returns
 *     when it wakes to wrap up.)
 *   • Exactly one specialist active → that specialist's specific action.
 *   • Several specialists active → an aggregate of their domains
 *     ("checking mobile and backend…"), never naming any of them.
 *
 * Output is the fragment after the app name (Slack prepends "Archie"), composed
 * as "is <fragment>…". Pushes are debounced and de-duplicated so we never spam
 * Slack or flicker the indicator between turns.
 */

import { logger } from '../system/logger.js';

/**
 * Master gate for the live status indicator (all surfaces — CLI, logs, Slack).
 * Default on; set ARCHIE_LIVE_STATUS=false to disable.
 */
export function isStatusEnabled(): boolean {
  return process.env.ARCHIE_LIVE_STATUS !== 'false';
}

interface AgentEntry {
  isPm: boolean;
  domain: string;
  active: boolean;
  /** The specialist's current specific action, e.g. "digging into the backend". */
  phrase?: string;
}

const DEBOUNCE_MS = 800;

export class TaskStatusController {
  private readonly agents = new Map<string, AgentEntry>();
  /** Last fragment pushed to Slack ('' means cleared / nothing shown). */
  private current = '';
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  /** `push('')` clears the indicator; `push('is …')` sets it. */
  constructor(private readonly push: (status: string) => void) {}

  /** An agent's turn started. */
  setActive(agentId: string, isPm: boolean, domain: string): void {
    const e = this.entry(agentId, isPm, domain);
    e.active = true;
    this.schedule();
  }

  /** An agent's turn ended — it is no longer doing anything. */
  setIdle(agentId: string): void {
    const e = this.agents.get(agentId);
    if (e) {
      e.active = false;
      e.phrase = undefined;
    }
    this.schedule();
  }

  /** Record what an agent is doing right now, derived from a tool call. */
  note(agentId: string, isPm: boolean, domain: string, phrase: string): void {
    const e = this.entry(agentId, isPm, domain);
    e.active = true;
    e.phrase = phrase;
    this.schedule();
  }

  /**
   * The PM just posted a message to the user. Slack auto-clears the loading
   * indicator when the app posts into the thread, so forget what we believe is
   * shown; the next render re-pushes if work continues. Does NOT wipe any
   * agent's activity — a specialist still working will show through again.
   */
  notePosted(): void {
    this.current = '';
    this.schedule();
  }

  /** Blank the indicator for good — task parked / stopped / done. */
  clear(): void {
    this.agents.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.current !== '') {
      this.current = '';
      this.safePush('');
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private entry(agentId: string, isPm: boolean, domain: string): AgentEntry {
    let e = this.agents.get(agentId);
    if (!e) {
      e = { isPm, domain, active: false };
      this.agents.set(agentId, e);
    } else {
      e.isPm = isPm;
      e.domain = domain;
    }
    return e;
  }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, DEBOUNCE_MS);
  }

  private flush(): void {
    const next = this.render();
    if (next === null) return; // keep whatever is shown (handoff between turns)
    if (next === this.current) return; // no change
    this.current = next;
    this.safePush(next);
  }

  private safePush(status: string): void {
    try {
      this.push(status);
    } catch (err) {
      logger.warn('task-status', `status push failed: ${err}`);
    }
  }

  /**
   * Compose the status fragment, or null to mean "leave the current indicator
   * untouched". Null (rather than clearing) during the brief window where no
   * agent is active avoids a flicker between the PM delegating and a specialist
   * picking the work up — the indicator is only truly cleared by clear().
   */
  private render(): string | null {
    const active = [...this.agents.values()].filter((a) => a.active);
    if (active.length === 0) return null;

    const pm = active.find((a) => a.isPm);
    if (pm) return compose(pm.phrase ?? 'working on this');

    const subs = active.filter((a) => !a.isPm);
    if (subs.length === 1) {
      const only = subs[0];
      return compose(only.phrase ?? `working on ${place(only.domain)}`);
    }

    // Several specialists in parallel — aggregate their domains, never name them.
    const domains = dedupeDomains(subs.map((s) => s.domain));
    return compose(domains.length ? `checking ${joinList(domains)}` : 'working on a few things');
  }
}

function compose(fragment: string): string {
  return `is ${fragment}…`;
}

function place(domain: string): string {
  return domain ? `the ${domain}` : 'this';
}

function dedupeDomains(domains: string[]): string[] {
  const out: string[] = [];
  for (const d of domains) {
    const t = (d ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
