#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadRunnerConfig } from './config.js';
import { RunnerManager } from './manager.js';
import { OrchardRunnerProvider } from './orchard-provider.js';
import { assertRelativeRunnerPath } from './transfer.js';
import { generateTaskId } from '../tasks/persistence.js';

const execFileAsync = promisify(execFile);
const resultRoot = '.archie-full-cycle';

export interface IosFullCycleSpec {
  profile: string;
  agentId: string;
  sourceRepo: string;
  sourceGithub: string;
  sourceCommit: string;
  project?: string;
  workspace?: string;
  scheme: string;
  configuration: string;
  bundleId: string;
  appPath: string;
  runtime: string;
  deviceType: string;
  processName: string;
  breakpoint: string;
  debugSteps: number;
  debugVariable: string;
  expectedDebugValue: string;
  crashMarker: string;
  xcodeArguments: string[];
  launchArguments: string[];
  crashArguments: string[];
  minTests: number;
  holdSeconds: number;
  timeoutSeconds: number;
}

export interface XcresultTestSummary {
  result: string;
  totalTestCount: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedText(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  if (Buffer.byteLength(value) > 1024 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} contains unsupported characters or exceeds 1 KiB`);
  }
  return value;
}

function boundedInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stringArray(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (!raw) return fallback;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => typeof entry !== 'string' || Buffer.byteLength(entry) > 4096 || entry.includes('\0'))) {
    throw new Error(`${name} must contain at most 64 strings of at most 4 KiB`);
  }
  return value as string[];
}

function runnerPath(env: NodeJS.ProcessEnv, name: string, fallback?: string): string | undefined {
  const value = env[name] ?? fallback;
  return value ? assertRelativeRunnerPath(value) : undefined;
}

export function loadIosFullCycleSpec(env: NodeJS.ProcessEnv): IosFullCycleSpec {
  const project = runnerPath(env, 'ARCHIE_IOS_E2E_PROJECT');
  const workspace = runnerPath(env, 'ARCHIE_IOS_E2E_WORKSPACE');
  if ((project ? 1 : 0) + (workspace ? 1 : 0) !== 1) {
    throw new Error('Exactly one of ARCHIE_IOS_E2E_PROJECT or ARCHIE_IOS_E2E_WORKSPACE is required');
  }
  const sourceGithub = required(env, 'ARCHIE_IOS_E2E_GITHUB');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceGithub)) {
    throw new Error('ARCHIE_IOS_E2E_GITHUB must be in owner/repository form');
  }
  const sourceCommit = required(env, 'ARCHIE_IOS_E2E_COMMIT').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('ARCHIE_IOS_E2E_COMMIT must be a full Git commit SHA');
  const appPath = runnerPath(env, 'ARCHIE_IOS_E2E_APP_PATH');
  if (!appPath?.startsWith(`${resultRoot}/DerivedData/`) || !appPath.endsWith('.app')) {
    throw new Error(`ARCHIE_IOS_E2E_APP_PATH must name an app below ${resultRoot}/DerivedData`);
  }
  return {
    profile: boundedText(env, 'ARCHIE_IOS_E2E_PROFILE'),
    agentId: boundedText(env, 'ARCHIE_IOS_E2E_AGENT'),
    sourceRepo: resolve(required(env, 'ARCHIE_IOS_E2E_REPO')),
    sourceGithub,
    sourceCommit,
    project,
    workspace,
    scheme: boundedText(env, 'ARCHIE_IOS_E2E_SCHEME'),
    configuration: boundedText(env, 'ARCHIE_IOS_E2E_CONFIGURATION', 'Debug'),
    bundleId: boundedText(env, 'ARCHIE_IOS_E2E_BUNDLE_ID'),
    appPath,
    runtime: boundedText(env, 'ARCHIE_IOS_E2E_RUNTIME'),
    deviceType: boundedText(env, 'ARCHIE_IOS_E2E_DEVICE_TYPE', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17'),
    processName: boundedText(env, 'ARCHIE_IOS_E2E_PROCESS_NAME'),
    breakpoint: boundedText(env, 'ARCHIE_IOS_E2E_BREAKPOINT', 'archieDebugCheckpoint'),
    debugSteps: boundedInteger(env, 'ARCHIE_IOS_E2E_DEBUG_STEPS', 2, 0, 20),
    debugVariable: boundedText(env, 'ARCHIE_IOS_E2E_DEBUG_VARIABLE', 'nonce'),
    expectedDebugValue: boundedText(env, 'ARCHIE_IOS_E2E_EXPECTED_DEBUG_VALUE', 'ARCHIE_FULL_CYCLE_NONCE'),
    crashMarker: boundedText(env, 'ARCHIE_IOS_E2E_CRASH_MARKER', 'ARCHIE_FULL_CYCLE_CRASH'),
    xcodeArguments: stringArray(env, 'ARCHIE_IOS_E2E_XCODE_ARGUMENTS', []),
    launchArguments: stringArray(env, 'ARCHIE_IOS_E2E_LAUNCH_ARGUMENTS', ['--archie-debug-loop']),
    crashArguments: stringArray(env, 'ARCHIE_IOS_E2E_CRASH_ARGUMENTS', ['--archie-crash']),
    minTests: boundedInteger(env, 'ARCHIE_IOS_E2E_MIN_TESTS', 2, 1, 100000),
    holdSeconds: boundedInteger(env, 'ARCHIE_IOS_E2E_HOLD_SECONDS', 0, 0, 3600),
    timeoutSeconds: boundedInteger(env, 'ARCHIE_IOS_E2E_TIMEOUT_SECONDS', 3600, 60, 14400),
  };
}

export function xcodeContainerArguments(spec: Pick<IosFullCycleSpec, 'project' | 'workspace'>): string[] {
  if (spec.project) return ['-project', spec.project];
  if (spec.workspace) return ['-workspace', spec.workspace];
  throw new Error('An Xcode project or workspace is required');
}

function numericField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) throw new Error(`xcresult summary has invalid ${name}`);
  return field;
}

export function parseXcresultTestSummary(value: unknown): XcresultTestSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('xcresult test summary must be an object');
  const summary = value as Record<string, unknown>;
  if (typeof summary.result !== 'string') throw new Error('xcresult test summary has invalid result');
  return {
    result: summary.result,
    totalTestCount: numericField(summary, 'totalTestCount'),
    passedTests: numericField(summary, 'passedTests'),
    failedTests: numericField(summary, 'failedTests'),
    skippedTests: numericField(summary, 'skippedTests'),
  };
}

export function validateLldbTranscript(transcript: string, expectedValue: string): void {
  const expected = [
    /stop reason = breakpoint/i,
    /thread #\d+/i,
    /detached/i,
    new RegExp(expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ];
  for (const pattern of expected) {
    if (!pattern.test(transcript)) throw new Error(`LLDB transcript is missing ${pattern}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

async function sourceManifest(root: string): Promise<{ commit: string; digest: string; files: number }> {
  const [{ stdout: commitOutput }, { stdout: statusOutput }, { stdout: filesOutput }] = await Promise.all([
    execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']),
    execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all']),
    execFileAsync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
  ]);
  const commit = commitOutput.toString().trim();
  if (statusOutput.toString().trim()) throw new Error('iOS E2E source checkout must be clean so its commit identifies every transferred byte');
  const paths = Buffer.from(filesOutput).toString('utf8').split('\0').filter(Boolean)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (paths.some((path) => path === resultRoot || path.startsWith(`${resultRoot}/`))) {
    throw new Error(`${resultRoot} is reserved for iOS E2E outputs`);
  }
  const hash = createHash('sha256');
  let files = 0;
  for (const path of paths) {
    const absolute = resolve(root, path);
    const entry = await lstat(absolute);
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    files += 1;
    const data = entry.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    hash.update(entry.isSymbolicLink() ? 'L\0' : 'F\0');
    hash.update(path);
    hash.update('\0');
    hash.update(String(data.length));
    hash.update('\0');
    hash.update(data);
  }
  return { commit, digest: hash.digest('hex'), files };
}

async function archieBuildCommit(env: NodeJS.ProcessEnv): Promise<string> {
  const supplied = env.ARCHIE_BUILD_COMMIT ?? env.GITHUB_SHA;
  if (supplied) {
    if (!/^[a-f0-9]{40}$/i.test(supplied)) throw new Error('ARCHIE_BUILD_COMMIT must be a full Git commit SHA');
    return supplied.toLowerCase();
  }
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD']),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (status.toString().trim()) throw new Error('ARCHIE_BUILD_COMMIT is required when the Archie checkout is not clean');
  return commit.toString().trim();
}

function remoteManifestPython(): string {
  return String.raw`import hashlib,os,pathlib,sys
root=pathlib.Path(sys.argv[1])
paths=sorted((p for p in root.rglob('*') if (p.is_file() or p.is_symlink()) and '.archie-full-cycle' not in p.parts),key=lambda p:p.relative_to(root).as_posix().encode())
h=hashlib.sha256()
for path in paths:
    relative=path.relative_to(root).as_posix()
    linked=path.is_symlink()
    data=os.readlink(path).encode() if linked else path.read_bytes()
    h.update(b'L\0' if linked else b'F\0')
    h.update(relative.encode())
    h.update(b'\0')
    h.update(str(len(data)).encode())
    h.update(b'\0')
    h.update(data)
print(f'{len(paths)} {h.hexdigest()}')`;
}

function setupScript(spec: IosFullCycleSpec, manifest: { digest: string; files: number }): string {
  return String.raw`set -euo pipefail
root=${shellQuote(resultRoot)}
rm -rf "$root"
mkdir -p "$root/results" "$root/DerivedData"
manifest=$(/usr/bin/python3 -c ${shellQuote(remoteManifestPython())} .)
expected_manifest=${shellQuote(`${manifest.files} ${manifest.digest}`)}
if [ "$manifest" != "$expected_manifest" ]; then
  printf 'Source manifest mismatch\nexpected: %s\nactual:   %s\n' "$expected_manifest" "$manifest" >&2
  exit 1
fi
printf '%s\n' "$manifest" > "$root/results/source-manifest.txt"
/usr/bin/xcodebuild -version > "$root/results/xcode-version.txt"
/usr/bin/xcrun simctl list runtimes > "$root/results/simulator-runtimes.txt"
udid=$(/usr/bin/xcrun simctl create 'Archie Full Cycle E2E' ${shellQuote(spec.deviceType)} ${shellQuote(spec.runtime)})
printf '%s\n' "$udid" > "$root/udid"
/usr/bin/xcrun simctl boot "$udid"
/usr/bin/xcrun simctl bootstatus "$udid" -b
printf 'UDID=%s\nSOURCE_MANIFEST=%s\n' "$udid" "$manifest"`;
}

function xcodeScript(spec: IosFullCycleSpec): string {
  const common = [
    ...xcodeContainerArguments(spec),
    '-scheme', spec.scheme,
    '-configuration', spec.configuration,
    ...spec.xcodeArguments,
  ];
  const commonCommand = shellCommand(common);
  return String.raw`set -euo pipefail
root=${shellQuote(resultRoot)}
udid=$(/bin/cat "$root/udid")
destination="platform=iOS Simulator,id=$udid"
run_logged() {
  log="$1"
  shift
  set +e
  "$@" > "$log" 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then /usr/bin/tail -n 200 "$log" >&2; return "$status"; fi
}
run_logged "$root/results/build.log" /usr/bin/xcodebuild ${commonCommand} -destination "$destination" -derivedDataPath "$root/DerivedData" -resultBundlePath "$root/results/build.xcresult" CODE_SIGNING_ALLOWED=NO build-for-testing
/usr/bin/xcrun xcresulttool get build-results summary --path "$root/results/build.xcresult" --format json > "$root/results/build-summary.json"
run_logged "$root/results/test.log" /usr/bin/xcodebuild ${commonCommand} -destination "$destination" -derivedDataPath "$root/DerivedData" -resultBundlePath "$root/results/test.xcresult" CODE_SIGNING_ALLOWED=NO test-without-building
/usr/bin/xcrun xcresulttool get test-results summary --path "$root/results/test.xcresult" --format json > "$root/results/test-summary.json"
/usr/bin/python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value["result"] == "Passed" and value["failedTests"] == 0 and value["totalTestCount"] >= int(sys.argv[2]), value' "$root/results/test-summary.json" ${shellQuote(String(spec.minTests))}
printf 'BUILD_AND_TEST_SUCCEEDED\n'`;
}

function launchScript(spec: IosFullCycleSpec): string {
  return String.raw`set -euo pipefail
root=${shellQuote(resultRoot)}
udid=$(/bin/cat "$root/udid")
app=${shellQuote(spec.appPath)}
test -d "$app"
actual_bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
test "$actual_bundle" = ${shellQuote(spec.bundleId)}
/usr/bin/xcrun simctl install "$udid" "$app"
launch=$(/usr/bin/xcrun simctl launch --terminate-running-process "$udid" ${shellQuote(spec.bundleId)} ${shellCommand(spec.launchArguments)})
pid=$(printf '%s\n' "$launch" | /usr/bin/awk '{print $NF}')
case "$pid" in *[!0-9]*|'') echo 'Invalid app PID' >&2; exit 1;; esac
printf '%s\n' "$pid" > "$root/pid"
/bin/sleep 2
/usr/bin/xcrun simctl io "$udid" screenshot "$root/results/app.png"
printf 'PID=%s\nBUNDLE_ID=%s\n' "$pid" "$actual_bundle"`;
}

function lldbScript(spec: IosFullCycleSpec): string {
  const stepCommands = Array.from({ length: spec.debugSteps }, () => "  -o 'thread step-over' \\").join('\n');
  return String.raw`set -euo pipefail
root=${shellQuote(resultRoot)}
pid=$(/bin/cat "$root/pid")
/usr/bin/xcrun lldb --batch \
  -o "process attach --pid $pid" \
  -o ${shellQuote(`breakpoint set --name ${spec.breakpoint}`)} \
  -o 'process continue' \
${stepCommands}
  -o ${shellQuote(`frame variable ${spec.debugVariable}`)} \
  -o 'thread backtrace -c 8' \
  -o 'process detach' \
  -o 'quit' 2>&1 | /usr/bin/tee "$root/results/lldb.txt"`;
}

function crashScript(spec: IosFullCycleSpec): string {
  return String.raw`set -euo pipefail
root=${shellQuote(resultRoot)}
udid=$(/bin/cat "$root/udid")
marker="$root/crash-marker"
rm -f "$root/results/crash.ips" "$root/results/unified.log"
/usr/bin/xcrun simctl terminate "$udid" ${shellQuote(spec.bundleId)} 2>/dev/null || true
/usr/bin/touch "$marker"
launch=$(/usr/bin/xcrun simctl launch "$udid" ${shellQuote(spec.bundleId)} ${shellCommand(spec.crashArguments)})
pid=$(printf '%s\n' "$launch" | /usr/bin/awk '{print $NF}')
case "$pid" in *[!0-9]*|'') echo 'Invalid crash PID' >&2; exit 1;; esac
attempt=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  if [ "$attempt" -ge 60 ]; then echo 'App did not crash within 30 seconds' >&2; exit 1; fi
  attempt=$((attempt + 1))
  /bin/sleep 0.5
done
/usr/bin/xcrun simctl spawn "$udid" log show --style compact --last 5m --predicate ${shellQuote(`process == "${spec.processName}"`)} > "$root/results/unified.log" 2>&1 || true
attempt=0
report=''
while [ -z "$report" ]; do
  report=$(/usr/bin/find "$HOME/Library/Logs/DiagnosticReports" "$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/Library/Logs/CrashReporter" -type f \( -name ${shellQuote(`${spec.processName}*.ips`)} -o -name ${shellQuote(`${spec.processName}*.crash`)} \) -newer "$marker" -print 2>/dev/null | /usr/bin/head -n 1)
  if [ -n "$report" ]; then break; fi
  if [ "$attempt" -ge 60 ]; then break; fi
  attempt=$((attempt + 1))
  /bin/sleep 0.5
done
if [ -z "$report" ]; then
  diagnose="$root/diagnose"
  rm -rf "$diagnose"
  /usr/bin/xcrun simctl diagnose -b --timeout=120 --no-archive --output="$diagnose" --udid="$udid" >/dev/null 2>&1 || true
  report=$(/usr/bin/find "$diagnose" -type f \( -name ${shellQuote(`${spec.processName}*.ips`)} -o -name ${shellQuote(`${spec.processName}*.crash`)} \) -print 2>/dev/null | /usr/bin/head -n 1)
fi
/usr/bin/grep -F ${shellQuote(spec.crashMarker)} "$root/results/unified.log" >/dev/null
if [ -n "$report" ]; then
  /bin/cp "$report" "$root/results/crash.ips"
  /usr/bin/grep -F ${shellQuote(spec.processName)} "$root/results/crash.ips" >/dev/null
  printf 'CRASH_REPORT_KIND=ips\nCRASH_REPORT=%s\n' "$report"
else
  printf 'process=%s\npid=%s\nmarker=%s\nsource=simulator-unified-log\n' ${shellQuote(spec.processName)} "$pid" ${shellQuote(spec.crashMarker)} > "$root/results/crash-report.txt"
  /usr/bin/grep -F ${shellQuote(spec.crashMarker)} "$root/results/unified.log" | /usr/bin/tail -n 20 >> "$root/results/crash-report.txt"
  printf 'CRASH_REPORT_KIND=unified-log\n'
fi`;
}

function simulatorCleanupScript(): string {
  return String.raw`set -eu
root=${shellQuote(resultRoot)}
if [ -s "$root/udid" ]; then
  udid=$(/bin/cat "$root/udid")
  /usr/bin/xcrun simctl shutdown "$udid" 2>/dev/null || true
  /usr/bin/xcrun simctl delete "$udid"
fi`;
}

export function createIosFullCycleScripts(spec: IosFullCycleSpec, manifest: { digest: string; files: number }) {
  return {
    setup: setupScript(spec, manifest),
    xcode: xcodeScript(spec),
    launch: launchScript(spec),
    lldb: lldbScript(spec),
    crash: crashScript(spec),
    cleanup: simulatorCleanupScript(),
  };
}

async function validateArtifacts(root: string, spec: IosFullCycleSpec, manifest: { digest: string; files: number }) {
  const results = join(root, resultRoot, 'results');
  for (const bundle of ['build.xcresult', 'test.xcresult']) {
    if (!(await stat(join(results, bundle))).isDirectory()) throw new Error(`${bundle} is not a directory`);
  }
  const buildSummary = JSON.parse(await readFile(join(results, 'build-summary.json'), 'utf8')) as Record<string, unknown>;
  if (buildSummary.status !== 'succeeded' || buildSummary.errorCount !== 0) throw new Error('xcresult build summary is not successful');
  const testSummary = parseXcresultTestSummary(JSON.parse(await readFile(join(results, 'test-summary.json'), 'utf8')));
  if (testSummary.result !== 'Passed' || testSummary.failedTests !== 0 || testSummary.totalTestCount < spec.minTests) {
    throw new Error(`Expected at least ${spec.minTests} passing tests, received ${JSON.stringify(testSummary)}`);
  }
  const actualManifest = (await readFile(join(results, 'source-manifest.txt'), 'utf8')).trim();
  if (actualManifest !== `${manifest.files} ${manifest.digest}`) throw new Error('Collected source manifest does not match the synced checkout');
  const screenshot = await readFile(join(results, 'app.png'));
  if (!screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || screenshot.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Collected app screenshot is not a PNG');
  }
  const lldb = await readFile(join(results, 'lldb.txt'), 'utf8');
  validateLldbTranscript(lldb, spec.expectedDebugValue);
  let crashKind = 'ips';
  const crash = await readFile(join(results, 'crash.ips'), 'utf8').catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    crashKind = 'unified-log';
    return readFile(join(results, 'crash-report.txt'), 'utf8');
  });
  const unifiedLog = await readFile(join(results, 'unified.log'), 'utf8');
  if (!crash.includes(spec.processName)) throw new Error('Crash report does not identify the expected process');
  if (!`${crash}\n${unifiedLog}`.includes(spec.crashMarker)) throw new Error('Crash evidence is missing the deliberate crash marker');
  return {
    build: { status: buildSummary.status, errors: buildSummary.errorCount },
    tests: testSummary,
    screenshot: {
      bytes: screenshot.length,
      sha256: createHash('sha256').update(screenshot).digest('hex'),
      width: screenshot.readUInt32BE(16),
      height: screenshot.readUInt32BE(20),
    },
    lldb: { sha256: createHash('sha256').update(lldb).digest('hex'), breakpoint: spec.breakpoint, value: spec.expectedDebugValue },
    crash: { kind: crashKind, sha256: createHash('sha256').update(crash).digest('hex'), marker: spec.crashMarker },
  };
}

