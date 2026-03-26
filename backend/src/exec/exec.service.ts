import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecArtifact,
  ExecCapabilitiesResponse,
  ExecLogEntry,
  ExecPlotFigureLayoutDiagnostics,
  ExecPlotLayoutDiagnostics,
  ExecPlotRenderProfile,
  ExecPlotCapabilitiesResponse,
  ExecPlotRequestBody,
  ExecPlotResponse,
  ExecPlotSandboxStatus,
  ExecResolvedRuntime,
  ExecRunRequestBody,
  ExecRunResponse,
  ExecRuntime,
  ExecRuntimeCapability,
} from './exec.types';
import { EXEC_PLOT_RENDER_PROFILES, EXEC_RUNTIMES } from './exec.types';
import {
  getPlotRunnerScript,
  PLOT_DRAFT_DPI,
  PLOT_FINAL_DPI,
  PLOT_CODE_FILENAME,
  PLOT_INSTALL_TIMEOUT_MS,
  PLOT_METADATA_FILENAME,
  PLOT_PACKAGE_DIRECTORY_NAME,
  PLOT_REQUIRED_PACKAGES,
  PLOT_RUN_DIRECTORY_NAME,
  PLOT_RUNNER_FILENAME,
  PLOT_SMALL_TEXT_THRESHOLD_PT,
} from './plot-sandbox';

type JsonObject = Record<string, unknown>;

interface ExecCommandCandidate {
  command: string;
  execArgs: string[];
  extension: '.py' | '.sh' | '.ps1';
  probeArgs: string[];
}

interface NormalizedExecRunRequest {
  runtime: ExecRuntime;
  code: string;
  timeoutMs: number;
  args: string[];
}

interface NormalizedExecPlotRequest {
  code: string;
  timeoutMs: number;
  installMissingPackages: boolean;
  renderProfile: ExecPlotRenderProfile;
}

interface PlotOutputResult {
  artifacts: ExecArtifact[];
  layoutDiagnostics?: ExecPlotLayoutDiagnostics;
}

interface ResolvedExecCommand {
  candidate: ExecCommandCandidate;
  requestedRuntime: ExecRuntime;
  resolvedRuntime: ExecResolvedRuntime;
}

interface ProcessExecutionOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface ProcessExecutionResult {
  completedAt: Date;
  durationMs: number;
  exitCode: number | null;
  logs: ExecLogEntry[];
  signal: NodeJS.Signals | null;
  startedAt: Date;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 4_000;
const TEMP_DIRECTORY = join(tmpdir(), 'graph-plot-exec');
const PLOT_PACKAGE_DIRECTORY = join(
  TEMP_DIRECTORY,
  PLOT_PACKAGE_DIRECTORY_NAME,
);
const PLOT_RUN_DIRECTORY = join(TEMP_DIRECTORY, PLOT_RUN_DIRECTORY_NAME);

@Injectable()
export class ExecService {
  private plotBootstrapPromise: Promise<void> | null = null;

  async getCapabilities(): Promise<ExecCapabilitiesResponse> {
    const defaultShellRuntime = getDefaultShellRuntime();
    const runtimes = await Promise.all(
      EXEC_RUNTIMES.map((runtime) =>
        this.getRuntimeCapability(runtime, defaultShellRuntime),
      ),
    );

    return {
      os: process.platform,
      defaultShellRuntime,
      runtimes,
    };
  }

  async getPlotCapabilities(): Promise<ExecPlotCapabilitiesResponse> {
    const sandbox = await this.getPlotSandboxStatus();

    return {
      os: process.platform,
      sandbox,
    };
  }

