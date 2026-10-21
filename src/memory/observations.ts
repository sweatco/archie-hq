// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';

export interface ObservationMemory {
  search(metadata: TaskMetadata, query: string, limit: number): Promise<Array<{ id: string; text: string; recency: string }>>;
  read(metadata: TaskMetadata, kind: 'observation' | 'matter' | 'matters', id?: string): Promise<unknown>;
}

let backend: ObservationMemory | undefined;

export function installObservationMemory(memory: ObservationMemory | undefined): void { backend = memory; }
export function hasObservationMemory(): boolean { return !!backend; }
export function searchObservations(metadata: TaskMetadata, query: string, limit: number) {
  return backend?.search(metadata, query, limit) ?? Promise.resolve([]);
}
export function readObservation(metadata: TaskMetadata, kind: 'observation' | 'matter' | 'matters', id?: string) {
  return backend?.read(metadata, kind, id) ?? Promise.resolve('Observation memory unavailable.');
}
