import { BadRequestException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { ExecService } from './exec.service';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  rm: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}

type ExecServiceInternals = ExecService & {
  executeCommand: (options: { env?: NodeJS.ProcessEnv }) => Promise<unknown>;
};

describe('ExecService', () => {
  let service: ExecService;
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;
  const mkdirMock = mkdir as jest.MockedFunction<typeof mkdir>;
  const readFileMock = readFile as jest.MockedFunction<typeof readFile>;
  const rmMock = rm as jest.MockedFunction<typeof rm>;
  const writeFileMock = writeFile as jest.MockedFunction<typeof writeFile>;
  const unlinkMock = unlink as jest.MockedFunction<typeof unlink>;

  beforeEach(() => {
    service = new ExecService();
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockResolvedValue(Buffer.from(''));
    rmMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reports runtime capabilities for the current OS', async () => {
    spawnMock.mockImplementation((command, args) => {
      const child = new MockChildProcess();

      setImmediate(() => {
        if (command === 'pwsh' && process.platform === 'win32') {
          child.emit('error', new Error('pwsh not installed'));
          return;
        }

        if (Array.isArray(args) && args.length > 0) {
          child.emit('close', 0, null);
          return;
        }

        child.emit('close', 1, null);
      });

      return child as unknown as ReturnType<typeof spawn>;
    });

    const capabilities = await service.getCapabilities();
    const shellRuntime = capabilities.runtimes.find(
      (runtime) => runtime.runtime === 'shell',
    );

    expect(capabilities.defaultShellRuntime).toBe(
      process.platform === 'win32' ? 'powershell' : 'bash',
    );
    expect(shellRuntime?.available).toBe(true);
    expect(shellRuntime?.resolvedRuntime).toBe(
      process.platform === 'win32' ? 'powershell' : 'bash',
    );
  });

  it('captures stdout, stderr, logs, and exit status', async () => {
    spawnMock.mockImplementation((command, args) => {
      const child = new MockChildProcess();

      setImmediate(() => {
        if (Array.isArray(args) && args.includes('--version')) {
          child.emit('close', 0, null);
          return;
        }

        child.stdout.emit('data', Buffer.from('hello\n'));
        child.stderr.emit('data', Buffer.from('traceback line\n'));
        child.emit('close', 1, null);
      });

      return child as unknown as ReturnType<typeof spawn>;
    });

    const response = await service.run({
      runtime: 'python',
      code: 'print("hello")',
      timeoutMs: 5000,
      args: ['--flag'],
    });

    expect(response.requestedRuntime).toBe('python');
    expect(response.resolvedRuntime).toBe('python');
    expect(response.status).toBe('failed');
    expect(response.exitCode).toBe(1);
    expect(response.stdout).toContain('hello');
    expect(response.stderr).toContain('traceback line');
    expect(response.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: 'stdout', text: 'hello\n' }),
        expect.objectContaining({
          stream: 'stderr',
          text: 'traceback line\n',
        }),
      ]),
    );
    expect(response.errors).toContain('traceback line');
    expect(writeFileMock).toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('reports plotting sandbox capabilities for the current environment', async () => {
    jest.spyOn(service as any, 'findAvailableCandidate').mockResolvedValueOnce({
      command: 'python',
      probeArgs: ['--version'],
      execArgs: ['-u'],
      extension: '.py',
    });
    jest
      .spyOn(service as any, 'hasPlotDependencies')
      .mockResolvedValueOnce(true);

    const response = await service.getPlotCapabilities();

    expect(response.os).toBe(process.platform);
    expect(response.sandbox.available).toBe(true);
    expect(response.sandbox.bootstrapped).toBe(true);
    expect(response.sandbox.command).toBe('python');
    expect(response.sandbox.packageDirectory).toEqual(
      expect.stringContaining('python-plot-packages'),
    );
    expect(response.sandbox.requiredPackages).toEqual([
      'matplotlib',
      'numpy',
      'pandas',
      'seaborn',
    ]);
  });

  it('runs plotting code and returns image artifacts', async () => {
    jest.spyOn(service as any, 'ensurePlotSandboxReady').mockResolvedValueOnce({
      command: {
        command: 'python',
        probeArgs: ['--version'],
        execArgs: ['-u'],
        extension: '.py',
      },
      sandbox: {
        available: true,
        bootstrapped: true,
        command: 'python',
        packageDirectory: 'C:\\tmp\\python-plot-packages',
        requiredPackages: ['matplotlib', 'numpy', 'pandas', 'seaborn'],
      },
    });
    jest.spyOn(service as any, 'executeCommand').mockResolvedValueOnce({
      startedAt: new Date('2026-03-26T00:00:00.000Z'),
      completedAt: new Date('2026-03-26T00:00:01.000Z'),
      durationMs: 1000,
      exitCode: 0,
      signal: null,
      stdout: 'plot ok',
      stderr: '',
      logs: [],
      timedOut: false,
    });
    jest.spyOn(service as any, 'loadPlotOutput').mockResolvedValueOnce({
      artifacts: [
        {
          kind: 'image',
          filename: 'figure-1.png',
          mimeType: 'image/png',
          base64: 'ZmFrZQ==',
          byteSize: 4,
        },
      ],
      layoutDiagnostics: {
        totalFigureCount: 1,
        totalAxesCount: 1,
        totalTextElementCount: 5,
        totalVisibleTextElementCount: 5,
        totalClippedTextCount: 0,
        totalOverlappingTextPairCount: 0,
        totalVerySmallTextCount: 0,
        figures: [
          {
            filename: 'figure-1.png',
            widthPx: 800,
            heightPx: 600,
            axesCount: 1,
            textElementCount: 5,
            visibleTextElementCount: 5,
            clippedTextCount: 0,
            overlappingTextPairCount: 0,
            verySmallTextCount: 0,
            minFontSize: 10,
            maxFontSize: 16,
            averageFontSize: 12,
          },
        ],
      },
    });

    const response = await service.runPlot({
      code: 'plt.plot([1, 2, 3])',
    });

    expect(response.status).toBe('completed');
    expect(response.requestedRuntime).toBe('python');
    expect(response.renderProfile).toBe('draft');
    expect(response.artifacts).toEqual([
      {
        kind: 'image',
        filename: 'figure-1.png',
        mimeType: 'image/png',
        base64: 'ZmFrZQ==',
        byteSize: 4,
      },
    ]);
    expect(response.layoutDiagnostics?.totalFigureCount).toBe(1);
    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(rmMock).toHaveBeenCalled();
  });

  it('accepts a final render profile for higher resolution reruns', async () => {
    const serviceInternals = service as unknown as ExecServiceInternals;

    jest.spyOn(service as any, 'ensurePlotSandboxReady').mockResolvedValueOnce({
      command: {
        command: 'python',
        probeArgs: ['--version'],
        execArgs: ['-u'],
        extension: '.py',
      },
      sandbox: {
        available: true,
        bootstrapped: true,
        command: 'python',
        packageDirectory: 'C:\\tmp\\python-plot-packages',
        requiredPackages: ['matplotlib', 'numpy', 'pandas', 'seaborn'],
      },
    });
    const executeCommandSpy = jest
      .spyOn(serviceInternals, 'executeCommand')
      .mockResolvedValueOnce({
        startedAt: new Date('2026-03-26T00:00:00.000Z'),
        completedAt: new Date('2026-03-26T00:00:01.000Z'),
        durationMs: 1000,
        exitCode: 0,
        signal: null,
        stdout: 'plot ok',
        stderr: '',
        logs: [],
        timedOut: false,
      });
    jest.spyOn(service as any, 'loadPlotOutput').mockResolvedValueOnce({
      artifacts: [],
    });

    const response = await service.runPlot({
      code: 'plt.plot([1, 2, 3])',
      renderProfile: 'final',
    });

    expect(response.renderProfile).toBe('final');
    const calledOptions = executeCommandSpy.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(calledOptions?.env?.GRAPH_PLOT_RENDER_DPI).toBe('220');
  });

  it('rejects unsupported runtimes', async () => {
    await expect(
      service.run({
        runtime: 'ruby',
        code: 'puts "hello"',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
