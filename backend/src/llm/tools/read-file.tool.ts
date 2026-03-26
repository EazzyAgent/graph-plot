import { Injectable } from '@nestjs/common';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LlmToolDefinition, ToolJsonObject } from './tool.types';

export const MAX_READ_FILE_BYTES = 65_536;
export const MAX_READ_FILE_LINES = 200;

@Injectable()
export class ReadFileTool {
  readonly definition: LlmToolDefinition = {
    name: 'read_file',
    description:
      'Read a local text file by line range. Start with the first N lines, where N should be inferred from the user request, and only read more lines if needed. Use this after inspect_path when you know which file you want to inspect.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A local file path to read as text.',
        },
        startLine: {
          type: 'integer',
          minimum: 1,
          description:
            '1-based line number to start reading from. For the first read, use 1.',
        },
        lineCount: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_READ_FILE_LINES,
          description:
            'How many lines to read. Infer this from the user request and keep it as small as practical.',
        },
      },
      required: ['path', 'startLine', 'lineCount'],
      additionalProperties: false,
    },
  };

  async execute(input: unknown): Promise<ToolJsonObject> {
    const { lineCount, path, startLine } = normalizeReadFileInput(input);
    const resolvedPath = resolve(path);

    try {
      const stats = await lstat(resolvedPath);

      if (!stats.isFile()) {
        return {
          ok: false,
          path: resolvedPath,
          error: {
            code: 'not_a_file',
            message: 'The requested path is not a regular file.',
          },
        };
      }

      const buffer = await readFile(resolvedPath);
      const slice = buffer.subarray(0, MAX_READ_FILE_BYTES);

      if (slice.includes(0)) {
        return {
          ok: false,
          path: resolvedPath,
          error: {
            code: 'binary_file',
            message: 'Binary-looking files are not returned by this tool.',
          },
        };
      }

      const text = buffer.toString('utf8');
      const lines = splitFileIntoLines(text);
      const totalLines = lines.length;

      if (totalLines > 0 && startLine > totalLines) {
        return {
          ok: false,
          path: resolvedPath,
          startLine,
          totalLines,
          error: {
            code: 'line_out_of_range',
            message: `The requested startLine ${startLine} is beyond the end of the file.`,
          },
        };
      }

      const startIndex = Math.max(0, startLine - 1);
      const requestedLines = lines.slice(startIndex, startIndex + lineCount);
      const window = fitLinesWithinByteLimit(requestedLines);
      const endLine =
        window.lines.length > 0
          ? startLine + window.lines.length - 1
          : startLine - 1;
      const hasRemainingRequestedLines =
        window.lines.length < requestedLines.length;
      const hasMore = endLine < totalLines;

      return {
        ok: true,
        path: resolvedPath,
        content: window.content,
        startLine,
        endLine,
        requestedLineCount: lineCount,
        returnedLineCount: window.lines.length,
        totalLines,
        hasMore,
        nextStartLine: hasMore ? endLine + 1 : undefined,
        truncated: hasRemainingRequestedLines,
        truncatedByBytes: hasRemainingRequestedLines,
        sizeBytes: buffer.byteLength,
        returnedBytes: Buffer.byteLength(window.content, 'utf8'),
      };
    } catch (error) {
      return createFsToolError(error, resolvedPath);
    }
  }
}

function normalizeReadFileInput(input: unknown): {
  path: string;
  startLine: number;
  lineCount: number;
} {
  const record = isRecord(input) ? input : undefined;
  const path = record?.path;
  const rawStartLine = record?.startLine;
  const rawLineCount = record?.lineCount;

  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('`path` must be a non-empty string.');
  }

  if (
    typeof rawStartLine !== 'undefined' &&
    (typeof rawStartLine !== 'number' ||
      !Number.isInteger(rawStartLine) ||
      rawStartLine <= 0)
  ) {
    throw new Error('`startLine` must be a positive integer when provided.');
  }

  if (
    typeof rawLineCount !== 'number' ||
    !Number.isInteger(rawLineCount) ||
    rawLineCount <= 0
  ) {
    throw new Error('`lineCount` must be a positive integer.');
  }

  if (rawLineCount > MAX_READ_FILE_LINES) {
    throw new Error(
      `\`lineCount\` must be less than or equal to ${MAX_READ_FILE_LINES}.`,
    );
  }

  return {
    path: path.trim(),
    startLine: typeof rawStartLine === 'number' ? rawStartLine : 1,
    lineCount: rawLineCount,
  };
}

function splitFileIntoLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/);

  if (content.endsWith('\n')) {
    lines.pop();
  }

  return lines;
}

function fitLinesWithinByteLimit(lines: string[]): {
  content: string;
  lines: string[];
} {
  if (lines.length === 0) {
    return {
      content: '',
      lines: [],
    };
  }

  let fittedLines = [...lines];
  let content = fittedLines.join('\n');

  while (
    fittedLines.length > 1 &&
    Buffer.byteLength(content, 'utf8') > MAX_READ_FILE_BYTES
  ) {
    fittedLines = fittedLines.slice(0, -1);
    content = fittedLines.join('\n');
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_READ_FILE_BYTES) {
    throw new Error(
      `The selected line window exceeds ${MAX_READ_FILE_BYTES} bytes even after reducing to one line.`,
    );
  }

  return {
    content,
    lines: fittedLines,
  };
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
        message: 'Permission denied while reading the file.',
      },
    };
  }

  return {
    ok: false,
    path,
    error: {
      code: 'read_failed',
      message: error instanceof Error ? error.message : 'Unable to read file.',
    },
  };
}

function hasCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && error['code'] === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
