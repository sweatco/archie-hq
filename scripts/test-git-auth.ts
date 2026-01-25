#!/usr/bin/env npx tsx
/**
 * Test script for git authentication and worktree operations
 *
 * Tests:
 * 1. GIT_ASKPASS token generation
 * 2. git fetch for both repos
 * 3. worktree creation (dry run)
 *
 * Usage: npx tsx scripts/test-git-auth.ts
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// Colors for output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`  ${name}... `);

  try {
    const message = await fn();
    const duration = Date.now() - start;
    results.push({ name, success: true, message, duration });
    console.log(green('✓'), dim(`(${duration}ms)`));
    if (message) console.log(dim(`    ${message}`));
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, success: false, message, duration });
    console.log(red('✗'), dim(`(${duration}ms)`));
    console.log(red(`    ${message}`));
  }
}

async function checkEnvVars(): Promise<string> {
  const required = [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_INSTALLATION_ID',
    'GIT_ASKPASS'
  ];

  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }

  return `All required env vars present`;
}

async function checkPrivateKey(): Promise<string> {
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH!;
  try {
    const stat = await fs.stat(keyPath);
    return `Key file exists (${stat.size} bytes)`;
  } catch {
    throw new Error(`Private key not found at ${keyPath}`);
  }
}

async function checkGitAskpass(): Promise<string> {
  const askpassPath = process.env.GIT_ASKPASS!;
  try {
    await fs.access(askpassPath, fs.constants.X_OK);
    return `GIT_ASKPASS executable at ${askpassPath}`;
  } catch {
    throw new Error(`GIT_ASKPASS not executable: ${askpassPath}`);
  }
}

async function testTokenGeneration(): Promise<string> {
  // Simulate what GIT_ASKPASS does for password prompt
  const askpassPath = process.env.GIT_ASKPASS!;

  try {
    const { stdout } = await execAsync(`"${askpassPath}" "Password for 'https://github.com':"`, {
      timeout: 30000,
    });
    const token = stdout.trim();

    if (!token) {
      throw new Error('Empty token returned');
    }
    if (!token.startsWith('ghs_')) {
      throw new Error(`Token doesn't look like GitHub installation token: ${token.substring(0, 10)}...`);
    }

    return `Token generated: ${token.substring(0, 10)}...${token.substring(token.length - 4)}`;
  } catch (error: any) {
    if (error.stderr) {
      throw new Error(`Token generation failed: ${error.stderr}`);
    }
    throw error;
  }
}

async function getRemoteUrl(repoPath: string): Promise<string> {
  const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
  return stdout.trim();
}

async function testRemoteUrl(repoPath: string): Promise<string> {
  const url = await getRemoteUrl(repoPath);

  if (url.startsWith('git@')) {
    throw new Error(`SSH URL detected: ${url}\n    GIT_ASKPASS only works with HTTPS URLs.\n    Fix: git remote set-url origin https://github.com/OWNER/REPO.git`);
  }

  if (!url.startsWith('https://')) {
    throw new Error(`Unknown URL format: ${url}`);
  }

  return `HTTPS URL: ${url}`;
}

async function testFetch(repoPath: string, branch: string): Promise<string> {
  try {
    // First check if repo exists
    await fs.access(repoPath);
  } catch {
    throw new Error(`Repo not found at ${repoPath}`);
  }

  // Check remote URL format
  const url = await getRemoteUrl(repoPath);
  if (url.startsWith('git@')) {
    throw new Error(`SSH URL detected: ${url} - GIT_ASKPASS requires HTTPS`);
  }

  try {
    const { stdout, stderr } = await execAsync(`git fetch origin ${branch}`, {
      cwd: repoPath,
      timeout: 60000,
    });

    // Check if we got the branch
    const { stdout: refCheck } = await execAsync(`git rev-parse origin/${branch}`, {
      cwd: repoPath,
    });

    return `Fetched origin/${branch} (${refCheck.trim().substring(0, 7)})`;
  } catch (error: any) {
    const stderr = error.stderr || error.message;
    throw new Error(`Fetch failed: ${stderr}`);
  }
}

async function testWorktreeList(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git worktree list', { cwd: repoPath });
    const lines = stdout.trim().split('\n');
    return `${lines.length} worktree(s) found`;
  } catch (error: any) {
    throw new Error(`Worktree list failed: ${error.message}`);
  }
}

async function testWorktreeCreate(repoPath: string, branch: string): Promise<string> {
  const testBranch = `test/git-auth-${Date.now()}`;
  const testPath = `/tmp/worktree-test-${Date.now()}`;

  try {
    // Create worktree with new branch from origin/branch
    await execAsync(`git worktree add -b ${testBranch} "${testPath}" origin/${branch}`, {
      cwd: repoPath,
      timeout: 30000,
    });

    // Verify it was created
    const { stdout } = await execAsync('git branch --show-current', { cwd: testPath });

    // Cleanup
    await execAsync(`git worktree remove "${testPath}"`, { cwd: repoPath });
    await execAsync(`git branch -D ${testBranch}`, { cwd: repoPath });

    return `Created and cleaned up test worktree (branch: ${stdout.trim()})`;
  } catch (error: any) {
    // Try to cleanup on failure
    try {
      await execAsync(`git worktree remove "${testPath}" --force`, { cwd: repoPath }).catch(() => {});
      await execAsync(`git branch -D ${testBranch}`, { cwd: repoPath }).catch(() => {});
    } catch {}

    throw new Error(`Worktree creation failed: ${error.stderr || error.message}`);
  }
}

async function main() {
  console.log('\n' + yellow('Git Authentication & Worktree Test'));
  console.log('='.repeat(40) + '\n');

  const backendPath = process.env.BACKEND_REPO_PATH || '/repos/backend';
  const mobilePath = process.env.MOBILE_REPO_PATH || '/repos/mobile';

  // Environment checks
  console.log(yellow('Environment:'));
  await runTest('Check env vars', checkEnvVars);
  await runTest('Check private key', checkPrivateKey);
  await runTest('Check GIT_ASKPASS', checkGitAskpass);

  // Token generation
  console.log('\n' + yellow('Token Generation:'));
  await runTest('Generate installation token', testTokenGeneration);

  // Backend repo tests
  console.log('\n' + yellow(`Backend Repo (${backendPath}):`));
  await runTest('Check remote URL', () => testRemoteUrl(backendPath));
  await runTest('Fetch origin/master', () => testFetch(backendPath, 'master'));
  await runTest('List worktrees', () => testWorktreeList(backendPath));
  await runTest('Create test worktree', () => testWorktreeCreate(backendPath, 'master'));

  // Mobile repo tests
  console.log('\n' + yellow(`Mobile Repo (${mobilePath}):`));
  await runTest('Check remote URL', () => testRemoteUrl(mobilePath));
  await runTest('Fetch origin/main', () => testFetch(mobilePath, 'main'));
  await runTest('List worktrees', () => testWorktreeList(mobilePath));
  await runTest('Create test worktree', () => testWorktreeCreate(mobilePath, 'main'));

  // Summary
  console.log('\n' + '='.repeat(40));
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  if (failed === 0) {
    console.log(green(`\n✓ All ${passed} tests passed\n`));
  } else {
    console.log(red(`\n✗ ${failed} test(s) failed`) + `, ${passed} passed\n`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(red('\nFatal error:'), error.message);
  process.exit(1);
});