  async run(requestBody: ExecRunRequestBody): Promise<ExecRunResponse> {
    const request = normalizeRunRequest(requestBody);
    const command = await this.resolveCommand(request.runtime);

    await mkdir(TEMP_DIRECTORY, { recursive: true });

    const scriptPath = join(
      TEMP_DIRECTORY,
      `exec-${Date.now()}-${randomUUID()}${command.candidate.extension}`,
    );

    await writeFile(scriptPath, request.code, 'utf8');

    const commandArgs = [
      ...command.candidate.execArgs,
      scriptPath,
      ...request.args,
    ];

    try {
      const outcome = await this.executeCommand({
        command: command.candidate.command,
        args: commandArgs,
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: request.timeoutMs,
      });

      return {
        requestedRuntime: command.requestedRuntime,
        resolvedRuntime: command.resolvedRuntime,
        os: process.platform,
        command: command.candidate.command,
        commandArgs,
        workingDirectory: process.cwd(),
        startedAt: outcome.startedAt.toISOString(),
        completedAt: outcome.completedAt.toISOString(),
        durationMs: outcome.durationMs,
        status: outcome.timedOut
          ? 'timed_out'
          : outcome.exitCode === 0
            ? 'completed'
            : 'failed',
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        logs: outcome.logs,
        errors: collectErrors(
          outcome.stderr,
          outcome.timedOut,
          request.timeoutMs,
        ),
      };
    } finally {
      await unlink(scriptPath).catch(() => undefined);
    }
  }

