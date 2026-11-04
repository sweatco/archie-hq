// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';

export interface ObservationAPI {
  search(metadata: TaskMetadata, query: string, limit: number): Promise<Array<{ id: string; text: string }>>;
  read(metadata: TaskMetadata, kind: 'observation' | 'matter' | 'matters', id?: string): Promise<unknown>;
}

let backend: ObservationAPI | undefined;
const pendingReads = new Set<Promise<unknown>>();

async function reading<T>(work: () => Promise<T>): Promise<T> {
  const pending = work();
  pendingReads.add(pending);
  try { return await pending; } finally { pendingReads.delete(pending); }
}

export function installObservationAPI(api: ObservationAPI | undefined): void { backend = api; }
export function hasObservationAPI(): boolean { return !!backend; }
export async function drainObservationReads(): Promise<void> { await Promise.allSettled(pendingReads); }
export function searchObservations(metadata: TaskMetadata, query: string, limit: number) {
  const api = backend;
  return api ? reading(() => api.search(metadata, query, limit)) : Promise.resolve([]);
}
export function readObservation(metadata: TaskMetadata, kind: 'observation' | 'matter' | 'matters', id?: string) {
  const api = backend;
  return api ? reading(() => api.read(metadata, kind, id)) : Promise.resolve('Observation service unavailable.');
}