async function main(): Promise<void> {
  if (process.env.ARCHIE_IOS_FULL_CYCLE_E2E !== 'true') {
    throw new Error('ARCHIE_IOS_FULL_CYCLE_E2E=true is required because this canary provisions and deletes a real VM');
  }
  const spec = loadIosFullCycleSpec(process.env);
  const [manifest, archieCommit] = await Promise.all([
    sourceManifest(spec.sourceRepo),
    archieBuildCommit(process.env),
  ]);
  if (manifest.commit !== spec.sourceCommit) throw new Error('iOS E2E checkout does not match ARCHIE_IOS_E2E_COMMIT');
  const scripts = createIosFullCycleScripts(spec, manifest);

  const loaded = await loadRunnerConfig();
  if (!loaded) throw new Error('ARCHIE_RUNNERS_CONFIG is required');
  const profile = loaded.config.profiles[spec.profile];
  if (!profile) throw new Error(`Unknown runner profile ${spec.profile}`);
  if (profile.os !== 'darwin') throw new Error('The iOS full-cycle canary requires a Darwin runner profile');
  if (spec.holdSeconds > profile.maxDebugTtlMinutes * 60) {
    throw new Error(`ARCHIE_IOS_E2E_HOLD_SECONDS exceeds the ${profile.maxDebugTtlMinutes}-minute profile debug cap`);
  }

  const provider = new OrchardRunnerProvider(loaded.config.orchard.baseUrl, loaded.serviceAccountName, loaded.serviceAccountToken);
  const manager = new RunnerManager(loaded, provider);
  const taskId = generateTaskId();
  const transferAbort = new AbortController();
  let backendId: string | undefined;
  let activeExecId: string | undefined;
  let synced = false;
  let simulatorCreated = false;
  let artifactPath: string | undefined;
  let artifactEvidence: Awaited<ReturnType<typeof validateArtifacts>> | undefined;
  let failure: unknown;
  let interrupted = false;
  let interruptionReason = '';
  let resolveInterruption!: () => void;
  const interruption = new Promise<void>((resolvePromise) => { resolveInterruption = resolvePromise; });
  let interruptCancel: Promise<void> | undefined;

  const requestInterruption = (reason: string, exitCode: number) => {
    if (interrupted) return;
    interrupted = true;
    interruptionReason = reason;
    process.exitCode = exitCode;
    transferAbort.abort(new Error(reason));
    resolveInterruption();
    if (activeExecId && backendId) {
      interruptCancel = manager.cancel(taskId, spec.agentId, spec.profile, activeExecId);
      void interruptCancel.catch(() => {});
    }
  };
  const onSignal = (signal: NodeJS.Signals) => requestInterruption(`received ${signal}`, 130);
  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
  for (const signal of signals) process.once(signal, onSignal);
  const deadlineTimer = setTimeout(() => requestInterruption(`exceeded ${spec.timeoutSeconds}-second deadline`, 1), spec.timeoutSeconds * 1000);

  const run = async (script: string, permitInterrupted = false): Promise<{ stdout: string; stderr: string }> => {
    if (interrupted && !permitInterrupted) throw new Error(`iOS full-cycle canary interrupted: ${interruptionReason}`);
    const requestId = randomUUID();
    activeExecId = requestId;
    try {
      let page = await manager.exec(taskId, spec.agentId, spec.profile, spec.sourceGithub, ['/bin/bash', '-lc', script], '.', {}, 5, requestId);
      const stdout = [page.stdout];
      const stderr = [page.stderr];
      while (page.state === 'running' || page.hasMore) {
        if (interrupted && !permitInterrupted) throw new Error(`iOS full-cycle canary interrupted: ${interruptionReason}`);
        page = await manager.poll(taskId, spec.agentId, spec.profile, requestId, page.cursor, 5);
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

  try {
    const lease = await manager.ensure(taskId, spec.agentId, spec.profile);
    backendId = lease.backendId;
    const transfer = await manager.sync(taskId, spec.agentId, spec.profile, spec.sourceGithub, spec.sourceRepo, transferAbort.signal);
    synced = true;
    console.log(JSON.stringify({ phase: 'synced', taskId, backendId, commit: manifest.commit, manifest: manifest.digest, bytes: transfer.bytes, files: transfer.files }));

    const setup = await run(scripts.setup);
    simulatorCreated = true;
    console.log(JSON.stringify({ phase: 'simulator-ready', output: setup.stdout.trim() }));

    await run(scripts.xcode);
    console.log(JSON.stringify({ phase: 'built-and-tested', minimumTests: spec.minTests }));

    const launched = await run(scripts.launch);
    console.log(JSON.stringify({ phase: 'launched', output: launched.stdout.trim() }));

    const debugged = await run(scripts.lldb);
    validateLldbTranscript(debugged.stdout, spec.expectedDebugValue);
    console.log(JSON.stringify({ phase: 'debugged', breakpoint: spec.breakpoint, value: spec.expectedDebugValue }));

    if (spec.holdSeconds > 0) {
      const debug = await manager.openDebug(taskId, spec.agentId, spec.profile, Math.ceil(spec.holdSeconds / 60));
      console.log(`RUNNER_DEBUG_HANDOFF=${JSON.stringify({ taskId, holdSeconds: spec.holdSeconds, ...debug })}`);
      let holdTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolvePromise) => { holdTimer = setTimeout(resolvePromise, spec.holdSeconds * 1000); }),
          interruption,
        ]);
      } finally {
        if (holdTimer) clearTimeout(holdTimer);
      }
      if (interrupted) throw new Error(`iOS full-cycle canary interrupted: ${interruptionReason}`);
    }

    const crashed = await run(scripts.crash);
    console.log(JSON.stringify({ phase: 'crash-captured', output: crashed.stdout.trim() }));

    artifactPath = await manager.collect(taskId, spec.agentId, spec.profile, spec.sourceGithub, [`${resultRoot}/results`], transferAbort.signal);
    artifactEvidence = await validateArtifacts(artifactPath, spec, manifest);
  } catch (error) {
    failure = error;
    if (synced && !artifactPath) {
      try {
        artifactPath = await manager.collect(taskId, spec.agentId, spec.profile, spec.sourceGithub, [`${resultRoot}/results`]);
      } catch {}
    }
  }

  clearTimeout(deadlineTimer);
  for (const signal of signals) process.off(signal, onSignal);
  const cleanupErrors: unknown[] = [];
  if (interruptCancel) {
    try { await interruptCancel; } catch (error) { cleanupErrors.push(error); }
  }
  if (simulatorCreated) {
    try { await run(scripts.cleanup, true); } catch (error) { cleanupErrors.push(error); }
  }
  if (backendId) {
    try { await manager.release(taskId, spec.agentId, spec.profile); } catch (error) { cleanupErrors.push(error); }
    try {
      let instance = await provider.inspect(backendId);
      for (let attempt = 0; instance && attempt < 20; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        instance = await provider.inspect(backendId);
      }
      if (instance) cleanupErrors.push(new Error(`Runner backend ${backendId} still exists after release`));
      if ((await provider.list()).some((candidate) => candidate.id === backendId)) {
        cleanupErrors.push(new Error(`Runner backend ${backendId} remains in Orchard inventory`));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  manager.shutdown();

  if (artifactPath && artifactEvidence) {
    const evidence = {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskId,
      backendId,
      archie: { commit: archieCommit },
      source: { github: spec.sourceGithub, commit: manifest.commit, manifestSha256: manifest.digest, files: manifest.files },
      runner: { profile: spec.profile, image: profile.image, runtime: spec.runtime, deviceType: spec.deviceType },
      app: { project: spec.project, workspace: spec.workspace, scheme: spec.scheme, configuration: spec.configuration, bundleId: spec.bundleId },
      artifacts: artifactEvidence,
      cleanup: { simulatorDeleted: simulatorCreated && cleanupErrors.length === 0, backendDeleted: backendId !== undefined && cleanupErrors.length === 0 },
    };
    const evidencePath = join(artifactPath, resultRoot, 'results', 'evidence.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`RUNNER_EVIDENCE=${evidencePath}`);
  }

  const failures = [...(failure ? [failure] : []), ...cleanupErrors];
  if (failures.length > 0) throw new AggregateError(failures, `iOS full-cycle canary failed with ${failures.length} error(s)`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch((error) => {
    console.error(error);
    if (!process.exitCode) process.exitCode = 1;
  });
}
