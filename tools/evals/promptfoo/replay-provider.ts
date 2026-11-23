/**
 * promptfoo provider that replays a finished task instead of calling a model:
 * the test's `taskDir` var names a task folder, and the response is built from
 * its session record. Relative paths resolve against the working directory,
 * which run.ts sets to the config file's directory.
 */

import { resolve } from 'path';
import { buildSessionRecord, type SessionRecord } from '../session-record.js';
import { buildRecordResponse, type RecordResponse } from './record-response.js';

interface ProviderOptions {
  id?: string;
  config?: { source?: SessionRecord['source'] };
}

interface CallApiContext {
  vars?: Record<string, unknown>;
}

export default class ReplayProvider {
  private readonly providerId: string;
  private readonly source: SessionRecord['source'];

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? 'archie-replay';
    this.source = options.config?.source ?? 'production';
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context?: CallApiContext): Promise<RecordResponse> {
    const taskDir = context?.vars?.taskDir;
    if (typeof taskDir !== 'string' || !taskDir) {
      return { error: 'the test needs a taskDir var naming a task folder' };
    }
    return buildRecordResponse(await buildSessionRecord(resolve(taskDir), this.source));
  }
}
