import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  CanonicalLlmProvider,
  LlmChatMessage,
  LlmChatRequestBody,
  LlmChatResponse,
  LlmProviderInfo,
  NormalizedLlmChatRequest,
} from './llm.types';

type JsonObject = Record<string, unknown>;

interface ProviderCatalogEntry {
  aliases: string[];
  apiKeyEnv: string;
  defaultModel: string;
  displayName: string;
  docsUrl: string;
  exampleModels: string[];
}

const FETCH_TIMEOUT_MS = 60_000;

const PROVIDER_CATALOG: Record<CanonicalLlmProvider, ProviderCatalogEntry> = {
  openai: {
    aliases: ['gpt'],
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4',
    displayName: 'OpenAI',
    docsUrl: 'https://developers.openai.com/api/docs/models',
    exampleModels: [
      'gpt-5.4',
      'gpt-5-mini',
      'gpt-5.4-nano',
      'gpt-5.4-mini',
      'gpt-4.1',
    ],
  },
  gemini: {
    aliases: ['google'],
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3-flash-preview',
    displayName: 'Google Gemini',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    exampleModels: [
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
      'gemini-2.5-flash',
    ],
  },
  anthropic: {
    aliases: ['claude'],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-6',
    displayName: 'Anthropic Claude',
    docsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    exampleModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
};

@Injectable()
export class LlmService {
  getProviders(): LlmProviderInfo[] {
    return Object.entries(PROVIDER_CATALOG).map(([provider, config]) => ({
      provider: provider as CanonicalLlmProvider,
      displayName: config.displayName,
      aliases: [...config.aliases],
      apiKeyEnv: config.apiKeyEnv,
      enabled: Boolean(process.env[config.apiKeyEnv]),
      defaultModel: config.defaultModel,
      exampleModels: [...config.exampleModels],
      docsUrl: config.docsUrl,
      allowCustomModel: true,
    }));
  }

  getProvider(providerInput: string): LlmProviderInfo {
    const provider = normalizeProvider(providerInput);
    const config = PROVIDER_CATALOG[provider];

    return {
      provider,
      displayName: config.displayName,
      aliases: [...config.aliases],
      apiKeyEnv: config.apiKeyEnv,
      enabled: Boolean(process.env[config.apiKeyEnv]),
      defaultModel: config.defaultModel,
      exampleModels: [...config.exampleModels],
      docsUrl: config.docsUrl,
      allowCustomModel: true,
    };
  }

  async chat(requestBody: LlmChatRequestBody): Promise<LlmChatResponse> {
    const request = normalizeChatRequest(requestBody);

    switch (request.provider) {
      case 'openai':
        return this.callOpenAi(request);
      case 'gemini':
        return this.callGemini(request);
      case 'anthropic':
        return this.callAnthropic(request);
      default:
        throw new BadRequestException('Unsupported LLM provider.');
    }
  }

  private async callOpenAi(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const apiKey = this.getRequiredApiKey('openai');
    const systemInstructions = getCombinedMessageText(
      request.messages,
      'system',
    );
    const conversationMessages = request.messages.filter(
      (message) => message.role !== 'system',
    );

    const payload: JsonObject = {
      model: request.model,
      store: false,
      input: conversationMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };

    if (systemInstructions) {
      payload.instructions = systemInstructions;
    }

    if (typeof request.maxTokens === 'number') {
      payload.max_output_tokens = request.maxTokens;
    }

    if (typeof request.temperature === 'number') {
      payload.temperature = request.temperature;
    }

    const data = await this.postJson(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      'OpenAI',
    );

    const usage = getObjectValue(data, 'usage');

    return {
      provider: 'openai',
      model: request.model,
      responseId: getStringValue(data, 'id'),
      text: this.extractOpenAiText(data),
      finishReason: getStringValue(data, 'status'),
      usage: {
        inputTokens: getNumberValue(usage, 'input_tokens'),
        outputTokens: getNumberValue(usage, 'output_tokens'),
        totalTokens: getNumberValue(usage, 'total_tokens'),
      },
    };
  }

  private async callGemini(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const apiKey = this.getRequiredApiKey('gemini');
    const systemInstructions = getCombinedMessageText(
      request.messages,
      'system',
    );
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const payload: JsonObject = {
      contents,
    };

    const generationConfig: JsonObject = {};
    if (systemInstructions) {
      payload.systemInstruction = {
        parts: [{ text: systemInstructions }],
      };
    }

    if (typeof request.maxTokens === 'number') {
      generationConfig.maxOutputTokens = request.maxTokens;
    }

    if (typeof request.temperature === 'number') {
      generationConfig.temperature = request.temperature;
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    const encodedModel = encodeURIComponent(request.model);
    const data = await this.postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      },
      'Gemini',
    );

    const usage = getObjectValue(data, 'usageMetadata');
    const candidates = getArrayValue(data, 'candidates');
    const firstCandidate = getObject(candidates[0]);

    return {
      provider: 'gemini',
      model: request.model,
      responseId: getStringValue(data, 'responseId'),
      text: this.extractGeminiText(firstCandidate),
      finishReason: getStringValue(firstCandidate, 'finishReason'),
      usage: {
        inputTokens: getNumberValue(usage, 'promptTokenCount'),
        outputTokens: getNumberValue(usage, 'candidatesTokenCount'),
        totalTokens: getNumberValue(usage, 'totalTokenCount'),
      },
    };
  }

  private async callAnthropic(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const apiKey = this.getRequiredApiKey('anthropic');
    const systemPrompt = getCombinedMessageText(request.messages, 'system');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const payload: JsonObject = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
    };

    if (systemPrompt) {
      payload.system = systemPrompt;
    }

    if (typeof request.temperature === 'number') {
      payload.temperature = request.temperature;
    }

    const data = await this.postJson(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      },
      'Anthropic',
    );

    const usage = getObjectValue(data, 'usage');

    return {
      provider: 'anthropic',
      model: request.model,
      responseId: getStringValue(data, 'id'),
      text: this.extractAnthropicText(data),
      finishReason: getStringValue(data, 'stop_reason'),
      usage: {
        inputTokens: getNumberValue(usage, 'input_tokens'),
        outputTokens: getNumberValue(usage, 'output_tokens'),
        totalTokens:
          getNumberValue(usage, 'input_tokens') !== undefined &&
          getNumberValue(usage, 'output_tokens') !== undefined
            ? (getNumberValue(usage, 'input_tokens') ?? 0) +
              (getNumberValue(usage, 'output_tokens') ?? 0)
            : undefined,
      },
    };
  }

  private getRequiredApiKey(provider: CanonicalLlmProvider): string {
    const envVar = PROVIDER_CATALOG[provider].apiKeyEnv;
    const apiKey = process.env[envVar];

    if (!apiKey) {
      throw new ServiceUnavailableException(
        `Missing ${envVar}. Set the API key before calling ${provider} models.`,
      );
    }

    return apiKey;
  }

  private async postJson(
    url: string,
    init: RequestInit,
    providerName: string,
  ): Promise<JsonObject> {
    let response: Response;

    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown network error';

      throw new BadGatewayException(
        `${providerName} request failed: ${message}`,
      );
    }

    const data = await parseResponseBody(response);

    if (!response.ok) {
      const message = extractProviderErrorMessage(data);
      throw new BadGatewayException(
        `${providerName} request failed with status ${response.status}: ${message}`,
      );
    }

    return data;
  }

  private extractOpenAiText(data: JsonObject): string {
    const directText = getStringValue(data, 'output_text');
    if (directText) {
      return directText;
    }

    const outputItems = getArrayValue(data, 'output');
    const textParts: string[] = [];

    for (const item of outputItems) {
      const outputItem = getObject(item);
      if (getStringValue(outputItem, 'type') !== 'message') {
        continue;
      }

      const content = getArrayValue(outputItem, 'content');
      for (const contentItem of content) {
        const outputContent = getObject(contentItem);
        const type = getStringValue(outputContent, 'type');
        const text = getStringValue(outputContent, 'text');

        if (
          (type === 'output_text' || type === 'text') &&
          typeof text === 'string'
        ) {
          textParts.push(text);
        }
      }
    }

    if (textParts.length === 0) {
      throw new BadGatewayException('OpenAI returned an empty text response.');
    }

    return textParts.join('\n');
  }

  private extractGeminiText(candidate: JsonObject): string {
    const content = getObjectValue(candidate, 'content');
    const parts = getArrayValue(content, 'parts');
    const texts = parts
      .map((part) => getStringValue(getObject(part), 'text'))
      .filter((value): value is string => typeof value === 'string');

    if (texts.length === 0) {
      throw new BadGatewayException('Gemini returned an empty text response.');
    }

    return texts.join('\n');
  }

  private extractAnthropicText(data: JsonObject): string {
    const content = getArrayValue(data, 'content');
    const texts = content
      .map((item) => {
        const block = getObject(item);
        return getStringValue(block, 'type') === 'text'
          ? getStringValue(block, 'text')
          : undefined;
      })
      .filter((value): value is string => typeof value === 'string');

    if (texts.length === 0) {
      throw new BadGatewayException(
        'Anthropic returned an empty text response.',
      );
    }

    return texts.join('\n');
  }
}