  async runPlot(requestBody: ExecPlotRequestBody): Promise<ExecPlotResponse> {
    const request = normalizePlotRequest(requestBody);
    const { command, sandbox } = await this.ensurePlotSandboxReady(
      request.installMissingPackages,
    );

    await mkdir(PLOT_RUN_DIRECTORY, { recursive: true });

    const runDirectory = join(
      PLOT_RUN_DIRECTORY,
      `plot-${Date.now()}-${randomUUID()}`,
    );
    const mplConfigDirectory = join(runDirectory, 'mplconfig');
    const codePath = join(runDirectory, PLOT_CODE_FILENAME);
    const runnerPath = join(runDirectory, PLOT_RUNNER_FILENAME);
    const outputDirectory = join(runDirectory, 'output');

    await mkdir(runDirectory, { recursive: true });
    await mkdir(mplConfigDirectory, { recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(codePath, request.code, 'utf8');
    await writeFile(runnerPath, getPlotRunnerScript(), 'utf8');

    const commandArgs = [...command.execArgs, runnerPath];
    const env = withPythonPath(process.env, PLOT_PACKAGE_DIRECTORY, {
      GRAPH_PLOT_CODE_PATH: codePath,
      GRAPH_PLOT_OUTPUT_DIR: outputDirectory,
      GRAPH_PLOT_RENDER_DPI: String(getPlotRenderDpi(request.renderProfile)),
      GRAPH_PLOT_SMALL_TEXT_THRESHOLD_PT: String(PLOT_SMALL_TEXT_THRESHOLD_PT),
      MPLCONFIGDIR: mplConfigDirectory,
      PYTHONUNBUFFERED: '1',
    });

    try {
      const outcome = await this.executeCommand({
        command: command.command,
        args: commandArgs,
        cwd: runDirectory,
        env,
        timeoutMs: request.timeoutMs,
      });
      const plotOutput =
        outcome.exitCode === 0 && !outcome.timedOut
          ? await this.loadPlotOutput(outputDirectory)
          : { artifacts: [] };

      return {
        requestedRuntime: 'python',
        resolvedRuntime: 'python',
        os: process.platform,
        renderProfile: request.renderProfile,
        command: command.command,
        commandArgs,
        workingDirectory: runDirectory,
        startedAt: outcome.startedAt.toISOString(),
        completedAt: outcome.completedAt.toISOString(),
        durationMs: outcome.durationMs,
        status: outcome.timedOut
          ? 'timed_out'
          : outcome.exitCode === 0
            ? 'completed'
            : 'failed',
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        logs: outcome.logs,
        errors: collectErrors(
          outcome.stderr,
          outcome.timedOut,
          request.timeoutMs,
        ),
        sandbox,
        artifacts: plotOutput.artifacts,
        layoutDiagnostics: plotOutput.layoutDiagnostics,
      };
    } finally {
      await rm(runDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async getPlotSandboxStatus(): Promise<ExecPlotSandboxStatus> {
    const candidate = await this.findAvailableCandidate('python');

    if (!candidate) {
      return {
        available: false,
        bootstrapped: false,
        packageDirectory: PLOT_PACKAGE_DIRECTORY,
        requiredPackages: [...PLOT_REQUIRED_PACKAGES],
      };
    }

    const bootstrapped = await this.hasPlotDependencies(candidate);

    return {
      available: true,
      bootstrapped,
      command: candidate.command,
      packageDirectory: PLOT_PACKAGE_DIRECTORY,
      requiredPackages: [...PLOT_REQUIRED_PACKAGES],
    };
  }

  private async ensurePlotSandboxReady(
    installMissingPackages: boolean,
  ): Promise<{
    command: ExecCommandCandidate;
    sandbox: ExecPlotSandboxStatus;
  }> {
    const command = await this.findAvailableCandidate('python');

    if (!command) {
      throw new ServiceUnavailableException(
        'No Python runtime is available for the plotting sandbox.',
      );
    }

    await mkdir(PLOT_PACKAGE_DIRECTORY, { recursive: true });

    const alreadyBootstrapped = await this.hasPlotDependencies(command);
    if (!alreadyBootstrapped) {
      if (!installMissingPackages) {
        throw new ServiceUnavailableException(
          'Plotting dependencies are not installed yet. Enable installMissingPackages or bootstrap the plotting sandbox first.',
        );
      }

      if (!this.plotBootstrapPromise) {
        this.plotBootstrapPromise = this.installPlotDependencies(
          command,
        ).finally(() => {
          this.plotBootstrapPromise = null;
        });
      }

      await this.plotBootstrapPromise;
    }

    return {
      command,
      sandbox: {
        available: true,
        bootstrapped: true,
        command: command.command,
        packageDirectory: PLOT_PACKAGE_DIRECTORY,
        requiredPackages: [...PLOT_REQUIRED_PACKAGES],
      },
    };
  }

  private async hasPlotDependencies(
    command: ExecCommandCandidate,
  ): Promise<boolean> {
    const moduleArgs = [
      ...getPythonModuleArgs(command),
      '-c',
      'import matplotlib, numpy, pandas, seaborn',
    ];

    const outcome = await this.executeCommand({
      command: command.command,
      args: moduleArgs,
      cwd: process.cwd(),
      env: withPythonPath(process.env, PLOT_PACKAGE_DIRECTORY),
      timeoutMs: PROBE_TIMEOUT_MS,
    }).catch(() => null);

    return outcome?.exitCode === 0;
  }

  private async installPlotDependencies(
    command: ExecCommandCandidate,
  ): Promise<void> {
    const installArgs = [
      ...getPythonModuleArgs(command),
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--target',
      PLOT_PACKAGE_DIRECTORY,
      ...PLOT_REQUIRED_PACKAGES,
    ];

    const outcome = await this.executeCommand({
      command: command.command,
      args: installArgs,
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: PLOT_INSTALL_TIMEOUT_MS,
    });

    if (outcome.exitCode !== 0 || outcome.timedOut) {
      throw new ServiceUnavailableException(
        `Unable to install plotting dependencies: ${outcome.stderr || outcome.stdout || 'unknown pip error'}`,
      );
    }
  }

  private async loadPlotOutput(
    outputDirectory: string,
  ): Promise<PlotOutputResult> {
    const metadataPath = join(outputDirectory, PLOT_METADATA_FILENAME);
    const metadataRaw = await readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(metadataRaw) as {
      artifacts?: Array<{ filename?: string; mimeType?: string }>;
      layoutDiagnostics?: unknown;
    };
    const artifacts = Array.isArray(metadata.artifacts)
      ? metadata.artifacts
      : [];

    const loadedArtifacts = await Promise.all(
      artifacts
        .filter(
          (artifact): artifact is { filename: string; mimeType: string } =>
            typeof artifact.filename === 'string' &&
            artifact.filename.length > 0 &&
            typeof artifact.mimeType === 'string' &&
            artifact.mimeType.length > 0,
        )
        .map(async (artifact) => {
          const fileBuffer = await readFile(
            join(outputDirectory, artifact.filename),
          );

          return {
            kind: 'image' as const,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            base64: fileBuffer.toString('base64'),
            byteSize: fileBuffer.byteLength,
          };
        }),
    );

    return {
      artifacts: loadedArtifacts,
      layoutDiagnostics: normalizePlotLayoutDiagnostics(
        metadata.layoutDiagnostics,
      ),
    };
  }

  private async getRuntimeCapability(
    runtime: ExecRuntime,
    defaultShellRuntime: Exclude<ExecRuntime, 'python' | 'shell'>,
  ): Promise<ExecRuntimeCapability> {
    const resolvedRuntime = runtime === 'shell' ? defaultShellRuntime : runtime;
    const candidate = await this.findAvailableCandidate(resolvedRuntime);

    return {
      runtime,
      resolvedRuntime,
      defaultForOs: runtime === 'shell',
      available: candidate !== null,
      command: candidate?.command,
      description: getRuntimeDescription(runtime, resolvedRuntime),
    };
  }

  private async resolveCommand(
    requestedRuntime: ExecRuntime,
  ): Promise<ResolvedExecCommand> {
    const resolvedRuntime =
      requestedRuntime === 'shell'
        ? getDefaultShellRuntime()
        : requestedRuntime;
    const candidate = await this.findAvailableCandidate(resolvedRuntime);

    if (!candidate) {
      throw new ServiceUnavailableException(
        `No executable runtime is available for ${requestedRuntime} on ${process.platform}. Check /api/exec/capabilities for the current environment.`,
      );
    }

    return {
      requestedRuntime,
      resolvedRuntime,
      candidate,
    };
  }

  private async findAvailableCandidate(
    runtime: ExecResolvedRuntime,
  ): Promise<ExecCommandCandidate | null> {
    for (const candidate of getRuntimeCandidates(runtime)) {
      if (await this.probeCandidate(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async probeCandidate(
    candidate: ExecCommandCandidate,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = spawn(candidate.command, candidate.probeArgs, {
        stdio: 'ignore',
        windowsHide: true,
      });

      const timeoutHandle = setTimeout(() => {
        child.kill();
        resolve(false);
      }, PROBE_TIMEOUT_MS);

      child.on('error', () => {
        clearTimeout(timeoutHandle);
        resolve(false);
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeoutHandle);
        resolve(exitCode === 0);
      });
    });
  }

  private async executeCommand(
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    const logs: ExecLogEntry[] = [];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const startedAt = new Date();
    const startedHrTime = process.hrtime.bigint();

    const outcome = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        appendLog(
          logs,
          'system',
          `Execution timed out after ${options.timeoutMs} ms.`,
        );
        child.kill();
      }, options.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdout += text;
        appendLog(logs, 'stdout', text);
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        appendLog(logs, 'stderr', text);
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        reject(
          new ServiceUnavailableException(
            `Unable to start command "${options.command}": ${error.message}`,
          ),
        );
      });

      child.on('close', (exitCode, signal) => {
        clearTimeout(timeoutHandle);
        resolve({ exitCode, signal });
      });
    });

    return {
      startedAt,
      completedAt: new Date(),
      durationMs: getDurationMs(startedHrTime),
      exitCode: outcome.exitCode,
      logs,
      signal: outcome.signal,
      stderr,
      stdout,
      timedOut,
    };
  }
}

function normalizeRunRequest(
  requestBody: ExecRunRequestBody,
): NormalizedExecRunRequest {
  if (!isObject(requestBody)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const runtime = normalizeRuntime(requestBody.runtime);

  if (typeof requestBody.code !== 'string' || requestBody.code.trim() === '') {
    throw new BadRequestException('`code` must be a non-empty string.');
  }

  return {
    runtime,
    code: requestBody.code,
    timeoutMs: normalizeTimeout(requestBody.timeoutMs),
    args: normalizeArgs(requestBody.args),
  };
}

function normalizeRuntime(runtimeInput: string): ExecRuntime {
  const runtime = runtimeInput?.trim().toLowerCase();

  if (!runtime) {
    throw new BadRequestException('`runtime` must be a non-empty string.');
  }

  if (!EXEC_RUNTIMES.includes(runtime as (typeof EXEC_RUNTIMES)[number])) {
    throw new BadRequestException(
      '`runtime` must be one of: python, bash, powershell, shell.',
    );
  }

  return runtime as ExecRuntime;
}

function normalizeTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs === 'undefined') {
    return DEFAULT_TIMEOUT_MS;
  }

  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new BadRequestException(
      `\`timeoutMs\` must be a positive integer up to ${MAX_TIMEOUT_MS}.`,
    );
  }

