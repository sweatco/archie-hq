// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Incoming events inside the Archie process: the inbox, the public callback route and the
 * dispatcher, all behind `ARCHIE_INCOMING_EVENTS`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, Request, Response } from 'express';

import { logger } from '../system/logger.js';
import { validateMasterKey } from '../system/secrets-vault.js';
import { INCOMING_DIR, INCOMING_SECRETS_DIR } from '../system/workdir.js';
import { IncomingDispatcher } from './dispatcher.js';
import { INCOMING_ROUTE, mountIncomingReceiver } from './receiver.js';
import { vaultInputSecrets, type InputSecrets } from './secrets.js';
import { IncomingStore } from './store.js';
import type { IncomingConsumer } from './types.js';

/** Shutdown waits this long for a handoff attempt in flight, then closes the inbox under it. */
const STOP_WAIT_MS = 5000;

export interface IncomingEvents {
  /** Starts handing deliveries to consumers. Call after Task recovery. */
  start(): void;
  close(): Promise<void>;
}

/** A blank value counts as unset, which is off. Any other unknown value is an error. */
export function incomingEventsEnabled(): boolean {
  const mode = (process.env.ARCHIE_INCOMING_EVENTS ?? '').trim().toLowerCase() || 'off';
  if (mode !== 'off' && mode !== 'on')
    throw new Error('ARCHIE_INCOMING_EVENTS must be "off" or "on"');
  return mode === 'on';
}

/**
 * Throws on an unknown flag value, or on a missing vault key while the feature is on. These are
 * configuration errors and stop the boot; startup calls this before its slow steps.
 */
export function validateIncomingEventsConfig(): void {
  if (incomingEventsEnabled()) validateMasterKey();
}

/** The daemon and the operator CLI open the same file. */
export function openIncomingStore(): IncomingStore {
  // Owner only: the database holds webhook bodies while they wait for handoff.
  mkdirSync(INCOMING_DIR, { recursive: true, mode: 0o700 });
  return new IncomingStore(join(INCOMING_DIR, 'state.sqlite'));
}

export function incomingSecrets(): InputSecrets {
  return vaultInputSecrets(INCOMING_SECRETS_DIR);
}

/**
 * Mounts the callback route when the feature is on. Returns null when it is off, or when the
 * inbox cannot be opened. Throws on the configuration errors `validateIncomingEventsConfig` names.
 */
export function mountIncomingEvents(
  app: Application,
  consumers: readonly IncomingConsumer[] = [],
): IncomingEvents | null {
  validateIncomingEventsConfig();
  if (!incomingEventsEnabled()) return null;

  let store: IncomingStore;
  try {
    store = openIncomingStore();
    // Created here so it belongs to the daemon's user, whoever runs the operator CLI later.
    mkdirSync(INCOMING_SECRETS_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    // A sender retries a 503. With no route it would get a 404 and give up.
    logger.error('incoming', 'Incoming events inbox cannot be opened; deliveries get 503', error);
    app.post(INCOMING_ROUTE, (_req: Request, res: Response) => {
      res.status(503).json({ error: 'unavailable' });
    });
    return null;
  }

  mountIncomingReceiver(app, { store, secrets: incomingSecrets(), consumers });
  const dispatcher = new IncomingDispatcher(store, consumers);
  return {
    start: () => dispatcher.start(),
    async close() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waitedLongEnough = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      });
      await Promise.race([dispatcher.stop(), waitedLongEnough]);
      clearTimeout(timer);
      store.close();
    },
  };
}
