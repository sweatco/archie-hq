export type RunnerLeaseState = 'provisioning' | 'ready' | 'failed' | 'releasing';
export type RunnerExecState = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface RunnerProfile {
  image: string;
  os: 'darwin' | 'linux';
  cpu: number;
  memoryMiB: number;
  diskGiB: number;
  username: string;
  passwordEnv: string;
  allowedAgents: string[];
  labels: Record<string, string>;
  resources: Record<string, number>;
  softnetAllow: string[];
  readinessCommand?: string[];
  remoteWorkspaceRoot?: string;
  leaseTtlMinutes: number;
  debugTtlMinutes: number;
  maxDebugTtlMinutes: number;
  execTimeoutSeconds: number;
  provisionTimeoutSeconds: number;
  readinessTimeoutSeconds: number;
  maxExecWaitSeconds: number;
  maxExecOutputBytes: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
}

export interface RunnerConfig {
  version: 1;
  instanceId: string;
  maxConcurrent: number;
  orphanGraceMinutes: number;
  reaperIntervalSeconds: number;
  orchard: {
    baseUrl: string;
    context: string;
  };
  profiles: Record<string, RunnerProfile>;
}

export interface LoadedRunnerConfig {
  config: RunnerConfig;
  serviceAccountName: string;
  serviceAccountToken: string;
  guestPasswords: Record<string, string>;
}

export interface RunnerInstance {
  id: string;
  status: 'pending' | 'running' | 'failed';
  statusMessage?: string;
  worker?: string;
}

export interface RunnerSpec {
  id: string;
  image: string;
  os: 'darwin' | 'linux';
  cpu: number;
  memoryMiB: number;
  diskGiB: number;
  username: string;
  password: string;
  labels: Record<string, string>;
  resources: Record<string, number>;
  softnetAllow: string[];
}

export interface ExecRequest {
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sessionId: string;
  reconnectFrom?: number;
  stdin?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export type ExecEvent =
  | { type: 'stdout' | 'stderr'; data: Uint8Array; watermark?: number }
  | { type: 'exit'; code: number; watermark?: number }
  | { type: 'error'; error: string; watermark?: number }
  | { type: 'history_end'; watermark: number };

export interface RunnerProvider {
  provision(spec: RunnerSpec): Promise<RunnerInstance>;
  inspect(id: string): Promise<RunnerInstance | null>;
  list(): Promise<RunnerInstance[]>;
  exec(id: string, request: ExecRequest): AsyncIterable<ExecEvent>;
  closeExec(id: string, sessionId: string): Promise<void>;
  release(id: string): Promise<void>;
}

export interface RunnerExecSession {
  id: string;
  sessionId: string;
  state: RunnerExecState;
  watermark: number;
  outputBytes: number;
  startedAt: string;
  deadlineAt: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface SyncedRepository {
  github: string;
  remotePath: string;
  syncedAt: string;
}

export interface RunnerLease {
  id: string;
  taskId: string;
  agentId: string;
  profile: string;
  backendId: string;
  state: RunnerLeaseState;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  debugExpiresAt?: string;
  failure?: string;
  syncedRepos: Record<string, SyncedRepository>;
  execSessions: Record<string, RunnerExecSession>;
}

export interface RunnerLeaseFile {
  version: 1;
  leases: RunnerLease[];
}

export interface RunnerCommandResult {
  execId: string;
  state: RunnerExecState;
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface RunnerHealth {
  enabled: boolean;
  degraded: boolean;
  reason?: string;
  activeLeases: number;
}
