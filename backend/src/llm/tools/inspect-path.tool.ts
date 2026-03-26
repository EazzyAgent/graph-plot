import { Injectable } from '@nestjs/common';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LlmToolDefinition, ToolJsonObject } from './tool.types';

@Injectable()
export class InspectPathTool {
  readonly definition: LlmToolDefinition = {
    name: 'inspect_path',
    description:
      'Inspect a local file or folder path. For a folder, return immediate child names and types without recursion. Use this before deciding which file to read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A local file or folder path to inspect.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  };

  async execute(input: unknown): Promise<ToolJsonObject> {
    const path = normalizePathInput(input);
    const resolvedPath = resolve(path);

    try {
      const stats = await lstat(resolvedPath);
      const type = getStatsType(stats);

      if (type !== 'directory') {
        return {
          ok: true,
          path: resolvedPath,
          exists: true,
          type,
          sizeBytes: stats.size,
        };
      }

      const entries = await readdir(resolvedPath, { withFileTypes: true });
      const normalizedEntries = entries
        .map((entry) => ({
          name: entry.name,
          path: resolve(resolvedPath, entry.name),
          type: entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : 'other',
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        ok: true,
        path: resolvedPath,
        exists: true,
        type,
        sizeBytes: stats.size,
        entries: normalizedEntries,
      };
    } catch (error) {
      return createFsToolError(error, resolvedPath);
    }
  }
}

function normalizePathInput(input: unknown): string {
  const path = isRecord(input) ? input.path : undefined;

  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('`path` must be a non-empty string.');
  }

  return path.trim();
}

function getStatsType(stats: { isFile(): boolean; isDirectory(): boolean }) {
  if (stats.isFile()) {
    return 'file';
  }

  if (stats.isDirectory()) {
    return 'directory';
  }

  return 'other';
}

function createFsToolError(error: unknown, path: string): ToolJsonObject {
  if (hasCode(error, 'ENOENT')) {
    return {
      ok: false,
      path,
      error: {
        code: 'not_found',
        message: 'Path does not exist.',
      },
    };
  }

  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM')) {
    return {
      ok: false,
      path,
      error: {
        code: 'permission_denied',
        message: 'Permission denied while inspecting the path.',
      },
    };
  }

  return {
    ok: false,
    path,
    error: {
      code: 'inspect_failed',
      message:
        error instanceof Error ? error.message : 'Unable to inspect path.',
    },
  };
}

function hasCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && error['code'] === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
