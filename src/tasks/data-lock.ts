import { createKeyedLock } from '../system/keyed-lock.js';

const taskDataLock = createKeyedLock();

/** Serialize a task's visibility metadata and knowledge-log boundary. */
export function withTaskDataLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
  return taskDataLock(taskId, action);
}
