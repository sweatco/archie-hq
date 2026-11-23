/**
 * Turns the configured personas into Slack clients, and is the one place a token is checked
 * against the workspace and member it is supposed to belong to.
 */

import { WebClient } from '@slack/web-api';
import { checkTokenIdentity, type Persona, type PersonaConfig } from './config.js';
import { readSecret, type SecretSources } from './secrets.js';

/** What `auth.test` reports for a token; every Slack client can answer it. */
export interface IdentifiableSlack {
  auth: { test(): Promise<{ team_id?: string; user_id?: string }> };
}

export interface ActingPersona<Client> {
  persona: Persona;
  slack: Client;
}

export function createSlackClient(token: string): WebClient {
  return new WebClient(token, { timeout: 15_000, retryConfig: { retries: 1 } });
}

/**
 * Build a client per persona. Throws on the first token that belongs to another workspace or
 * member, so no caller can act before every identity has been confirmed.
 */
export async function connectPersonas<Client extends IdentifiableSlack>(
  config: PersonaConfig,
  secrets: SecretSources,
  createClient: (token: string) => Client,
): Promise<Array<ActingPersona<Client>>> {
  const acting: Array<ActingPersona<Client>> = [];
  for (const persona of config.personas) {
    const slack = createClient(await readSecret(persona.token, secrets));
    const identity = await slack.auth.test();
    const check = checkTokenIdentity(
      { teamId: identity.team_id, userId: identity.user_id },
      { teamId: config.teamId, persona },
    );
    if (!check.ok) throw new Error(check.detail);
    acting.push({ persona, slack });
  }
  return acting;
}
