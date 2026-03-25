import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecCapabilitiesResponse,
  ExecLogEntry,
  ExecResolvedRuntime,
  ExecRunRequestBody,
  ExecRunResponse,
  ExecRuntime,
  ExecRuntimeCapability,
} from './exec.types';
import { EXEC_RUNTIMES } from './exec.types';

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

interface ResolvedExecCommand {
  candidate: ExecCommandCandidate;
  requestedRuntime: ExecRuntime;
  resolvedRuntime: ExecResolvedRuntime;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 4_000;
const TEMP_DIRECTORY = join(tmpdir(), 'graph-plot-exec');

@Injectable()
export class ExecService {
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
    const logs: ExecLogEntry[] = [];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const startedAt = new Date();
    const startedHrTime = process.hrtime.bigint();

    try {
      const outcome = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const child = spawn(command.candidate.command, commandArgs, {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          appendLog(
            logs,
            'system',
            `Execution timed out after ${request.timeoutMs} ms.`,
          );
          child.kill();
        }, request.timeoutMs);

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
              `Unable to start ${command.requestedRuntime} execution: ${error.message}`,
            ),
          );
        });

        child.on('close', (exitCode, signal) => {
          clearTimeout(timeoutHandle);
          resolve({ exitCode, signal });
        });
      });

      const completedAt = new Date();
      const durationMs = getDurationMs(startedHrTime);

      return {
        requestedRuntime: command.requestedRuntime,
        resolvedRuntime: command.resolvedRuntime,
        os: process.platform,
        command: command.candidate.command,
        commandArgs,
        workingDirectory: process.cwd(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        status: timedOut
          ? 'timed_out'
          : outcome.exitCode === 0
            ? 'completed'
            : 'failed',
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout,
        stderr,
        logs,
        errors: collectErrors(stderr, timedOut, request.timeoutMs),
      };
    } finally {
      await unlink(scriptPath).catch(() => undefined);
    }
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
