import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { appendFile, cp, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import matter from 'gray-matter';
import { runnerConfigSchema } from './config.js';
import { logger } from '../system/logger.js';
import type { RunnerManager } from './manager.js';
import type { OrchardRunnerProvider } from './orchard-provider.js';
import { runnerMcpArgv, type RunnerMcpRequest } from './mcp.js';
import { runSweatcoinUi } from './sweatcoin-ui.js';
import type { RunnerCommandResult } from './types.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const agent = 'pm-agent';
const profile = 'ios';
const github = 'sweatco/sweatcoin-mobile';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

async function command(file: string, args: string[], cwd = root, env = process.env): Promise<string> {
  const { stdout } = await exec(file, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function manifest(cwd: string) {
  const names = (await command('git', ['ls-files', '-co', '--exclude-standard', '-z'], cwd)).split('\0').filter(Boolean).sort();
  const entries = [];
  for (const path of names) {
    const full = join(cwd, path);
    const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || (!info.isFile() && !info.isSymbolicLink())) continue;
    const linked = info.isSymbolicLink();
    const bytes = linked ? Buffer.from(await readlink(full)) : await readFile(full);
    assert(!bytes.subarray(0, 80).toString().startsWith('version https://git-lfs.github.com/spec/v1'), `Unresolved LFS pointer: ${path}; run git lfs pull in the source checkout`);
    entries.push({ path, linked, executable: Boolean(info.mode & 0o111), sha256: sha(bytes) });
  }
  return entries;
}

async function waitFor(check: () => Promise<boolean>, seconds: number, label: string) {
  const deadline = Date.now() + seconds * 1000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(1000);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, ref: { type: 'string', default: 'HEAD' }, image: { type: 'string' },
    out: { type: 'string' }, 'transfer-only': { type: 'boolean' }, 'reuse-build': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    logger.system('npm run runner:sweatcoin-e2e -- --repo /path/to/sweatcoin-mobile [--ref HEAD] [--image OCI@sha256:...] [--out NEW_DIRECTORY] [--transfer-only | --reuse-build REPORT_JSON]');
    return;
  }
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Requires an Apple Silicon macOS host');
  assert(values.repo, '--repo is required');
  assert(!(values['transfer-only'] && values['reuse-build']), '--transfer-only and --reuse-build are mutually exclusive');
  const repo = resolve(values.repo);
  const commit = await command('git', ['rev-parse', '--verify', `${values.ref}^{commit}`], repo);
  const images: { Name: string }[] = JSON.parse(await command('tart', ['list', '--source', 'oci', '--format', 'json']));
  const digests = [...new Set(images.map(x => x.Name).filter(x => /@sha256:[a-f0-9]{64}$/.test(x)))];
  const image = values.image ?? (digests.length === 1 ? digests[0] : undefined);
  assert(image && digests.includes(image), '--image must select a locally cached OCI digest (or cache exactly one digest)');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || await command('gh', ['auth', 'token']);
  assert(token, 'GitHub authentication is required for private build dependencies');
  process.umask(0o077);
  const evidenceRoot = join(root, 'e2e-evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const out = values.out ? resolve(values.out) : await mkdtemp(join(evidenceRoot, 'sweatcoin-'));
  if (values.out) await mkdir(out, { recursive: false });
  process.env.ARCHIE_WORKDIR = join(out, 'workdir');
  const { RunnerManager } = await import('./manager.js');
  const { OrchardRunnerProvider } = await import('./orchard-provider.js');
  const { generateTaskId } = await import('../tasks/persistence.js');
  const task = generateTaskId();
  const instanceId = `e2e-${randomUUID().slice(0, 8)}`;
  const source = join(out, 'source');
  const children: ChildProcess[] = [];
  const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  Object.assign(env, { ORCHARD_HOME: out, TART_NO_AUTO_PRUNE: '1' });
  let provider: OrchardRunnerProvider | undefined;
  let manager: RunnerManager | undefined;
  let activeExec: string | undefined;
  let recording: RunnerCommandResult | undefined;
  let synced = false;
  let orchardToken = '';
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const report: Record<string, unknown> = { scenario: values['transfer-only'] ? 'sweatcoin-tart-transfer' : values['reuse-build'] ? 'sweatcoin-tart-ui-replay' : 'sweatcoin-tart-ui', result: 'running', startedAt: new Date().toISOString(), task, instanceId, sourceCommit: commit, image, out };
  const errors: string[] = [];
  const redact = (text: string) => [token, orchardToken].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text);
  const save = () => writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  function launch(args: string[], log: string) {
    const fd = openSync(join(out, log), 'wx', 0o600);
    const child = spawn('orchard', args, { cwd: out, env, stdio: ['pipe', fd, fd] });
    closeSync(fd);
    child.on('error', error => { errors.push(error.message); abort.abort(error); });
    children.push(child);
    return child;
  }
  async function run(phase: string, argv: string[], options: { env?: Record<string, string>; reconnect?: boolean; requestId?: string; cleanup?: boolean } = {}) {
    if (!options.cleanup) abort.signal.throwIfAborted();
    report.phase = phase;
    logger.system(`Sweatcoin E2E: ${phase} (${out})`);
    await save();
    activeExec = options.requestId ?? randomUUID();
    let page = await manager!.exec(task, agent, profile, github, argv, '.', options.env ?? {}, 1, activeExec);
    if (options.reconnect) {
      assert.equal(page.state, 'running', 'The restart scenario must start a detached command');
      manager!.shutdown();
      manager = new RunnerManager(loaded, provider!);
      await manager.initialize();
      const retry = await manager.exec(task, agent, profile, github, argv, '.', options.env ?? {}, 1, activeExec);
      assert.equal(retry.execId, page.execId, 'Retry started a second execution');
    }
    const log = await open(join(out, `${phase}.log`), 'wx', 0o600);
    let captured = '';
    try {
      while (true) {
        if (!options.cleanup) abort.signal.throwIfAborted();
        assert(!page.truncated, `${phase}: runner output was truncated`);
        const chunk = redact(page.stdout + page.stderr);
        await log.write(chunk);
        captured += page.stdout;
        if (page.state !== 'running' && !page.hasMore) break;
        page = await manager!.poll(task, agent, profile, page.execId, page.cursor, 10);
      }
      assert.equal(page.state, 'completed', `${phase}: ${page.state}`);
      assert.equal(page.exitCode, 0, `${phase} exited ${page.exitCode}; see ${phase}.log`);
      activeExec = undefined;
      return captured;
    } finally { await log.close(); }
  }
  async function mcp(phase: string, request: Omit<RunnerMcpRequest, 'server'>) {
    const id = randomUUID();
    const envelope = JSON.parse(await run(phase, runnerMcpArgv(id, { server: 'argent', ...request }), { requestId: id }));
    let result = envelope.result;
    if (!result) {
      const artifacts = await manager!.collect(task, agent, profile, github, [envelope.result_path], abort.signal);
      result = JSON.parse(await readFile(join(artifacts, envelope.result_path), 'utf8'));
    }
    await writeFile(join(out, `${phase}.json`), JSON.stringify(result, null, 2) + '\n');
    assert(!result.isError, `Argent ${request.tool ?? 'discovery'} failed: ${JSON.stringify(result.content)}`);
    return result;
  }
  let loaded: import('./types.js').LoadedRunnerConfig;
  try {
    await save();
    await writeFile(join(out, 'archie-manifest.json'), JSON.stringify(await manifest(root)));
    report.archieCommit = await command('git', ['rev-parse', 'HEAD']);
    report.archieManifestSha256 = sha(await readFile(join(out, 'archie-manifest.json')));
    report.versions = { node: process.version, orchard: await command('orchard', ['--version']), tart: await command('tart', ['--version']) };
    await command('git', ['clone', '--shared', '--no-checkout', '--', repo, source]);
    await command('git', ['checkout', '--detach', commit], source, { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' });
    const lfs = (await command('git', ['lfs', 'env'], repo)).split('\n').find(x => x.startsWith('LocalMediaDir='))?.slice('LocalMediaDir='.length);
    assert(lfs, 'git-lfs is required');
    await command('git', ['-c', `lfs.storage=${resolve(lfs, '..')}`, 'lfs', 'checkout'], source);
    await cp(join(root, 'tools/e2e/sweatcoin-build.sh'), join(source, '.archie-e2e-driver.sh'));
    if (values['reuse-build']) {
      const priorPath = resolve(values['reuse-build']);
      const prior = JSON.parse(await readFile(priorPath, 'utf8'));
      assert.equal(prior.sourceCommit, commit, 'Reused app must match the selected mobile commit');
      const results = join(prior.artifacts, '.archie-e2e/results');
      const summary = JSON.parse(await readFile(join(results, 'build-summary.json'), 'utf8'));
      assert(summary.status === 'succeeded' && summary.errorCount === 0, 'Reused native build did not pass');
      const archive = await readFile(join(results, 'swc.app.zip'));
      await writeFile(join(source, '.archie-prebuilt-app'), archive);
      await cp(join(results, 'build-summary.json'), join(source, '.archie-prebuilt-summary'));
      report.reusedBuild = { report: priorPath, image: prior.image, appArchiveSha256: sha(archive) };
    }
    const sourceManifest = JSON.stringify(await manifest(source));
    report.sourceManifestSha256 = sha(sourceManifest);
    await writeFile(join(out, 'source-manifest.json'), sourceManifest);
    await writeFile(join(source, '.archie-source-manifest.json'), sourceManifest);
    const socket = createServer();
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = (socket.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    const url = `http://127.0.0.1:${port}`;
    const controller = launch(['controller', 'run', '--data-dir', join(out, 'controller'), '--listen', `127.0.0.1:${port}`, '--insecure-no-tls'], 'controller.log');
    controller.stdin!.end();
    const configPath = join(out, '.orchard/orchard.yml');
    await waitFor(async () => {
      abort.signal.throwIfAborted();
      assert(controller.exitCode === null && controller.signalCode === null, 'Orchard controller exited');
      return readFile(configPath).then(() => true, () => false);
    }, 30, 'Orchard bootstrap');
    const config = matter(`---\n${await readFile(configPath, 'utf8')}\n---`).data;
    const context = config.contexts[config['default-context']];
    assert.equal(context.url, url);
    orchardToken = context.serviceAccountToken;
    loaded = {
      config: runnerConfigSchema.parse({ version: 1, instanceId, maxConcurrent: 1, orchard: { baseUrl: `${url}/v1`, context: config['default-context'], allowInsecureHttp: true }, profiles: { ios: {
        image, passwordEnv: 'ARCHIE_E2E_GUEST_PASSWORD', allowedAgents: [agent], username: 'admin', cpu: 4, memoryMiB: 8192, diskGiB: 140,
        networkMode: 'nat', leaseTtlMinutes: 240, execTimeoutSeconds: 7200, maxExecOutputBytes: 16 * 1024 * 1024,
        readinessCommand: ['/usr/bin/xcodebuild', '-version'],
      } } }),
      serviceAccountName: context.serviceAccountName, serviceAccountToken: context.serviceAccountToken,
      guestPasswords: { ios: process.env.ARCHIE_E2E_GUEST_PASSWORD || 'admin' },
    };
    provider = new OrchardRunnerProvider(loaded.config.orchard.baseUrl, loaded.serviceAccountName, loaded.serviceAccountToken);
    await waitFor(() => provider!.list().then(() => true, () => false), 30, 'Orchard API');
    const bootstrap = await command('orchard', ['get', 'bootstrap-token', loaded.serviceAccountName], out, env);
    const worker = launch(['worker', 'run', url, '--bootstrap-token-stdin', '--name', instanceId], 'worker.log');
    worker.stdin!.end(bootstrap + '\n');
    manager = new RunnerManager(loaded, provider);
    await manager.initialize();
    report.phase = 'provision-and-sync';
    await save();
    const sync = await manager.sync(task, agent, profile, github, source, abort.signal);
    synced = true;
    report.backendId = sync.lease.backendId;
    report.transfer = { bytes: sync.bytes, files: sync.files, remotePath: sync.remotePath };
    const verification = `import hashlib,json,pathlib,os,shutil
f=pathlib.Path('.archie-source-manifest.json')
assert hashlib.sha256(f.read_bytes()).hexdigest()==os.environ['SOURCE_SHA256']
for e in json.loads(f.read_text()):
 p=pathlib.Path(e['path']); assert p.is_symlink()==e['linked'],p
 data=os.readlink(p).encode() if e['linked'] else p.read_bytes()
 assert hashlib.sha256(data).hexdigest()==e['sha256'],p
 assert bool(p.lstat().st_mode & 0o111)==e['executable'],p
pathlib.Path('.archie-e2e/results').mkdir(parents=True,exist_ok=True)
shutil.copyfile(f,'.archie-e2e/results/source-manifest.json')
print(os.environ['SOURCE_SHA256'])`;
    assert.equal((await run('verify-source', ['/usr/bin/python3', '-c', verification], { env: { SOURCE_SHA256: sha(sourceManifest) } })).trim(), sha(sourceManifest));
    const restarted = await run('restart-and-retry', ['/bin/sh', '-c', 'printf "once\\n" >> .archie-e2e/starts; sleep 15; cat .archie-e2e/starts'], { reconnect: true });
    assert.equal(restarted.trim(), 'once', 'Command ran more than once across restart/retry');
    report.restartAndRetry = 'pass';
    const payloadSha = (await run('large-artifact', ['/usr/bin/python3', '-c', `import hashlib,os,pathlib
data=os.urandom(32*1024*1024)
pathlib.Path('.archie-e2e/transfer.bin').write_bytes(data)
print(hashlib.sha256(data).hexdigest())`])).trim();
    const transferArtifacts = await manager.collect(task, agent, profile, github, ['.archie-e2e/transfer.bin'], abort.signal);
    assert.equal(sha(await readFile(join(transferArtifacts, '.archie-e2e/transfer.bin'))), payloadSha, 'Large artifact was corrupted');
    report.largeArtifact = { result: 'pass', bytes: 32 * 1024 * 1024, sha256: payloadSha, artifacts: transferArtifacts };
    await save();
    if (!values['transfer-only']) {
      const guestEnv = {
        GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'git@github.com:',
        GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
        GIT_CONFIG_KEY_2: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_2: '!f() { printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_TOKEN"; }; f',
      };
      await run('prepare', ['/bin/bash', '.archie-e2e-driver.sh', values['reuse-build'] ? 'prepare-ui' : 'prepare'], { env: guestEnv });
      await run(values['reuse-build'] ? 'restore-app' : 'build', ['/bin/bash', '.archie-e2e-driver.sh', values['reuse-build'] ? 'restore-app' : 'build']);
      await run('simulator', ['/bin/bash', '.archie-e2e-driver.sh', 'simulator']);
      const udid = (await run('simulator-id', ['/bin/cat', '.archie-e2e/udid'])).trim();
      report.udid = udid;
      const catalog = await mcp('argent-tools', {});
      for (const name of ['list-devices', 'restart-app', 'native-find-views', 'native-full-hierarchy', 'await-ui-element', 'await-screen-idle', 'gesture-tap', 'screenshot']) {
        assert(catalog.tools.some((tool: { name: string }) => tool.name === name), `Argent tool missing: ${name}`);
      }
      await mcp('argent-devices', { tool: 'list-devices' });
      await run('first-launch', ['/bin/bash', '.archie-e2e-driver.sh', 'launch']);
      let ready = false;
      for (const attempt of [1, 2, 3]) {
        const result = await mcp(`app-ready-${attempt}`, { tool: 'await-ui-element', arguments: { udid, bundleId: 'swc', condition: 'visible', selector: { identifier: 'signUpButton' }, timeoutMs: 120000, pollIntervalMs: 2000 }, timeout_seconds: 150 });
        const text = result.content.find((block: { type: string; text?: string }) => block.type === 'text' && block.text?.trimStart().startsWith('{'))?.text;
        ready = Boolean(text && JSON.parse(text).success === true);
        if (ready) break;
      }
      assert(ready, 'First launch did not reach welcome within the six-minute startup budget');
      recording = await manager.exec(task, agent, profile, github, ['/bin/bash', '.archie-e2e-driver.sh', 'record'], '.', {}, 1, randomUUID());
      let recordingLog = recording.stdout + recording.stderr;
      for (let attempt = 0; !recordingLog.includes('Recording started') && attempt < 30; attempt++) {
        assert.equal(recording.state, 'running', 'Recorder exited before its first frame');
        recording = await manager.poll(task, agent, profile, recording.execId, recording.cursor, 1);
        recordingLog += recording.stdout + recording.stderr;
      }
      await writeFile(join(out, 'recording.log'), recordingLog);
      assert(recordingLog.includes('Recording started'), 'Recorder did not receive a frame');
      const passes = [];
      for (const pass of [1, 2]) {
        const result = await runSweatcoinUi((phase, tool, args) => mcp(`ui-${pass}-${phase}`, { tool, arguments: args }), udid);
        passes.push({ pass, result: 'pass', ...result });
      }
      report.ui = { scenario: 'login-recovery-round-trip', passes };
    }
  } catch (error) {
    errors.push(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    if (manager && activeExec) await manager.cancel(task, agent, profile, activeExec).catch(error => errors.push(String(error)));
    if (manager && recording) {
      try {
        await run('stop-recording', ['/bin/bash', '.archie-e2e-driver.sh', 'stop-recording'], { cleanup: true });
        await waitFor(async () => {
          if (recording!.state === 'running' || recording!.hasMore) {
            recording = await manager!.poll(task, agent, profile, recording!.execId, recording!.cursor, 5);
            await appendFile(join(out, 'recording.log'), redact(recording.stdout + recording.stderr));
          }
          return recording!.state !== 'running' && !recording!.hasMore;
        }, 60, 'Video finalization');
        assert.equal(recording.state, 'completed', 'Video recording did not complete');
        assert.equal(recording.exitCode, 0, 'Video recording failed');
      } catch (error) {
        errors.push(`Recording: ${String(error)}`);
        await manager.cancel(task, agent, profile, recording.execId).catch(error => errors.push(String(error)));
      }
    }
    if (errors.length && report.udid && !abort.signal.aborted) {
      for (const tool of ['describe', 'native-full-hierarchy', 'native-network-logs']) {
        await mcp(`failure-${tool}`, { tool, arguments: { udid: report.udid, bundleId: 'swc' }, timeout_seconds: 30 }).catch(error => errors.push(`Diagnostic ${tool}: ${String(error)}`));
      }
    }
    if (manager && synced && !values['transfer-only']) await run('cleanup', ['/bin/bash', '.archie-e2e-driver.sh', 'cleanup'], { cleanup: true }).catch(error => errors.push(`Simulator cleanup: ${String(error)}`));
    if (manager && synced) {
      try {
        const artifacts = await manager.collect(task, agent, profile, github, ['.archie-e2e/results', ...(!values['transfer-only'] && report.udid ? ['.archie-mcp'] : [])]);
        report.artifacts = artifacts;
        if (!errors.length) {
          const results = join(artifacts, '.archie-e2e/results');
          assert.equal(sha(await readFile(join(results, 'source-manifest.json'))), report.sourceManifestSha256);
          if (!values['transfer-only']) {
            const summary = JSON.parse(await readFile(join(results, 'build-summary.json'), 'utf8'));
            assert(summary.status === 'succeeded' && summary.errorCount === 0, 'Collected build summary did not pass');
            assert((await lstat(join(results, 'app.png'))).size > 0, 'Screenshot missing');
            const videoPath = join(results, 'scenario.mp4');
            const video = JSON.parse(await command('swift', [join(root, 'tools/e2e/verify-video.swift'), videoPath]));
            report.video = { ...video, path: videoPath, sha256: sha(await readFile(videoPath)) };
          }
        }
      } catch (error) { errors.push(`Collect: ${String(error)}`); }
    }
    if (manager) await manager.release(task, agent, profile).catch(error => errors.push(`Release: ${String(error)}`));
    manager?.shutdown();
    try {
      if (provider) {
        const remaining = await provider.list();
        for (const vm of remaining) {
          assert(vm.id.startsWith(`archie-${instanceId}-`), 'Unexpected VM in isolated controller');
          await provider.release(vm.id);
        }
        await waitFor(async () => {
          const vms: { Name: string }[] = JSON.parse(await command('tart', ['list', '--source', 'local', '--format', 'json']));
          return !vms.some(vm => vm.Name.startsWith(`orchard-archie-${instanceId}-`));
        }, 60, 'Tart VM deletion');
        report.vmDeleted = true;
      }
    } catch (error) { errors.push(`VM cleanup: ${String(error)}`); }
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 10, 'Orchard shutdown').catch(() => child.kill('SIGKILL'));
    }
    if (children.length) {
      const log = join(out, 'controller.log');
      await readFile(log, 'utf8').then(text => writeFile(log, redact(text).replace(/^.*Service account token:.*$/gm, '[Orchard bootstrap credential redacted]'))).catch(error => errors.push(`Log redaction: ${String(error)}`));
    }
    await rm(source, { recursive: true, force: true });
    await rm(join(out, '.orchard'), { recursive: true, force: true });
    await rm(join(out, 'controller'), { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    report.result = errors.length ? 'fail' : 'pass';
    report.finishedAt = new Date().toISOString();
    report.errors = errors.map(redact);
    await save();
    logger.system(`Sweatcoin E2E ${report.result}: ${join(out, 'report.json')}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

main().catch(error => { logger.error('Sweatcoin E2E', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
