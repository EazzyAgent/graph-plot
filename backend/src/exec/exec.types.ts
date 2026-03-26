import type {
  LlmReasoningEffort,
  LlmToolTraceEntry,
  LlmUsage,
} from '../llm/llm.types';

export const EXEC_RUNTIMES = ['python', 'bash', 'powershell', 'shell'] as const;

export const EXEC_LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;

export const EXEC_STATUSES = ['completed', 'failed', 'timed_out'] as const;

export const EXEC_PLOT_RENDER_PROFILES = ['draft', 'final'] as const;

export const EXEC_PLOT_WORKFLOW_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

export const EXEC_PLOT_WORKFLOW_STEP_KINDS = ['llm', 'exec'] as const;

export const EXEC_PLOT_WORKFLOW_STEP_STATUSES = [
  'running',
  'completed',
  'failed',
] as const;

export type ExecRuntime = (typeof EXEC_RUNTIMES)[number];
export type ExecLogStream = (typeof EXEC_LOG_STREAMS)[number];
export type ExecStatus = (typeof EXEC_STATUSES)[number];
export type ExecResolvedRuntime = Exclude<ExecRuntime, 'shell'>;
export type ExecPlotRenderProfile = (typeof EXEC_PLOT_RENDER_PROFILES)[number];
export type ExecPlotWorkflowStatus =
  (typeof EXEC_PLOT_WORKFLOW_STATUSES)[number];
export type ExecPlotWorkflowStepKind =
  (typeof EXEC_PLOT_WORKFLOW_STEP_KINDS)[number];
export type ExecPlotWorkflowStepStatus =
  (typeof EXEC_PLOT_WORKFLOW_STEP_STATUSES)[number];

export interface ExecRunRequestBody {
  runtime: string;
  code: string;
  timeoutMs?: number;
  args?: string[];
}

export interface ExecPlotRequestBody {
  code: string;
  timeoutMs?: number;
  installMissingPackages?: boolean;
  renderProfile?: ExecPlotRenderProfile;
}

export interface StartExecPlotWorkflowRequestBody {
  provider: string;
  model: string;
  reviewModel?: string;
  prompt: string;
  contextPath?: string;
  enableFileSystemTools?: boolean;
  reasoningEffort?: LlmReasoningEffort;
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

export interface ExecArtifact {
  kind: 'image';
  filename: string;
  mimeType: string;
  base64: string;
  byteSize: number;
}

export interface ExecPlotFigureLayoutDiagnostics {
  filename: string;
  widthPx: number;
  heightPx: number;
  axesCount: number;
  textElementCount: number;
  visibleTextElementCount: number;
  clippedTextCount: number;
  overlappingTextPairCount: number;
  verySmallTextCount: number;
  minFontSize?: number;
  maxFontSize?: number;
  averageFontSize?: number;
}

export interface ExecPlotLayoutDiagnostics {
  totalFigureCount: number;
  totalAxesCount: number;
  totalTextElementCount: number;
  totalVisibleTextElementCount: number;
  totalClippedTextCount: number;
  totalOverlappingTextPairCount: number;
  totalVerySmallTextCount: number;
  figures: ExecPlotFigureLayoutDiagnostics[];
}

export interface ExecPlotSandboxStatus {
  available: boolean;
  bootstrapped: boolean;
  command?: string;
  packageDirectory: string;
  requiredPackages: string[];
}

export interface ExecPlotCapabilitiesResponse {
  os: NodeJS.Platform;
  sandbox: ExecPlotSandboxStatus;
}

export interface ExecPlotResponse extends ExecRunResponse {
  renderProfile: ExecPlotRenderProfile;
  sandbox: ExecPlotSandboxStatus;
  artifacts: ExecArtifact[];
  layoutDiagnostics?: ExecPlotLayoutDiagnostics;
}

export interface ExecPlotWorkflowRequest {
  provider: string;
  model: string;
  reviewModel?: string;
  prompt: string;
  contextPath?: string;
  enableFileSystemTools: boolean;
  reasoningEffort?: LlmReasoningEffort;
}

export interface StartExecPlotWorkflowResponse {
  jobId: string;
  status: Extract<ExecPlotWorkflowStatus, 'queued' | 'running'>;
}

export interface ExecPlotWorkflowLlmDetails {
  provider: string;
  model: string;
  responseId?: string;
  finishReason?: string;
  text: string;
  usage: LlmUsage;
  toolTrace?: LlmToolTraceEntry[];
  parsed?: unknown;
}

export interface ExecPlotWorkflowStepBase {
  id: string;
  kind: ExecPlotWorkflowStepKind;
  label: string;
  attempt: number;
  status: ExecPlotWorkflowStepStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ExecPlotWorkflowLlmStep extends ExecPlotWorkflowStepBase {
  kind: 'llm';
  llm?: ExecPlotWorkflowLlmDetails;
}

export interface ExecPlotWorkflowExecStep extends ExecPlotWorkflowStepBase {
  kind: 'exec';
  exec?: ExecPlotResponse;
}

export type ExecPlotWorkflowStep =
  | ExecPlotWorkflowLlmStep
  | ExecPlotWorkflowExecStep;

export interface ExecPlotWorkflowJob {
  jobId: string;
  status: ExecPlotWorkflowStatus;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  request: ExecPlotWorkflowRequest;
  draftCode: string;
  finalCode: string;
  critique: string;
  reflection: string;
  draftArtifacts: ExecArtifact[];
  finalArtifacts: ExecArtifact[];
  steps: ExecPlotWorkflowStep[];
  terminalError?: string;
}