function normalizeChatRequest(
  requestBody: LlmChatRequestBody,
): NormalizedLlmChatRequest {
  if (!isObject(requestBody)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const provider = normalizeProvider(requestBody.provider);
  const model = requestBody.model?.trim();

  if (!model) {
    throw new BadRequestException('`model` must be a non-empty string.');
  }

  if (
    !Array.isArray(requestBody.messages) ||
    requestBody.messages.length === 0
  ) {
    throw new BadRequestException('`messages` must be a non-empty array.');
  }

  const messages = requestBody.messages.map(normalizeMessage);
  const conversationalMessages = messages.filter(
    (message) => message.role !== 'system',
  );

  if (conversationalMessages.length === 0) {
    throw new BadRequestException(
      'At least one `user` or `assistant` message is required.',
    );
  }

  const maxTokens = normalizeOptionalPositiveInteger(
    requestBody.maxTokens,
    'maxTokens',
  );
  const temperature = normalizeOptionalNumber(
    requestBody.temperature,
    'temperature',
  );

  return {
    provider,
    model,
    messages,
    maxTokens,
    temperature,
  };
}

function normalizeProvider(providerInput: string): CanonicalLlmProvider {
  const normalized = providerInput?.trim().toLowerCase();

  if (!normalized) {
    throw new BadRequestException('`provider` must be a non-empty string.');
  }

  for (const [provider, config] of Object.entries(PROVIDER_CATALOG)) {
    if (normalized === provider || config.aliases.includes(normalized)) {
      return provider as CanonicalLlmProvider;
    }
  }

  throw new BadRequestException(
    '`provider` must be one of: openai, gpt, gemini, anthropic, claude.',
  );
}

function normalizeMessage(message: unknown): LlmChatMessage {
  if (!isObject(message)) {
    throw new BadRequestException('Each message must be a JSON object.');
  }

  const role = getStringValue(message, 'role')?.trim().toLowerCase();
  const content = getStringValue(message, 'content')?.trim();

  if (!role || !['system', 'user', 'assistant'].includes(role)) {
    throw new BadRequestException(
      '`messages[].role` must be `system`, `user`, or `assistant`.',
    );
  }

  if (!content) {
    throw new BadRequestException(
      '`messages[].content` must be a non-empty string.',
    );
  }

  return {
    role: role as LlmChatMessage['role'],
    content,
  };
}

function normalizeOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(
      `\`${fieldName}\` must be a positive integer.`,
    );
  }

  return value;
}

function normalizeOptionalNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`\`${fieldName}\` must be a finite number.`);
  }

  return value;
}

function getCombinedMessageText(
  messages: LlmChatMessage[],
  role: LlmChatMessage['role'],
): string | undefined {
  const matchingMessages = messages
    .filter((message) => message.role === role)
    .map((message) => message.content.trim())
    .filter(Boolean);

  return matchingMessages.length > 0
    ? matchingMessages.join('\n\n')
    : undefined;
}

async function parseResponseBody(response: Response): Promise<JsonObject> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return getObject(parsed);
  } catch {
    return { message: text };
  }
}

function extractProviderErrorMessage(data: JsonObject): string {
  const error = getObjectValue(data, 'error');

  return (
    getStringValue(error, 'message') ??
    getStringValue(data, 'message') ??
    'Unknown provider error.'
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function getObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function getObjectValue(
  object: JsonObject | undefined,
  key: string,
): JsonObject | undefined {
  if (!object) {
    return undefined;
  }

  const value = object[key];
  return isObject(value) ? value : undefined;
}

function getArrayValue(object: JsonObject | undefined, key: string): unknown[] {
  if (!object) {
    return [];
  }

  const value = object[key];
  return Array.isArray(value) ? value : [];
}

function getStringValue(
  object: JsonObject | undefined,
  key: string,
): string | undefined {
  if (!object) {
    return undefined;
  }

  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumberValue(
  object: JsonObject | undefined,
  key: string,
): number | undefined {
  if (!object) {
    return undefined;
  }

  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
