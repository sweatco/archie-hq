import { describe, expect, it } from 'vitest';
import {
  createIosFullCycleScripts,
  loadIosFullCycleSpec,
  parseXcresultTestSummary,
  validateLldbTranscript,
  xcodeContainerArguments,
} from '../ios-full-cycle-e2e.js';

const baseEnv: NodeJS.ProcessEnv = {
  ARCHIE_IOS_E2E_PROFILE: 'ios',
  ARCHIE_IOS_E2E_AGENT: 'mobile',
  ARCHIE_IOS_E2E_REPO: '/tmp/repo',
  ARCHIE_IOS_E2E_GITHUB: 'sweatco/archie-hq',
  ARCHIE_IOS_E2E_COMMIT: 'a'.repeat(40),
  ARCHIE_IOS_E2E_PROJECT: 'fixtures/ios-runner-app/RunnerFixture.xcodeproj',
  ARCHIE_IOS_E2E_SCHEME: 'RunnerFixture',
  ARCHIE_IOS_E2E_BUNDLE_ID: 'dev.archie.runner-fixture',
  ARCHIE_IOS_E2E_APP_PATH: '.archie-full-cycle/DerivedData/Build/Products/Debug-iphonesimulator/RunnerFixture.app',
  ARCHIE_IOS_E2E_RUNTIME: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  ARCHIE_IOS_E2E_PROCESS_NAME: 'RunnerFixture',
};

describe('iOS full-cycle canary contract', () => {
  it('loads a project fixture with bounded defaults', () => {
    const spec = loadIosFullCycleSpec(baseEnv);
    expect(spec.project).toBe('fixtures/ios-runner-app/RunnerFixture.xcodeproj');
    expect(spec.workspace).toBeUndefined();
    expect(spec.launchArguments).toEqual(['--archie-debug-loop']);
    expect(spec.crashArguments).toEqual(['--archie-crash']);
    expect(spec.debugSteps).toBe(2);
    expect(spec.crashMarker).toBe('ARCHIE_FULL_CYCLE_CRASH');
    expect(spec.minTests).toBe(2);
    expect(xcodeContainerArguments(spec)).toEqual(['-project', spec.project]);
  });

  it('accepts a workspace and rejects ambiguous or unsafe paths', () => {
    const env = { ...baseEnv, ARCHIE_IOS_E2E_PROJECT: undefined, ARCHIE_IOS_E2E_WORKSPACE: 'App.xcworkspace' };
    expect(xcodeContainerArguments(loadIosFullCycleSpec(env))).toEqual(['-workspace', 'App.xcworkspace']);
    expect(() => loadIosFullCycleSpec({ ...baseEnv, ARCHIE_IOS_E2E_WORKSPACE: 'App.xcworkspace' })).toThrow(/Exactly one/);
    expect(() => loadIosFullCycleSpec({ ...baseEnv, ARCHIE_IOS_E2E_PROJECT: '../App.xcodeproj' })).toThrow(/relative/);
    expect(() => loadIosFullCycleSpec({ ...baseEnv, ARCHIE_IOS_E2E_APP_PATH: 'build/App.app' })).toThrow(/DerivedData/);
  });

  it('validates JSON command arguments', () => {
    const spec = loadIosFullCycleSpec({
      ...baseEnv,
      ARCHIE_IOS_E2E_XCODE_ARGUMENTS: '["-only-testing:RunnerFixtureTests"]',
      ARCHIE_IOS_E2E_LAUNCH_ARGUMENTS: '["--flag","value"]',
    });
    expect(spec.xcodeArguments).toEqual(['-only-testing:RunnerFixtureTests']);
    expect(spec.launchArguments).toEqual(['--flag', 'value']);
    expect(() => loadIosFullCycleSpec({ ...baseEnv, ARCHIE_IOS_E2E_XCODE_ARGUMENTS: '{}' })).toThrow(/at most 64 strings/);
  });

  it('parses successful xcresult totals and rejects malformed fields', () => {
    expect(parseXcresultTestSummary({
      result: 'Passed', totalTestCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0,
    })).toEqual({ result: 'Passed', totalTestCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0 });
    expect(() => parseXcresultTestSummary({ result: 'Passed', totalTestCount: '2' })).toThrow(/totalTestCount/);
  });

  it('requires breakpoint, thread, value, and detach evidence from LLDB', () => {
    const transcript = 'thread #1, stop reason = breakpoint 1.1\nnonce = "ARCHIE_FULL_CYCLE_NONCE"\nProcess 42 detached';
    expect(() => validateLldbTranscript(transcript, 'ARCHIE_FULL_CYCLE_NONCE')).not.toThrow();
    expect(() => validateLldbTranscript(transcript.replace('detached', 'exited'), 'ARCHIE_FULL_CYCLE_NONCE')).toThrow(/detached/i);
  });

  it('builds the source, test, debugger, crash, and cleanup command contract', () => {
    const scripts = createIosFullCycleScripts(loadIosFullCycleSpec(baseEnv), { files: 10, digest: 'b'.repeat(64) });
    expect(scripts.setup).toContain('Source manifest mismatch');
    expect(scripts.xcode).toContain('build-for-testing');
    expect(scripts.xcode).toContain('test-without-building');
    expect(scripts.xcode).toContain('test.xcresult');
    expect(scripts.lldb.match(/thread step-over/g)).toHaveLength(2);
    expect(scripts.lldb).toContain('frame variable nonce');
    expect(scripts.crash).toContain('ARCHIE_FULL_CYCLE_CRASH');
    expect(scripts.crash).toContain('simctl diagnose');
    expect(scripts.cleanup).toContain('simctl delete');
  });
});
