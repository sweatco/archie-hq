// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, Request, Response } from 'express';

import { logger } from '../system/logger.js';
import { validateMasterKey } from '../system/secrets-vault.js';
import { INCOMING_DIR, INCOMING_SECRETS_DIR } from '../system/workdir.js';
import { setInputServices, setOpenInbox } from './access.js';
import { IncomingDispatcher } from './dispatcher.js';
import { answerIncomingRouteErrors, INCOMING_ROUTE, mountIncomingReceiver } from './receiver.js';
import { vaultInputSecrets, type InputSecrets } from './secrets.js';
import { IncomingStore } from './store.js';
import type { IncomingConsumer } from './types.js';

const SHUTDOWN_GRACE_MS = 5000;

export interface IncomingEvents {
  /** Call after Task recovery: it starts handing deliveries to consumers. */
  start(): void;
  close(): Promise<void>;
}

export function incomingEventsEnabled(): boolean {
  const mode = (process.env.ARCHIE_INCOMING_EVENTS ?? '').trim().toLowerCase() || 'off';
  if (mode !== 'off' && mode !== 'on')
    throw new Error('ARCHIE_INCOMING_EVENTS must be "off" or "on"');
  return mode === 'on';
}

/** Configuration errors stop the boot; startup runs this before its slow steps. */
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

/** Returns null when the feature is off or the inbox is unavailable. */
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
    // Senders retry a 503, which keeps their events alive until the inbox is back.
    logger.error(
      'incoming',
      'Incoming events inbox cannot be opened; deliveries get 503 and tasks that events started cannot post',
      error,
    );
    app.post(INCOMING_ROUTE, (_req: Request, res: Response) => {
      res.status(503).json({ error: 'unavailable' });
    });
    answerIncomingRouteErrors(app);
    return null;
  }

  const secrets = incomingSecrets();
  setOpenInbox(store);
  setInputServices({ store, secrets });
  mountIncomingReceiver(app, { store, secrets, consumers });
  const dispatcher = new IncomingDispatcher(store, consumers);
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitedLongEnough = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    });
    await Promise.race([dispatcher.stop(), waitedLongEnough]);
    clearTimeout(timer);
    setOpenInbox(null);
    setInputServices(null);
    store.close();
  };
  // A second shutdown signal asks again, and the database throws on a second close.
  let closing: Promise<void> | undefined;
  return {
    start: () => dispatcher.start(),
    close: () => (closing ??= close()),
  };
}
