/**
 * Task status controller — composes the single first-person "Archie is …" line
 * shown while a task is working. The line is surface-agnostic: the same string
 * is rendered to Slack (assistant-thread status) and the CLI (live indicator).
 * This module owns the *composition*; renderers live elsewhere.
 *
 * A task runs one agent, the PM, so there is nothing to arbitrate: the line is
 * whatever the PM is currently doing (fed from the SDK tool-call stream and the
 * active/idle transitions), or a generic "working on this" when it is active
 * with no surfaced tool call. Work the PM delegates surfaces as the PM's own
 * activity — the single persona never reveals a worker.
 *
 * Output is the fragment after the app name (Slack prepends "Archie"), composed
 * as "is <fragment>…". Pushes are debounced and de-duplicated so we never spam
 * Slack or flicker the indicator between turns, and a keepalive re-asserts the
 * current status on an interval so it survives Slack's ~2-minute timeout during
 * long, quiet tool calls (e.g. research).
 */

import { logger } from '../system/logger.js';

/**
 * Master gate for the live status indicator (all surfaces — CLI, logs, Slack).
 * Default on; set ARCHIE_LIVE_STATUS=false to disable.
 */
export function isStatusEnabled(): boolean {
  return process.env.ARCHIE_LIVE_STATUS !== 'false';
}

const DEBOUNCE_MS = 800;
/**
 * Slack auto-clears a status after ~2 minutes if nothing refreshes it. A
 * long-running tool (e.g. web_research) emits no intervening tool calls, so the
 * status would silently vanish mid-work. Re-assert it on this interval to reset
 * Slack's timer — comfortably under the ~120s timeout.
 */
const KEEPALIVE_MS = 90_000;

export class TaskStatusController {
  private active = false;
  /** The current specific action, e.g. "researching". */
  private phrase?: string;
  /** Last fragment pushed to Slack ('' means cleared / nothing shown). */
  private current = '';
  private timer?: ReturnType<typeof setTimeout>;
  private keepalive?: ReturnType<typeof setInterval>;
  private suspended = false;
  private disposed = false;

  /** `push('')` clears the indicator; `push('is …')` sets it. */
  constructor(private readonly push: (status: string) => void) {}

  /** The agent's turn started. */
  setActive(): void {
    this.active = true;
    this.schedule();
  }

  /** The agent's turn ended — it is no longer doing anything. */
  setIdle(): void {
    this.active = false;
    this.phrase = undefined;
    this.schedule();
  }

  /** Record what the agent is doing right now, derived from a tool call. */
  note(phrase: string): void {
    this.active = true;
    this.phrase = phrase;
    this.schedule();
  }

  /**
   * The PM just posted a message to the user. Slack auto-clears the loading
   * indicator when the app posts into the thread, so forget what we believe is
   * shown; the next render re-pushes if work continues. Does NOT wipe the
   * current activity — ongoing work shows through again.
   */
  notePosted(): void {
    this.current = '';
    this.schedule();
  }

  /** Blank the indicator for good — task parked / stopped / done. */
  clear(): void {
    this.active = false;
    this.phrase = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopKeepalive();
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
    this.stopKeepalive();
  }

  /**
   * Freeze the indicator for the rest of this turn's wind-down. Called when the
   * agent has decided to finish or pause the task (report_completion, edit-mode
   * request, research-budget stop): the real teardown's clear() is deferred to
   * turn-end, but trailing tool calls in that window would otherwise resurface
   * the status a couple of seconds after the final message. Blank it now and
   * ignore further activity until the controller is cleared/disposed.
   */
  suspend(): void {
    this.suspended = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopKeepalive();
    this.active = false;
    this.phrase = undefined;
    if (this.current !== '') {
      this.current = '';
      this.safePush('');
    }
  }

  /**
   * Keep the current status alive against Slack's ~2-minute timeout by
   * re-asserting it on an interval — so a long-running tool that emits no new
   * activity doesn't lose the indicator. Self-stops once nothing is shown.
   */
  private armKeepalive(): void {
    if (this.disposed || this.keepalive) return;
    this.keepalive = setInterval(() => {
      if (this.current) this.safePush(this.current);
      else this.stopKeepalive();
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
  }

  private schedule(): void {
    if (this.disposed || this.suspended || this.timer) return;
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
    this.armKeepalive(); // keep it alive through long, quiet tool calls
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
   * untouched". Null (rather than clearing) while the agent is idle avoids a
   * flicker in the gap between turns — the indicator is only truly cleared by
   * clear() / suspend().
   */
  private render(): string | null {
    if (!this.active) return null;
    return compose(this.phrase ?? 'working on this');
  }
}

function compose(fragment: string): string {
  return `is ${fragment}…`;
}

