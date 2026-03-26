import { Test, TestingModule } from '@nestjs/testing';
import { ExecController } from './exec.controller';
import { ExecService } from './exec.service';
import type {
  ExecCapabilitiesResponse,
  ExecPlotCapabilitiesResponse,
  ExecPlotResponse,
  ExecRunResponse,
} from './exec.types';

describe('ExecController', () => {
  let controller: ExecController;

  const capabilitiesResponse: ExecCapabilitiesResponse = {
    os: process.platform,
    defaultShellRuntime: process.platform === 'win32' ? 'powershell' : 'bash',
    runtimes: [
      {
        runtime: 'shell',
        resolvedRuntime: process.platform === 'win32' ? 'powershell' : 'bash',
        defaultForOs: true,
        available: true,
        command: process.platform === 'win32' ? 'powershell' : 'bash',
        description: 'Default shell runtime',
      },
    ],
  };

  const runResponse: ExecRunResponse = {
    requestedRuntime: 'shell',
    resolvedRuntime: process.platform === 'win32' ? 'powershell' : 'bash',
    os: process.platform,
    command: process.platform === 'win32' ? 'powershell' : 'bash',
    commandArgs: ['script'],
    workingDirectory: process.cwd(),
    startedAt: '2026-03-26T00:00:00.000Z',
    completedAt: '2026-03-26T00:00:01.000Z',
    durationMs: 1000,
    status: 'completed',
    exitCode: 0,
    signal: null,
    stdout: 'ok',
    stderr: '',
    logs: [],
    errors: [],
  };

  const plotCapabilitiesResponse: ExecPlotCapabilitiesResponse = {
    os: process.platform,
    sandbox: {
      available: true,
      bootstrapped: true,
      command: 'python',
      packageDirectory: 'C:\\tmp\\python-plot-packages',
      requiredPackages: ['matplotlib', 'numpy', 'pandas', 'seaborn'],
    },
  };

  const plotResponse: ExecPlotResponse = {
    ...runResponse,
    requestedRuntime: 'python',
    resolvedRuntime: 'python',
    renderProfile: 'draft',
    sandbox: plotCapabilitiesResponse.sandbox,
    artifacts: [
      {
        kind: 'image',
        filename: 'figure-1.png',
        mimeType: 'image/png',
        base64: 'ZmFrZQ==',
        byteSize: 4,
      },
    ],
  };

  const execService = {
    getCapabilities: jest.fn(() => Promise.resolve(capabilitiesResponse)),
    getPlotCapabilities: jest.fn(() =>
      Promise.resolve(plotCapabilitiesResponse),
    ),
    run: jest.fn(() => Promise.resolve(runResponse)),
    runPlot: jest.fn(() => Promise.resolve(plotResponse)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecController],
      providers: [
        {
          provide: ExecService,
          useValue: execService,
        },
      ],
    }).compile();

    controller = module.get<ExecController>(ExecController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns execution capabilities', async () => {
    await expect(controller.getCapabilities()).resolves.toEqual(
      capabilitiesResponse,
    );
  });

  it('delegates run requests to the service', async () => {
    await expect(
      controller.run({
        runtime: 'shell',
        code: 'echo test',
      }),
    ).resolves.toEqual(runResponse);
  });

  it('returns plotting sandbox capabilities', async () => {
    await expect(controller.getPlotCapabilities()).resolves.toEqual(
      plotCapabilitiesResponse,
    );
  });

  it('delegates plot requests to the service', async () => {
    await expect(
      controller.runPlot({
        code: 'plt.plot([1, 2, 3])',
      }),
    ).resolves.toEqual(plotResponse);
  });
});
