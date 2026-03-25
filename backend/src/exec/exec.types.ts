export const EXEC_RUNTIMES = ['python', 'bash', 'powershell', 'shell'] as const;

export const EXEC_LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;

export const EXEC_STATUSES = ['completed', 'failed', 'timed_out'] as const;

export type ExecRuntime = (typeof EXEC_RUNTIMES)[number];
export type ExecLogStream = (typeof EXEC_LOG_STREAMS)[number];
export type ExecStatus = (typeof EXEC_STATUSES)[number];
export type ExecResolvedRuntime = Exclude<ExecRuntime, 'shell'>;

export interface ExecRunRequestBody {
  runtime: string;
  code: string;
  timeoutMs?: number;
  args?: string[];
}

export interface ExecLogEntry {
  stream: ExecLogStream;
  text: string;
  timestamp: string;
}

export interface ExecRuntimeCapability {
  runtime: ExecRuntime;
  resolvedRuntime: ExecResolvedRuntime;
  defaultForOs: boolean;
  available: boolean;
  command?: string;
  description: string;
}

export interface ExecCapabilitiesResponse {
  os: NodeJS.Platform;
  defaultShellRuntime: Exclude<ExecRuntime, 'python' | 'shell'>;
  runtimes: ExecRuntimeCapability[];
}

export interface ExecRunResponse {
  requestedRuntime: ExecRuntime;
  resolvedRuntime: ExecResolvedRuntime;
  os: NodeJS.Platform;
  command: string;
  commandArgs: string[];
  workingDirectory: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ExecStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  logs: ExecLogEntry[];
  errors: string[];
}
