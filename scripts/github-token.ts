#!/usr/bin/env npx tsx
/**
 * GitHub App Token Generator
 *
 * Outputs a GitHub App installation token for git CLI authentication.
 * Used by GIT_ASKPASS to provide credentials for git fetch/push.
 *
 * Required environment variables:
 * - GITHUB_APP_ID
 * - GITHUB_APP_PRIVATE_KEY_PATH
 * - GITHUB_INSTALLATION_ID
 */

import fs from 'fs';
import { createAppAuth } from '@octokit/auth-app';

async function main() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const installationId = process.env.GITHUB_INSTALLATION_ID;

  if (!appId || !privateKeyPath || !installationId) {
    process.stderr.write('Missing GitHub App configuration\n');
    process.exit(1);
  }

  let privateKey: string;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch {
    process.stderr.write(`Failed to read private key from ${privateKeyPath}\n`);
    process.exit(1);
  }

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId: parseInt(installationId, 10),
  });

  const { token } = await auth({ type: 'installation' });
  process.stdout.write(token);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});