  return timeoutMs;
}

function normalizeArgs(args: unknown): string[] {
  if (typeof args === 'undefined') {
    return [];
  }

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new BadRequestException('`args` must be an array of strings.');
  }

  return args;
}

function normalizePlotRequest(
  requestBody: ExecPlotRequestBody,
): NormalizedExecPlotRequest {
  if (!isObject(requestBody)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  if (typeof requestBody.code !== 'string' || requestBody.code.trim() === '') {
    throw new BadRequestException('`code` must be a non-empty string.');
  }

  if (
    typeof requestBody.installMissingPackages !== 'undefined' &&
    typeof requestBody.installMissingPackages !== 'boolean'
  ) {
    throw new BadRequestException(
      '`installMissingPackages` must be a boolean when provided.',
    );
  }

  return {
    code: requestBody.code,
    timeoutMs: normalizeTimeout(requestBody.timeoutMs),
    installMissingPackages: requestBody.installMissingPackages ?? true,
    renderProfile: normalizePlotRenderProfile(requestBody.renderProfile),
  };
}

function normalizePlotRenderProfile(
  renderProfile: unknown,
): ExecPlotRenderProfile {
  if (typeof renderProfile === 'undefined') {
    return 'draft';
  }

  if (
    typeof renderProfile !== 'string' ||
    !EXEC_PLOT_RENDER_PROFILES.includes(
      renderProfile as (typeof EXEC_PLOT_RENDER_PROFILES)[number],
    )
  ) {
    throw new BadRequestException(
      '`renderProfile` must be one of: draft, final.',
    );
  }

  return renderProfile as ExecPlotRenderProfile;
}

function normalizePlotLayoutDiagnostics(
  value: unknown,
): ExecPlotLayoutDiagnostics | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const figuresValue = value['figures'];
  const figures = Array.isArray(figuresValue)
    ? figuresValue
        .map(normalizePlotFigureLayoutDiagnostics)
        .filter(
          (diagnostics): diagnostics is ExecPlotFigureLayoutDiagnostics =>
            typeof diagnostics !== 'undefined',
        )
    : [];

  return {
    totalFigureCount:
      getFiniteNumber(value, 'totalFigureCount') ?? figures.length,
    totalAxesCount: getFiniteNumber(value, 'totalAxesCount') ?? 0,
    totalTextElementCount: getFiniteNumber(value, 'totalTextElementCount') ?? 0,
    totalVisibleTextElementCount:
      getFiniteNumber(value, 'totalVisibleTextElementCount') ?? 0,
    totalClippedTextCount: getFiniteNumber(value, 'totalClippedTextCount') ?? 0,
    totalOverlappingTextPairCount:
      getFiniteNumber(value, 'totalOverlappingTextPairCount') ?? 0,
    totalVerySmallTextCount:
      getFiniteNumber(value, 'totalVerySmallTextCount') ?? 0,
    figures,
  };
}

