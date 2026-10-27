// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from 'zod';
import type { SessionInput } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class Cassette {
  private turn = -1;
  private position = 0;
  private consumed = 0;
  private errors: string[] = [];
  constructor(private turns: z.infer<typeof SessionInput>['turns']) {}
  next() {
    if (this.turn === this.turns.length) return null;
    if (this.turn >= 0 && this.position !== this.turns[this.turn].tools.length) this.errors.push('unconsumed-recordings');
    if (this.errors.length) return null;
    this.turn++; this.position = 0;
    const turn = this.turns[this.turn];
    return turn ? { at: turn.at, sender: turn.sender, message: turn.message } : null;
  }
  call(name: string, input: unknown) {
    const expected = this.turns[this.turn]?.tools[this.position];
    const error = !expected ? 'missing-recording' : expected.name !== name ? 'tool-order-divergence'
      : canonical(expected.input) !== canonical(input) ? 'tool-arguments-divergence' : null;
    if (error || this.errors.length) {
      if (error) this.errors.push(error);
      return { content: [{ type: 'text' as const, text: 'Replay recording unavailable; stop this task.' }], isError: true };
    }
    this.position++; this.consumed++;
    return expected.output;
  }
  summary() {
    return { expected: this.turns.reduce((n, turn) => n + turn.tools.length, 0), consumed: this.consumed,
      complete: this.turn === this.turns.length && this.errors.length === 0, errors: [...this.errors] };
  }
}
