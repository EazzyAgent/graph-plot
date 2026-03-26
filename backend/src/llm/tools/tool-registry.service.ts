import { Injectable } from '@nestjs/common';
import { InspectPathTool } from './inspect-path.tool';
import { ReadFileTool } from './read-file.tool';
import type {
  LlmToolDefinition,
  LlmToolExecutionResult,
  LlmToolHandler,
} from './tool.types';

@Injectable()
export class ToolRegistryService {
  private readonly tools: Map<string, LlmToolHandler>;

  constructor(
    private readonly inspectPathTool: InspectPathTool,
    private readonly readFileTool: ReadFileTool,
  ) {
    this.tools = new Map(
      [inspectPathTool, readFileTool].map((tool) => [
        tool.definition.name,
        tool,
      ]),
    );
  }

  getDefinitions(): LlmToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  async executeTool(
    toolName: string,
    input: unknown,
  ): Promise<LlmToolExecutionResult> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        toolName,
        isError: true,
        content: {
          ok: false,
          error: {
            code: 'tool_not_found',
            message: `Tool "${toolName}" is not registered.`,
          },
        },
      };
    }

    try {
      const content = await tool.execute(input);
      const isError = content['ok'] === false;

      return {
        toolName,
        isError,
        content,
      };
    } catch (error) {
      return {
        toolName,
        isError: true,
        content: {
          ok: false,
          error: {
            code: 'invalid_input',
            message:
              error instanceof Error
                ? error.message
                : 'Invalid tool arguments.',
          },
        },
      };
    }
  }
}