function normalizePlotFigureLayoutDiagnostics(
  value: unknown,
): ExecPlotFigureLayoutDiagnostics | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const filename = getString(value, 'filename');

  if (!filename) {
    return undefined;
  }

  return {
    filename,
    widthPx: getFiniteNumber(value, 'widthPx') ?? 0,
    heightPx: getFiniteNumber(value, 'heightPx') ?? 0,
    axesCount: getFiniteNumber(value, 'axesCount') ?? 0,
    textElementCount: getFiniteNumber(value, 'textElementCount') ?? 0,
    visibleTextElementCount:
      getFiniteNumber(value, 'visibleTextElementCount') ?? 0,
    clippedTextCount: getFiniteNumber(value, 'clippedTextCount') ?? 0,
    overlappingTextPairCount:
      getFiniteNumber(value, 'overlappingTextPairCount') ?? 0,
    verySmallTextCount: getFiniteNumber(value, 'verySmallTextCount') ?? 0,
    minFontSize: getFiniteNumber(value, 'minFontSize'),
    maxFontSize: getFiniteNumber(value, 'maxFontSize'),
    averageFontSize: getFiniteNumber(value, 'averageFontSize'),
  };
}

function getDefaultShellRuntime(): Exclude<ExecRuntime, 'python' | 'shell'> {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function getRuntimeDescription(
  runtime: ExecRuntime,
  resolvedRuntime: ExecResolvedRuntime,
): string {
  switch (runtime) {
    case 'python':
      return 'Execute Python code with the first available Python interpreter.';
    case 'bash':
      return 'Execute a Bash script with the first available Bash executable.';
    case 'powershell':
      return 'Execute a PowerShell script with Windows PowerShell or pwsh.';
    case 'shell':
      return `Execute with the default shell for this OS, currently ${resolvedRuntime}.`;
  }
}

function getRuntimeCandidates(
  runtime: ExecResolvedRuntime,
): ExecCommandCandidate[] {
  switch (runtime) {
    case 'python':
      return getPythonCandidates();
    case 'bash':
      return getBashCandidates();
    case 'powershell':
      return getPowerShellCandidates();
  }
}

function getPythonCandidates(): ExecCommandCandidate[] {
  const windowsCandidates: ExecCommandCandidate[] = [
    {
      command: 'py',
      probeArgs: ['-3', '--version'],
      execArgs: ['-3', '-u'],
      extension: '.py',
    },
    {
      command: 'python',
      probeArgs: ['--version'],
      execArgs: ['-u'],
      extension: '.py',
    },
    {
      command: 'python3',
      probeArgs: ['--version'],
      execArgs: ['-u'],
      extension: '.py',
    },
  ];

  const posixCandidates: ExecCommandCandidate[] = [
    {
      command: 'python3',
      probeArgs: ['--version'],
      execArgs: ['-u'],
      extension: '.py',
    },
    {
      command: 'python',
      probeArgs: ['--version'],
      execArgs: ['-u'],
      extension: '.py',
    },
  ];

  return process.platform === 'win32' ? windowsCandidates : posixCandidates;
}

function getPythonModuleArgs(candidate: ExecCommandCandidate): string[] {
  return candidate.execArgs.filter((arg) => arg !== '-u');
}

function withPythonPath(
  env: NodeJS.ProcessEnv,
  packageDirectory: string,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const existingPythonPath = env.PYTHONPATH?.trim();
  const pythonPath = existingPythonPath
    ? `${packageDirectory}${pathDelimiter}${existingPythonPath}`
    : packageDirectory;

  return {
    ...env,
    ...extraEnv,
    PYTHONPATH: pythonPath,
  };
}

function getPlotRenderDpi(renderProfile: ExecPlotRenderProfile): number {
  switch (renderProfile) {
    case 'draft':
      return PLOT_DRAFT_DPI;
    case 'final':
      return PLOT_FINAL_DPI;
  }
}

function getBashCandidates(): ExecCommandCandidate[] {
  return [
    {
      command: 'bash',
      probeArgs: ['--version'],
      execArgs: [],
      extension: '.sh',
    },
  ];
}

function getPowerShellCandidates(): ExecCommandCandidate[] {
  const baseProbeArgs = [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    '$PSVersionTable.PSVersion.ToString()',
  ];
  const fileArgs =
    process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']
      : ['-NoLogo', '-NoProfile', '-File'];

  const windowsCandidates: ExecCommandCandidate[] = [
    {
      command: 'powershell',
      probeArgs: baseProbeArgs,
      execArgs: fileArgs,
      extension: '.ps1',
    },
    {
      command: 'pwsh',
      probeArgs: baseProbeArgs,
      execArgs: fileArgs,
      extension: '.ps1',
    },
  ];

  const posixCandidates: ExecCommandCandidate[] = [
    {
      command: 'pwsh',
      probeArgs: baseProbeArgs,
      execArgs: fileArgs,
      extension: '.ps1',
    },
    {
      command: 'powershell',
      probeArgs: baseProbeArgs,
      execArgs: fileArgs,
      extension: '.ps1',
    },
  ];

  return process.platform === 'win32' ? windowsCandidates : posixCandidates;
}

function appendLog(
  logs: ExecLogEntry[],
  stream: ExecLogEntry['stream'],
  text: string,
) {
  if (!text) {
    return;
  }

  logs.push({
    stream,
    text,
    timestamp: new Date().toISOString(),
  });
}

function collectErrors(
  stderr: string,
  timedOut: boolean,
  timeoutMs: number,
): string[] {
  const errors = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (timedOut) {
    errors.unshift(`Execution timed out after ${timeoutMs} ms.`);
  }

  return errors;
}

function getDurationMs(startedHrTime: bigint): number {
  return Number((process.hrtime.bigint() - startedHrTime) / 1_000_000n);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function getString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function getFiniteNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
