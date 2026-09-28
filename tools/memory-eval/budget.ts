import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PRICING = {
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  checkedAt: '2026-09-26',
  models: {
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-sonnet-5': { input: 2, output: 10 },
  },
} as const;

export type ModelId = keyof typeof PRICING.models;
type Ledger = { capUsd: number; committedUsd: number; reservations: Array<{ label: string; reservedUsd: number; chargedUsd: number; status: string }> };

export function reserveEstimate(model: ModelId, inputBytes: number, maxOutputTokens: number, turns = 1): number {
  const price = PRICING.models[model];
  // UTF-8 bytes upper-bound the token count of supplied text. Add API/tool overhead.
  const inputTokens = Math.ceil(inputBytes * 1.1 + turns * 3_000);
  return Math.ceil(((inputTokens * price.input + turns * maxOutputTokens * price.output) / 1_000_000) * 10000) / 10000;
}

export class Budget {
  private ledger!: Ledger;
  constructor(private path: string, private capUsd: number) {}
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { this.ledger = JSON.parse(await readFile(this.path, 'utf8')) as Ledger; }
    catch { this.ledger = { capUsd: this.capUsd, committedUsd: 0, reservations: [] }; await this.save(); }
    if (this.ledger.capUsd !== this.capUsd) throw new Error(`budget cap mismatch: saved ${this.ledger.capUsd}, requested ${this.capUsd}`);
  }
  remaining(): number { return this.ledger.capUsd - this.ledger.committedUsd; }
  async reserve(label: string, usd: number): Promise<number> {
    if (!(usd > 0) || usd > this.remaining() + 1e-9) throw new Error(`budget stop: ${label} reserves $${usd.toFixed(4)}, $${this.remaining().toFixed(4)} remains`);
    const index = this.ledger.reservations.length;
    this.ledger.reservations.push({ label, reservedUsd: usd, chargedUsd: usd, status: 'reserved' });
    this.ledger.committedUsd += usd;
    await this.save();
    return index;
  }
  async settle(index: number, actualUsd: number | null, status: string): Promise<void> {
    const reservation = this.ledger.reservations[index];
    if (!reservation || reservation.status !== 'reserved') throw new Error('invalid reservation');
    const charged = actualUsd === null ? reservation.reservedUsd : Math.max(0, actualUsd);
    this.ledger.committedUsd += charged - reservation.chargedUsd;
    reservation.chargedUsd = charged;
    reservation.status = status;
    await this.save();
  }
  private async save(): Promise<void> { await writeFile(this.path, JSON.stringify(this.ledger, null, 2), { mode: 0o600 }); }
}
