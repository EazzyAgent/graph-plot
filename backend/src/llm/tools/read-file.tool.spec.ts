import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_READ_FILE_BYTES,
  MAX_READ_FILE_LINES,
  ReadFileTool,
} from './read-file.tool';

describe('ReadFileTool', () => {
  let tool: ReadFileTool;
  let fixtureDir: string;

  beforeEach(async () => {
    tool = new ReadFileTool();
    fixtureDir = await mkdtemp(join(tmpdir(), 'read-file-tool-'));
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('returns the requested first line window for a normal file', async () => {
    const filePath = join(fixtureDir, 'sample.txt');
    await writeFile(filePath, 'line 1\nline 2\nline 3\nline 4', 'utf8');

    const result = await tool.execute({ path: filePath, lineCount: 2 });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        path: filePath,
        content: 'line 1\nline 2',
        startLine: 1,
        endLine: 2,
        requestedLineCount: 2,
        returnedLineCount: 2,
        totalLines: 4,
        hasMore: true,
        nextStartLine: 3,
        truncated: false,
      }),
    );
  });

  it('supports iterative follow-up reads from later lines', async () => {
    const filePath = join(fixtureDir, 'windowed.txt');
    await writeFile(filePath, 'a\nb\nc\nd\ne', 'utf8');

    const result = await tool.execute({
      path: filePath,
      startLine: 3,
      lineCount: 2,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        startLine: 3,
        endLine: 4,
        requestedLineCount: 2,
        returnedLineCount: 2,
        content: 'c\nd',
        totalLines: 5,
        hasMore: true,
        nextStartLine: 5,
      }),
    );
  });

  it('truncates the selected line window when it exceeds the byte limit', async () => {
    const filePath = join(fixtureDir, 'large-lines.txt');
    const line = 'a'.repeat(Math.floor(MAX_READ_FILE_BYTES / 2));
    await writeFile(filePath, `${line}\n${line}\nthird`, 'utf8');

    const result = await tool.execute({ path: filePath, lineCount: 3 });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        startLine: 1,
        endLine: 1,
        requestedLineCount: 3,
        returnedLineCount: 1,
        totalLines: 3,
        hasMore: true,
        nextStartLine: 2,
        truncated: true,
        truncatedByBytes: true,
      }),
    );
    expect(
      Buffer.byteLength(result['content'] as string, 'utf8'),
    ).toBeLessThanOrEqual(MAX_READ_FILE_BYTES);
  });

  it('rejects line counts above the allowed limit', async () => {
    const filePath = join(fixtureDir, 'sample.txt');
    await writeFile(filePath, 'line 1\nline 2', 'utf8');

    await expect(
      tool.execute({
        path: filePath,
        lineCount: MAX_READ_FILE_LINES + 1,
      }),
    ).rejects.toThrow(
      `\`lineCount\` must be less than or equal to ${MAX_READ_FILE_LINES}.`,
    );
  });

  it('returns an out-of-range error when the requested start line is past EOF', async () => {
    const filePath = join(fixtureDir, 'sample.txt');
    await writeFile(filePath, 'line 1\nline 2', 'utf8');

    const result = await tool.execute({
      path: filePath,
      startLine: 10,
      lineCount: 2,
    });

    expect(result['ok']).toBe(false);
    expect(getErrorCode(result)).toBe('line_out_of_range');
  });

  it('rejects directories', async () => {
    const directoryPath = join(fixtureDir, 'folder');
    await mkdir(directoryPath);

    const result = await tool.execute({ path: directoryPath, lineCount: 5 });

    expect(result['ok']).toBe(false);
    expect(getErrorCode(result)).toBe('not_a_file');
  });

  it('rejects binary-like files', async () => {
    const filePath = join(fixtureDir, 'binary.bin');
    await writeFile(filePath, Buffer.from([0x00, 0x41, 0x42]));

    const result = await tool.execute({ path: filePath, lineCount: 5 });

    expect(result['ok']).toBe(false);
    expect(getErrorCode(result)).toBe('binary_file');
  });
});

function getErrorCode(result: Record<string, unknown>): string | undefined {
  const error = result['error'];

  return typeof error === 'object' && error !== null && 'code' in error
    ? (error['code'] as string | undefined)
    : undefined;
}
