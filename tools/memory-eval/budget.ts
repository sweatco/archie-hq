import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
type Reservation = { label: string; reservedUsd: number; chargedUsd: number; status: string };
type Ledger = { capUsd: number; committedUsd: number; reservations: Reservation[] };

export function reserveEstimate(model: ModelId, inputBytes: number, maxOutputTokens: number, turns = 1): number {
  const price = PRICING.models[model];
  const inputTokens = Math.ceil(inputBytes * 1.1 + turns * 3_000);
  return Math.ceil(((inputTokens * price.input + turns * maxOutputTokens * price.output) / 1_000_000) * 10000) / 10000;
}

function validMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateLedger(value: unknown, capUsd: number): Ledger {
  if (!value || typeof value !== 'object') throw new Error('budget ledger is corrupt');
  const ledger = value as Partial<Ledger>;
  if (ledger.capUsd !== capUsd || !validMoney(ledger.committedUsd) || !Array.isArray(ledger.reservations)) {
    throw new Error('budget ledger cap or shape mismatch');
  }
  let total = 0;
  for (const reservation of ledger.reservations) {
    if (!reservation || typeof reservation.label !== 'string' || !reservation.label || typeof reservation.status !== 'string'
      || !reservation.status || !validMoney(reservation.reservedUsd) || !validMoney(reservation.chargedUsd)) {
      throw new Error('budget ledger reservation is corrupt');
    }
    if (reservation.status === 'reserved' && Math.abs(reservation.chargedUsd - reservation.reservedUsd) > 1e-8) {
      throw new Error('budget ledger has an undercharged uncertain reservation');
    }
    total += reservation.chargedUsd;
  }
  if (Math.abs(total - ledger.committedUsd) > 1e-6) throw new Error('budget ledger total is corrupt');
  return ledger as Ledger;
}

export class Budget {
  private ledger!: Ledger;
  constructor(private path: string, private capUsd: number) {}

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try { return await operation(); }
        finally { await rm(lock, { recursive: true, force: true }); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error(`budget ledger locked: ${this.path}`);
  }

  private async read(): Promise<Ledger> {
    try { return validateLedger(JSON.parse(await readFile(this.path, 'utf8')), this.capUsd); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial: Ledger = { capUsd: this.capUsd, committedUsd: 0, reservations: [] };
      await this.save(initial);
      return initial;
    }
  }

  private async save(ledger: Ledger): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  async open(): Promise<void> {
    await this.locked(async () => { this.ledger = await this.read(); });
  }

  remaining(): number { return this.ledger.capUsd - this.ledger.committedUsd; }

  async reserve(label: string, usd: number): Promise<number> {
    if (!validMoney(usd) || usd === 0) throw new Error('invalid budget reservation');
    return this.locked(async () => {
      const ledger = await this.read();
      const remaining = ledger.capUsd - ledger.committedUsd;
      if (usd > remaining + 1e-9) throw new Error(`budget stop: ${label} reserves $${usd.toFixed(4)}, $${remaining.toFixed(4)} remains`);
      const index = ledger.reservations.length;
      ledger.reservations.push({ label, reservedUsd: usd, chargedUsd: usd, status: 'reserved' });
      ledger.committedUsd += usd;
      await this.save(ledger);
      this.ledger = ledger;
      return index;
    });
  }

  async settle(index: number, actualUsd: number | null, status: string): Promise<void> {
    if (actualUsd !== null && !validMoney(actualUsd)) throw new Error('invalid actual charge');
    await this.locked(async () => {
      const ledger = await this.read();
      const reservation = ledger.reservations[index];
      if (!reservation || reservation.status !== 'reserved') throw new Error('invalid reservation');
      const charged = actualUsd === null ? reservation.reservedUsd : actualUsd;
      ledger.committedUsd += charged - reservation.chargedUsd;
      reservation.chargedUsd = charged;
      reservation.status = status;
      await this.save(ledger);
      this.ledger = ledger;
    });
  }
}
