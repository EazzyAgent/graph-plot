import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InspectPathTool } from './inspect-path.tool';

describe('InspectPathTool', () => {
  let tool: InspectPathTool;
  let fixtureDir: string;

  beforeEach(async () => {
    tool = new InspectPathTool();
    fixtureDir = await mkdtemp(join(tmpdir(), 'inspect-path-tool-'));
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('returns immediate child names and types for a directory', async () => {
    await writeFile(join(fixtureDir, 'b.txt'), 'b', 'utf8');
    await writeFile(join(fixtureDir, 'a.txt'), 'a', 'utf8');

    const result = await tool.execute({ path: fixtureDir });

    expect(result['ok']).toBe(true);
    expect(result['type']).toBe('directory');
    expect(result['entries']).toEqual([
      expect.objectContaining({ name: 'a.txt', type: 'file' }),
      expect.objectContaining({ name: 'b.txt', type: 'file' }),
    ]);
  });

  it('returns metadata for a file', async () => {
    const filePath = join(fixtureDir, 'sample.txt');
    await writeFile(filePath, 'hello', 'utf8');

    const result = await tool.execute({ path: filePath });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        path: filePath,
        type: 'file',
      }),
    );
    expect(result['entries']).toBeUndefined();
  });

  it('returns a structured error for a missing path', async () => {
    const result = await tool.execute({
      path: join(fixtureDir, 'missing.txt'),
    });

    expect(result['ok']).toBe(false);
    expect(getErrorCode(result)).toBe('not_found');
  });
});

function getErrorCode(result: Record<string, unknown>): string | undefined {
  const error = result['error'];

  return typeof error === 'object' && error !== null && 'code' in error
    ? (error['code'] as string | undefined)
    : undefined;
}
