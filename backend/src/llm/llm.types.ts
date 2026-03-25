export const CANONICAL_LLM_PROVIDERS = [
  'openai',
  'gemini',
  'anthropic',
] as const;

export const LLM_MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;

export type CanonicalLlmProvider = (typeof CANONICAL_LLM_PROVIDERS)[number];
export type LlmMessageRole = (typeof LLM_MESSAGE_ROLES)[number];

export interface LlmChatMessage {
  role: LlmMessageRole;
  content: string;
}

export interface LlmChatRequestBody {
  provider: string;
  model: string;
  messages: LlmChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface NormalizedLlmChatRequest {
  provider: CanonicalLlmProvider;
  model: string;
  messages: LlmChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmChatResponse {
  provider: CanonicalLlmProvider;
  model: string;
  responseId?: string;
  text: string;
  finishReason?: string;
  usage: LlmUsage;
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
