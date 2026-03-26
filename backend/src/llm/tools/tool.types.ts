export type ToolJsonObject = Record<string, unknown>;

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolJsonObject;
}

export interface LlmToolExecutionResult {
  toolName: string;
  isError: boolean;
  content: ToolJsonObject;
}

export interface LlmToolHandler {
  readonly definition: LlmToolDefinition;
  execute(input: unknown): Promise<ToolJsonObject>;
}
