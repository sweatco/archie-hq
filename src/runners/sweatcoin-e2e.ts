#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadRunnerConfig } from './config.js';
import { RunnerManager } from './manager.js';
import { OrchardRunnerProvider } from './orchard-provider.js';
import { generateTaskId } from '../tasks/persistence.js';

const execFileAsync = promisify(execFile);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeIdentifier(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

function sha256Value(name: string): string {
  const value = requiredEnv(name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 hex digest`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function completeJpegCount(data: Uint8Array): number {
  let count = 0;
  let inside = false;
  for (let index = 0; index + 1 < data.length; index += 1) {
    if (!inside && data[index] === 0xff && data[index + 1] === 0xd8) {
      inside = true;
      index += 1;
    } else if (inside && data[index] === 0xff && data[index + 1] === 0xd9) {
      inside = false;
      count += 1;
      index += 1;
    }
  }
  return count;
}

export function validateMjpeg(data: Uint8Array, contentType: string): number {
  const match = /multipart\/x-mixed-replace\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) throw new Error(`Unexpected MJPEG content type: ${contentType}`);
  const boundary = Buffer.from((match[1] ?? match[2] ?? '').replace(/^--/, ''));
  if (boundary.length === 0 || Buffer.from(data).indexOf(boundary) < 0) throw new Error('MJPEG boundary is absent from the response body');
  const frames = completeJpegCount(data);
  if (frames < 2) throw new Error(`Expected at least two complete MJPEG frames, received ${frames}`);
  return frames;
}

export function mp4DurationSeconds(data: Buffer): number {
  const marker = data.indexOf(Buffer.from('mvhd'));
  if (marker < 0 || marker + 40 > data.length) throw new Error('MP4 movie header is missing');
  const version = data[marker + 4];
  if (version === 0) {
    const timescale = data.readUInt32BE(marker + 16);
    const duration = data.readUInt32BE(marker + 20);
    if (timescale === 0) throw new Error('MP4 timescale is zero');
    return duration / timescale;
  }
  if (version === 1) {
    const timescale = data.readUInt32BE(marker + 24);
    const duration = data.readBigUInt64BE(marker + 28);
    if (timescale === 0) throw new Error('MP4 timescale is zero');
    return Number(duration) / timescale;
  }
  throw new Error(`Unsupported MP4 movie-header version ${version}`);
}

async function validateArtifacts(root: string, expectedWidth: number, expectedHeight: number) {
  const results = join(root, '.archie-e2e', 'results');
  const png = await readFile(join(results, 'sweatcoin.png'));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Collected screenshot is not a PNG');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Unexpected screenshot dimensions ${width}x${height}; expected ${expectedWidth}x${expectedHeight}`);
  }

  const mp4 = await readFile(join(results, 'sweatcoin.mp4'));
  if (mp4.indexOf(Buffer.from('ftyp')) < 0 || mp4.indexOf(Buffer.from('mdat')) < 0 || mp4.indexOf(Buffer.from('avc1')) < 0) {
    throw new Error('Collected recording is not an H.264 MP4');
  }
  const durationSeconds = mp4DurationSeconds(mp4);
  if (durationSeconds < 3) throw new Error(`Collected recording is too short (${durationSeconds.toFixed(2)} seconds)`);

  const lldb = await readFile(join(results, 'lldb.txt'), 'utf8');
  for (const expected of ['stopped', 'thread #1', 'detached']) {
    if (!lldb.includes(expected)) throw new Error(`LLDB transcript is missing ${JSON.stringify(expected)}`);
  }

  const headers = await readFile(join(results, 'sweatcoin-live.headers'), 'utf8');
  if (!/^HTTP\/\d(?:\.\d)? 200\b/im.test(headers)) throw new Error('Guest-local stream did not return HTTP 200');
  const contentType = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim();
  if (!contentType) throw new Error('Guest-local stream did not return a content type');
  const mjpeg = await readFile(join(results, 'sweatcoin-live.mjpeg'));
  const mjpegFrames = validateMjpeg(mjpeg, contentType);

  const uiDiagnostic = await readFile(join(results, 'ui-diagnostic.txt'), 'utf8');
  return {
    screenshot: { bytes: png.length, sha256: sha256(png), width, height },
    recording: { bytes: mp4.length, sha256: sha256(mp4), codec: 'avc1', durationSeconds },
    lldb: { bytes: Buffer.byteLength(lldb), sha256: sha256(Buffer.from(lldb)), attachedAndDetached: true },
    guestMjpeg: { bytes: mjpeg.length, sha256: sha256(mjpeg), frames: mjpegFrames, contentType },
    uiDiagnostic: { bytes: Buffer.byteLength(uiDiagnostic), sha256: sha256(Buffer.from(uiDiagnostic)) },
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function sampleForwardedMjpeg(port: number, durationMs: number): Promise<{ bytes: number; frames: number; contentType: string }> {
  let controller: AbortController | undefined;
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 20 && !response; attempt += 1) {
    controller = new AbortController();
    const connectTimer = setTimeout(() => controller?.abort(), 2000);
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(connectTimer);
    }
    if (!response) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (!response || !controller) throw new Error(`Forwarded stream did not become reachable: ${String(lastError)}`);
  if (!response.ok) {
    controller.abort();
    throw new Error(`Forwarded stream returned HTTP ${response.status}`);
  }
  const timer = setTimeout(() => controller?.abort(), durationMs);
  const contentType = response.headers.get('content-type') ?? '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Forwarded stream response has no body');
    while (total < 16 * 1024 * 1024) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.length;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return { bytes: total, frames: validateMjpeg(data, contentType), contentType };
}

