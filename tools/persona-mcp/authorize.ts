/**
 * Authorize the persona app as one test member and store that member's user token.
 *
 *   npx tsx tools/persona-mcp/authorize.ts <persona-key>
 *
 * The member approves in a browser; this command exchanges the resulting code and writes the
 * token straight to 1Password or the Keychain, whichever the persona's reference names. The
 * token is never printed, so it never reaches a terminal log or a chat.
 */

import { randomBytes } from 'crypto';
import { createInterface } from 'readline/promises';
import { findPersona } from './config.js';
import { loadPersonaConfig } from './load-config.js';
import {
  buildAuthorizeUrl,
  checkGrant,
  exchangeAuthorizationCode,
  readAuthorizationCode,
} from './oauth-grant.js';
import { readSecret, runCommand, storeSecret } from './secrets.js';

async function main(): Promise<void> {
  const personaKey = process.argv[2];
  if (!personaKey) throw new Error('usage: npx tsx tools/persona-mcp/authorize.ts <persona-key>');
  const config = loadPersonaConfig();
  const persona = findPersona(config, personaKey);
  const state = randomBytes(16).toString('hex');

  console.log(`Authorizing "${persona.key}" in the ${config.environment} workspace.\n`);
  console.log('1. Open this URL in a browser signed in to Slack as that member, and approve:\n');
  console.log(`   ${buildAuthorizeUrl(config, state)}\n`);
  console.log('2. The browser then lands on a page that may not load. Copy its whole address.\n');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const redirectedUrl = await terminal.question('Paste the address here: ');
  terminal.close();
  const code = readAuthorizationCode(redirectedUrl, state);

  const clientSecret = await readSecret(config.personaApp.clientSecret, {
    env: process.env,
    run: runCommand,
  });
  const response = await exchangeAuthorizationCode(config.personaApp, clientSecret, code);
  const grant = checkGrant(response, { teamId: config.teamId, persona });
  if (!grant.ok) throw new Error(grant.detail);

  await storeSecret(persona.token, grant.token, runCommand);
  console.log(`\nStored the token for "${persona.key}" as ${persona.token}.`);
  if (grant.missingScopes.length > 0) {
    console.log(`Not granted, so some actions will fail: ${grant.missingScopes.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(`authorize: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
