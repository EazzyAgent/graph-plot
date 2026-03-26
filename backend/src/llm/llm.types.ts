export const CANONICAL_LLM_PROVIDERS = [
  'openai',
  'gemini',
  'anthropic',
] as const;

export const LLM_MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;
export const LLM_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

export type CanonicalLlmProvider = (typeof CANONICAL_LLM_PROVIDERS)[number];
export type LlmMessageRole = (typeof LLM_MESSAGE_ROLES)[number];
export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

export interface LlmChatImageInput {
  mimeType: string;
  base64Data: string;
}

export interface LlmChatMessage {
  role: LlmMessageRole;
  content: string;
  images?: LlmChatImageInput[];
}

export interface LlmChatToolOptions {
  fileSystem?: boolean;
}

export interface LlmStructuredOutputSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface LlmChatRequestBody {
  provider: string;
  model: string;
  messages: LlmChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: LlmReasoningEffort;
  tools?: LlmChatToolOptions;
  structuredOutput?: LlmStructuredOutputSchema;
}

export interface NormalizedLlmChatToolOptions {
  fileSystem: boolean;
}

export interface NormalizedLlmChatRequest {
  provider: CanonicalLlmProvider;
  model: string;
  messages: LlmChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: LlmReasoningEffort;
  tools: NormalizedLlmChatToolOptions;
  structuredOutput?: LlmStructuredOutputSchema;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmToolTraceEntry {
  round: number;
  toolName: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  callId?: string;
}

export interface LlmChatResponse {
  provider: CanonicalLlmProvider;
  model: string;
  responseId?: string;
  text: string;
  finishReason?: string;
  usage: LlmUsage;
  toolTrace?: LlmToolTraceEntry[];
}

export interface LlmProviderInfo {
  provider: CanonicalLlmProvider;
  displayName: string;
  aliases: string[];
  apiKeyEnv: string;
  enabled: boolean;
  defaultModel: string;
  exampleModels: string[];
  docsUrl: string;
  allowCustomModel: true;
}