async function main(): Promise<void> {
  if (process.env.ARCHIE_SWEATCOIN_LIVE_E2E !== 'true') {
    throw new Error('ARCHIE_SWEATCOIN_LIVE_E2E=true is required because this canary provisions and deletes a real VM');
  }
  const profile = requiredEnv('ARCHIE_SWEATCOIN_PROFILE');
  const agentId = requiredEnv('ARCHIE_SWEATCOIN_AGENT');
  const fixtureRepo = resolve(requiredEnv('ARCHIE_SWEATCOIN_FIXTURE_REPO'));
  const fixtureGithub = process.env.ARCHIE_SWEATCOIN_FIXTURE_GITHUB ?? 'e2e/sweatcoin-fixture';
  const expectedFixtureCommit = requiredEnv('ARCHIE_SWEATCOIN_FIXTURE_COMMIT');
  const appBuildRef = requiredEnv('ARCHIE_SWEATCOIN_APP_BUILD_REF');
  const appSha256 = sha256Value('ARCHIE_SWEATCOIN_APP_SHA256');
  const axeSha256 = sha256Value('ARCHIE_SWEATCOIN_AXE_SHA256');
  const bridgeSha256 = sha256Value('ARCHIE_SWEATCOIN_BRIDGE_SHA256');
  const axeVersion = requiredEnv('ARCHIE_SWEATCOIN_AXE_VERSION');
  const orchardVersion = requiredEnv('ARCHIE_SWEATCOIN_ORCHARD_VERSION');
  const runtime = safeIdentifier('ARCHIE_SWEATCOIN_RUNTIME');
  const deviceType = safeIdentifier('ARCHIE_SWEATCOIN_DEVICE_TYPE', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16');
  const bundleId = safeIdentifier('ARCHIE_SWEATCOIN_BUNDLE_ID', 'swc');
  const expectedWidth = boundedInteger('ARCHIE_SWEATCOIN_SCREENSHOT_WIDTH', 1179, 1, 10000);
  const expectedHeight = boundedInteger('ARCHIE_SWEATCOIN_SCREENSHOT_HEIGHT', 2556, 1, 10000);
  const holdSeconds = boundedInteger('ARCHIE_SWEATCOIN_HOLD_SECONDS', 0, 0, 3600);
  const timeoutSeconds = boundedInteger('ARCHIE_SWEATCOIN_TIMEOUT_SECONDS', 1800, 60, 7200);
  const externalPort = boundedInteger('ARCHIE_SWEATCOIN_EXTERNAL_PORT', 18081, 1024, 65535);
  const orchardBin = process.env.ARCHIE_SWEATCOIN_ORCHARD_BIN;

  const [{ stdout: fixtureCommit }, { stdout: fixtureStatus }] = await Promise.all([
    execFileAsync('git', ['-C', fixtureRepo, 'rev-parse', 'HEAD']),
    execFileAsync('git', ['-C', fixtureRepo, 'status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (fixtureCommit.trim() !== expectedFixtureCommit) throw new Error('Fixture checkout does not match ARCHIE_SWEATCOIN_FIXTURE_COMMIT');
  if (fixtureStatus.trim()) throw new Error('Fixture checkout must be clean so its commit identifies every transferred byte');

  let archieCommit = process.env.ARCHIE_BUILD_COMMIT ?? process.env.GITHUB_SHA;
  if (!archieCommit) {
    try {
      archieCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'])).stdout.trim();
      const status = (await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
      if (status.trim()) throw new Error('Archie checkout must be clean or ARCHIE_BUILD_COMMIT must identify the built image');
    } catch {
      throw new Error('ARCHIE_BUILD_COMMIT is required when the Archie checkout metadata is unavailable');
    }
  }

  const setupScript = String.raw`
set -eu
root=.archie-e2e
rm -rf "$root"
mkdir -p "$root/payload" "$root/results" "$root/tools"
printf '%s  %s\n' ${shellQuote(appSha256)} swc.app.tgz | /usr/bin/shasum -a 256 -c -
printf '%s  %s\n' ${shellQuote(axeSha256)} axe.tgz | /usr/bin/shasum -a 256 -c -
printf '%s  %s\n' ${shellQuote(bridgeSha256)} mjpeg_bridge.py | /usr/bin/shasum -a 256 -c -
/usr/bin/tar -xzf swc.app.tgz -C "$root/payload"
/usr/bin/tar -xzf axe.tgz -C "$root/tools"
chmod 755 "$root/tools/libexec/axe"
runtime=${shellQuote(runtime)}
device_type=${shellQuote(deviceType)}
udid=$(/usr/bin/xcrun simctl create 'Archie Sweatcoin E2E' "$device_type" "$runtime")
printf '%s\n' "$udid" > "$root/udid"
/usr/bin/xcrun simctl boot "$udid"
/usr/bin/xcrun simctl bootstatus "$udid" -b
app=$(/usr/bin/find "$root/payload" -type d -name '*.app' -print -quit)
test -n "$app"
/usr/bin/xcrun simctl install "$udid" "$app"
launch=$(/usr/bin/xcrun simctl launch "$udid" ${shellQuote(bundleId)})
pid=$(printf '%s\n' "$launch" | /usr/bin/awk '{print $NF}')
case "$pid" in *[!0-9]*|'') echo 'Invalid Sweatcoin PID' >&2; exit 1;; esac
printf '%s\n' "$pid" > "$root/pid"
/bin/sleep 3
"$root/tools/libexec/axe" describe-ui --udid "$udid" > "$root/results/ui-diagnostic.txt" 2>&1 || true
"$root/tools/libexec/axe" screenshot --udid "$udid" --output "$root/results/sweatcoin.png"
printf 'UDID=%s\nPID=%s\nRUNTIME=%s\n' "$udid" "$pid" "$runtime"
`;

  const lldbScript = String.raw`
set -eu
root=.archie-e2e
pid=$(/bin/cat "$root/pid")
/usr/bin/xcrun lldb --batch \
  -o "process attach --pid $pid" \
  -o 'thread backtrace -c 8' \
  -o 'process detach' \
  -o 'quit' | /usr/bin/tee "$root/results/lldb.txt"
`;

  const recordScript = String.raw`
set -eu
root=.archie-e2e
udid=$(/bin/cat "$root/udid")
video="$root/results/sweatcoin.mp4"
rm -f "$video"
recorder=''
stop_recorder() {
  if [ -n "$recorder" ] && kill -0 "$recorder" 2>/dev/null; then
    kill -INT "$recorder" 2>/dev/null || true
    wait "$recorder" 2>/dev/null || true
  fi
}
trap stop_recorder EXIT
/usr/bin/xcrun simctl io "$udid" recordVideo --codec=h264 "$video" >/dev/null 2>&1 &
recorder=$!
/bin/sleep 2
/usr/bin/xcrun simctl terminate "$udid" ${shellQuote(bundleId)} 2>/dev/null || true
/usr/bin/xcrun simctl launch "$udid" ${shellQuote(bundleId)} >/dev/null
/bin/sleep 8
stop_recorder
recorder=''
trap - EXIT
test -s "$video"
/usr/bin/stat -f 'MP4_BYTES=%z' "$video"
`;

  const streamSampleScript = String.raw`
set -eu
root=.archie-e2e
sample="$root/results/sweatcoin-live.mjpeg"
headers="$root/results/sweatcoin-live.headers"
rm -f "$sample" "$headers"
code=0
attempt=0
while :; do
  code=0
  /usr/bin/curl --silent --show-error --max-time 4 --dump-header "$headers" http://127.0.0.1:18080/ --output "$sample" || code=$?
  if [ "$code" -ne 7 ] || [ "$attempt" -ge 20 ]; then break; fi
  attempt=$((attempt + 1))
  /bin/sleep 0.5
done
if [ "$code" -ne 0 ] && [ "$code" -ne 28 ]; then exit "$code"; fi
test -s "$sample"
/usr/bin/grep -Eiq '^content-type: multipart/x-mixed-replace;.*boundary=' "$headers"
/usr/bin/python3 -c 'import pathlib,sys; data=pathlib.Path(sys.argv[1]).read_bytes(); starts=data.count(b"\xff\xd8"); ends=data.count(b"\xff\xd9"); assert min(starts, ends) >= 2, (starts, ends); print(f"MJPEG_BYTES={len(data)} MJPEG_FRAMES={min(starts, ends)}")' "$sample"
`;

  const loaded = await loadRunnerConfig();
  if (!loaded) throw new Error('ARCHIE_RUNNERS_CONFIG is required');
  const profileConfig = loaded.config.profiles[profile];
  if (!profileConfig) throw new Error(`Unknown runner profile ${profile}`);
  const provider = new OrchardRunnerProvider(loaded.config.orchard.baseUrl, loaded.serviceAccountName, loaded.serviceAccountToken);
  const manager = new RunnerManager(loaded, provider);
  if (holdSeconds > profileConfig.maxDebugTtlMinutes * 60) {
    throw new Error(`ARCHIE_SWEATCOIN_HOLD_SECONDS exceeds the ${profileConfig.maxDebugTtlMinutes}-minute profile debug cap`);
  }
  const taskId = generateTaskId();
  let backendId: string | undefined;
  let bridgeExecId: string | undefined;
  let activeExecId: string | undefined;
  let portForward: ChildProcess | undefined;
  let artifactPath: string | undefined;
  let artifactEvidence: Awaited<ReturnType<typeof validateArtifacts>> | undefined;
  let externalStream: { bytes: number; frames: number; contentType: string } | undefined;
  let failure: unknown;
  let interrupted = false;
  let interruptionReason = '';
  let resolveInterrupted!: () => void;
  const interruption = new Promise<void>((resolvePromise) => { resolveInterrupted = resolvePromise; });
  let interruptCancel: Promise<void> | undefined;
  const transferAbort = new AbortController();

  const requestInterruption = (reason: string, exitCode: number) => {
    if (interrupted) return;
    interrupted = true;
    interruptionReason = reason;
    process.exitCode = exitCode;
    resolveInterrupted();
    transferAbort.abort(new Error(reason));
    if (activeExecId && backendId) {
      interruptCancel = manager.cancel(taskId, agentId, profile, activeExecId);
      void interruptCancel.catch(() => {});
    }
  };
  const onSignal = (signal: NodeJS.Signals) => requestInterruption(`received ${signal}`, 130);
  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
  for (const signal of signals) process.once(signal, onSignal);
  const deadlineTimer = setTimeout(() => requestInterruption(`exceeded ${timeoutSeconds}-second deadline`, 1), timeoutSeconds * 1000);

  const throwIfInterrupted = () => {
    if (interrupted) throw new Error(`Sweatcoin canary interrupted: ${interruptionReason}`);
  };

  const run = async (argv: string[], waitSeconds = 30): Promise<{ stdout: string; stderr: string }> => {
    throwIfInterrupted();
    const requestId = randomUUID();
    activeExecId = requestId;
    try {
      let page = await manager.exec(taskId, agentId, profile, fixtureGithub, argv, '.', {}, Math.min(waitSeconds, 5), requestId);
      const stdout = [page.stdout];
      const stderr = [page.stderr];
      while (page.state === 'running' || page.hasMore) {
        throwIfInterrupted();
        page = await manager.poll(taskId, agentId, profile, requestId, page.cursor, 5);
        stdout.push(page.stdout);
        stderr.push(page.stderr);
      }
      if (page.state !== 'completed' || page.exitCode !== 0) {
        throw new Error(`Runner command ${requestId} ended in ${page.state} with exit ${page.exitCode ?? 'none'}: ${stderr.join('').trim()}`);
      }
      return { stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
      activeExecId = undefined;
    }
  };

  const startBridge = async (): Promise<string> => {
    throwIfInterrupted();
    const requestId = randomUUID();
    const command = [
      '/bin/sh',
      '-lc',
      'exec /usr/bin/python3 mjpeg_bridge.py 18080 .archie-e2e/tools/libexec/axe "$(/bin/cat .archie-e2e/udid)"',
    ];
    const result = await manager.exec(taskId, agentId, profile, fixtureGithub, command, '.', {}, 0, requestId);
    if (result.state !== 'running') throw new Error(`MJPEG bridge did not stay running: ${result.stderr}`);
    return requestId;
  };

  try {
    throwIfInterrupted();
    const lease = await manager.ensure(taskId, agentId, profile);
    backendId = lease.backendId;
    const synced = await manager.sync(taskId, agentId, profile, fixtureGithub, fixtureRepo, transferAbort.signal);
    console.log(JSON.stringify({ phase: 'synced', taskId, backendId, bytes: synced.bytes }));
    throwIfInterrupted();

    const setup = await run(['/bin/sh', '-lc', setupScript]);
    console.log(JSON.stringify({ phase: 'launched', output: setup.stdout.trim() }));

    const lldb = await run(['/bin/sh', '-lc', lldbScript]);
    if (!lldb.stdout.includes('thread #1') || !lldb.stdout.includes('detached')) throw new Error('LLDB did not attach, backtrace, and detach');
    console.log(JSON.stringify({ phase: 'debugged', lldb: 'attached, backtraced, detached' }));

    const recording = await run(['/bin/sh', '-lc', recordScript]);
    console.log(JSON.stringify({ phase: 'recorded', output: recording.stdout.trim() }));

    bridgeExecId = await startBridge();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    const sample = await run(['/bin/sh', '-lc', streamSampleScript]);
    await manager.cancel(taskId, agentId, profile, bridgeExecId);
    bridgeExecId = undefined;
    console.log(JSON.stringify({ phase: 'stream-sampled', output: sample.stdout.trim() }));

    if (orchardBin) {
      bridgeExecId = await startBridge();
      portForward = spawn(orchardBin, ['port-forward', 'vm', backendId, `${externalPort}:18080`], {
        env: { ...process.env, ORCHARD_URL: loaded.config.orchard.baseUrl.replace(/\/v1\/?$/, '') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      const spawnFailure = new Promise<never>((_resolve, reject) => portForward?.once('error', reject));
      portForward.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < 8192) stderr.push(chunk);
        stderrBytes += chunk.length;
      });
      await Promise.race([new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)), spawnFailure]);
      if (portForward.exitCode !== null) throw new Error(`Orchard port forward exited early: ${Buffer.concat(stderr).toString('utf8').trim()}`);
      externalStream = await sampleForwardedMjpeg(externalPort, 4000);
      await stopChild(portForward);
      portForward = undefined;
      await manager.cancel(taskId, agentId, profile, bridgeExecId);
      bridgeExecId = undefined;
      console.log(JSON.stringify({ phase: 'external-stream-verified', ...externalStream }));
    }

    artifactPath = await manager.collect(taskId, agentId, profile, fixtureGithub, [
      '.archie-e2e/results/sweatcoin.png',
      '.archie-e2e/results/sweatcoin.mp4',
      '.archie-e2e/results/sweatcoin-live.mjpeg',
      '.archie-e2e/results/sweatcoin-live.headers',
      '.archie-e2e/results/lldb.txt',
      '.archie-e2e/results/ui-diagnostic.txt',
    ], transferAbort.signal);
    artifactEvidence = await validateArtifacts(artifactPath, expectedWidth, expectedHeight);

    if (holdSeconds > 0) {
      bridgeExecId = await startBridge();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      const debug = await manager.openDebug(taskId, agentId, profile, Math.ceil(holdSeconds / 60), [18080]);
      console.log(`RUNNER_DEBUG_HANDOFF=${JSON.stringify({ taskId, artifactPath, streamUrl: 'http://127.0.0.1:18080/', holdSeconds, ...debug })}`);
      let holdTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolvePromise) => { holdTimer = setTimeout(resolvePromise, holdSeconds * 1000); }),
          interruption,
        ]);
      } finally {
        if (holdTimer) clearTimeout(holdTimer);
      }
      throwIfInterrupted();
    }
  } catch (error) {
    failure = error;
  }

  clearTimeout(deadlineTimer);
  for (const signal of signals) process.off(signal, onSignal);
  const cleanupErrors: unknown[] = [];
  if (interruptCancel) {
    try { await interruptCancel; } catch (error) { cleanupErrors.push(error); }
  }
  if (portForward) {
    try { await stopChild(portForward); } catch (error) { cleanupErrors.push(error); }
  }
  if (bridgeExecId) {
    try { await manager.cancel(taskId, agentId, profile, bridgeExecId); } catch (error) { cleanupErrors.push(error); }
  }
  if (backendId) {
    try { await manager.release(taskId, agentId, profile); } catch (error) { cleanupErrors.push(error); }
    try {
      let instance = await provider.inspect(backendId);
      for (let attempt = 0; instance && attempt < 20; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        instance = await provider.inspect(backendId);
      }
      if (instance) cleanupErrors.push(new Error(`Runner backend ${backendId} still exists after release`));
      const owned = (await provider.list()).filter((candidate) => candidate.id.startsWith(`archie-${loaded.config.instanceId}-`));
      if (owned.some((candidate) => candidate.id === backendId)) cleanupErrors.push(new Error(`Runner backend ${backendId} remains in owned inventory`));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  manager.shutdown();

  if (artifactPath && artifactEvidence) {
    const fixtureFiles = await Promise.all(['swc.app.tgz', 'axe.tgz', 'mjpeg_bridge.py'].map(async (name) => ({
      name,
      bytes: (await stat(join(fixtureRepo, name))).size,
      sha256: sha256(await readFile(join(fixtureRepo, name))),
    })));
    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskId,
      backendId,
      archie: { commit: archieCommit },
      fixture: { commit: fixtureCommit.trim(), github: fixtureGithub, appBuildRef, files: fixtureFiles },
      runner: { profile, image: profileConfig.image, orchardVersion, runtime, deviceType, bundleId },
      axe: { version: axeVersion },
      artifacts: artifactEvidence,
      externalStream: externalStream ?? { status: 'not-requested' },
      cleanup: { verified: cleanupErrors.length === 0 },
    };
    await writeFile(join(artifactPath, '.archie-e2e', 'results', 'evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`RUNNER_EVIDENCE=${join(artifactPath, '.archie-e2e', 'results', 'evidence.json')}`);
  }

  const failures = [...(failure ? [failure] : []), ...cleanupErrors];
  if (failures.length > 0) throw new AggregateError(failures, `Sweatcoin canary failed with ${failures.length} error(s)`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch((error) => {
    console.error(error);
    if (!process.exitCode) process.exitCode = 1;
  });
}
