import { BadRequestException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { ExecService } from './exec.service';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}

describe('ExecService', () => {
  let service: ExecService;
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;
  const mkdirMock = mkdir as jest.MockedFunction<typeof mkdir>;
  const writeFileMock = writeFile as jest.MockedFunction<typeof writeFile>;
  const unlinkMock = unlink as jest.MockedFunction<typeof unlink>;

  beforeEach(() => {
    service = new ExecService();
    mkdirMock.mockResolvedValue(undefined);
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

  it('rejects unsupported runtimes', async () => {
    await expect(
      service.run({
        runtime: 'ruby',
        code: 'puts "hello"',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
