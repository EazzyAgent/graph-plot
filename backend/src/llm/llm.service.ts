import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ToolRegistryService } from './tools/tool-registry.service';
import type { LlmToolExecutionResult } from './tools/tool.types';
import type {
  CanonicalLlmProvider,
  LlmChatImageInput,
  LlmChatMessage,
  LlmChatRequestBody,
  LlmStructuredOutputSchema,
  LlmReasoningEffort,
  LlmChatResponse,
  LlmProviderInfo,
  LlmToolTraceEntry,
  NormalizedLlmChatRequest,
  NormalizedLlmChatToolOptions,
} from './llm.types';
import { LLM_REASONING_EFFORTS } from './llm.types';

type JsonObject = Record<string, unknown>;

interface ProviderCatalogEntry {
  aliases: string[];
  apiKeyEnv: string;
  defaultModel: string;
  displayName: string;
  docsUrl: string;
  exampleModels: string[];
}

interface OpenAiToolCall {
  argumentsText: string;
  callId: string;
  name: string;
}

interface GeminiToolCall {
  args: unknown;
  name: string;
}

interface AnthropicToolCall {
  id: string;
  input: unknown;
  name: string;
}

interface OpenAiRequestOptions {
  previousResponseId?: string;
  store?: boolean;
}

interface ResolvedOpenAiToolCall {
  result: LlmToolExecutionResult;
  traceInput: unknown;
}

const FETCH_TIMEOUT_MS = 60_000;
const MAX_TOOL_ROUNDS = 6;
const FILE_SYSTEM_TOOL_GUIDANCE = `
When using filesystem tools:
- Use inspect_path first when you need to discover files or folders.
- Use read_file iteratively to save tokens.
- On the first read_file call for a file, set startLine to 1.
- Infer lineCount from the user's request and keep it as small as practical.
- If you still need more context before answering, call read_file again with startLine set to the next unread line.
- Do not read an entire file unless the user's request clearly requires it.
`.trim();

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
  constructor(private readonly toolRegistry: ToolRegistryService) {}

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
    return request.tools.fileSystem
      ? this.callOpenAiWithTools(request)
      : this.callOpenAiWithoutTools(request);
  }

  private async callOpenAiWithoutTools(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const systemInstructions = getCombinedMessageText(
      request.messages,
      'system',
    );
    const conversationMessages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => this.toOpenAiMessageInput(message));

    const data = await this.postOpenAiRequest(
      request,
      conversationMessages,
      systemInstructions,
    );

    return this.buildOpenAiResponse(request, data);
  }

  private async callOpenAiWithTools(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const systemInstructions = combineSystemInstructions(
      getCombinedMessageText(request.messages, 'system'),
      FILE_SYSTEM_TOOL_GUIDANCE,
    );
    let input: JsonObject[] = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => this.toOpenAiMessageInput(message));
    const tools = this.getOpenAiToolDefinitions();
    const toolTrace: LlmToolTraceEntry[] = [];
    let previousResponseId: string | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const data = await this.postOpenAiRequest(
        request,
        input,
        systemInstructions,
        tools,
        {
          store: true,
          previousResponseId,
        },
      );
      const toolCalls = this.extractOpenAiToolCalls(data);

      if (toolCalls.length === 0) {
        return this.buildOpenAiResponse(request, data, toolTrace);
      }

      if (round === MAX_TOOL_ROUNDS) {
        throw new BadGatewayException(
          `OpenAI exceeded the maximum tool round limit of ${MAX_TOOL_ROUNDS}.`,
        );
      }

      previousResponseId = getStringValue(data, 'id');
      if (!previousResponseId) {
        throw new BadGatewayException(
          'OpenAI did not return a response id for a stored tool response.',
        );
      }

      input = [];

      for (const toolCall of toolCalls) {
        const resolvedToolCall = await this.resolveOpenAiToolCall(toolCall);
        const resultPayload = buildToolResultPayload(resolvedToolCall.result);

        toolTrace.push({
          round: round + 1,
          callId: toolCall.callId,
          toolName: toolCall.name,
          input: resolvedToolCall.traceInput,
          result: resultPayload,
          isError: resolvedToolCall.result.isError,
        });

        input.push({
          type: 'function_call_output',
          call_id: toolCall.callId,
          output: JSON.stringify(resultPayload),
        });
      }
    }

    throw new BadGatewayException('OpenAI tool loop terminated unexpectedly.');
  }

  private async callGemini(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    return request.tools.fileSystem
      ? this.callGeminiWithTools(request)
      : this.callGeminiWithoutTools(request);
  }

  private async callGeminiWithoutTools(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const systemInstructions = getCombinedMessageText(
      request.messages,
      'system',
    );
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => this.toGeminiMessage(message));

    const data = await this.postGeminiRequest(
      request,
      contents,
      systemInstructions,
    );

    return this.buildGeminiResponse(request, data);
  }

  private async callGeminiWithTools(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const systemInstructions = combineSystemInstructions(
      getCombinedMessageText(request.messages, 'system'),
      FILE_SYSTEM_TOOL_GUIDANCE,
    );
    const contents: JsonObject[] = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => this.toGeminiMessage(message));
    const tools = this.getGeminiToolDefinitions();
    const toolTrace: LlmToolTraceEntry[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const data = await this.postGeminiRequest(
        request,
        contents,
        systemInstructions,
        tools,
      );
      const candidates = getArrayValue(data, 'candidates');
      const firstCandidate = getObject(candidates[0]);
      const candidateContent = getObjectValue(firstCandidate, 'content') ?? {
        role: 'model',
        parts: [],
      };
      const toolCalls = extractGeminiToolCalls(candidateContent);

      if (toolCalls.length === 0) {
        return this.buildGeminiResponse(request, data, toolTrace);
      }

      if (round === MAX_TOOL_ROUNDS) {
        throw new BadGatewayException(
          `Gemini exceeded the maximum tool round limit of ${MAX_TOOL_ROUNDS}.`,
        );
      }

      contents.push(candidateContent);

      const executedToolCalls = await Promise.all(
        toolCalls.map(async (toolCall) => ({
          toolCall,
          result: await this.toolRegistry.executeTool(
            toolCall.name,
            toolCall.args,
          ),
        })),
      );

      const functionResponses = executedToolCalls.map(
        ({ toolCall, result }) => {
          toolTrace.push({
            round: round + 1,
            toolName: toolCall.name,
            input: toolCall.args,
            result: buildToolResultPayload(result),
            isError: result.isError,
          });

          return {
            functionResponse: {
              name: toolCall.name,
              response: result.content,
            },
          };
        },
      );

      contents.push({
        role: 'user',
        parts: functionResponses,
      });
    }

    throw new BadGatewayException('Gemini tool loop terminated unexpectedly.');
  }

  private async callAnthropic(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    return request.tools.fileSystem
      ? this.callAnthropicWithTools(request)
      : this.callAnthropicWithoutTools(request);
  }

  private async callAnthropicWithoutTools(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const systemPrompt = getCombinedMessageText(request.messages, 'system');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => this.toAnthropicMessage(message));

    const data = await this.postAnthropicRequest(
      request,
      messages,
      systemPrompt,
    );

    return this.buildAnthropicResponse(request, data);
  }

  private async callAnthropicWithTools(
    request: NormalizedLlmChatRequest,
  ): Promise<LlmChatResponse> {
    const systemPrompt = combineSystemInstructions(
      getCombinedMessageText(request.messages, 'system'),
      FILE_SYSTEM_TOOL_GUIDANCE,
    );
    const messages: JsonObject[] = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => this.toAnthropicMessage(message));
    const tools = this.getAnthropicToolDefinitions();
    const toolTrace: LlmToolTraceEntry[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const data = await this.postAnthropicRequest(
        request,
        messages,
        systemPrompt,
        tools,
      );
      const content = getArrayValue(data, 'content').map((item) =>
        getObject(item),
      );
      const toolCalls = extractAnthropicToolCalls(content);

      if (toolCalls.length === 0) {
        return this.buildAnthropicResponse(request, data, toolTrace);
      }

      if (round === MAX_TOOL_ROUNDS) {
        throw new BadGatewayException(
          `Anthropic exceeded the maximum tool round limit of ${MAX_TOOL_ROUNDS}.`,
        );
      }

      messages.push({
        role: 'assistant',
        content,
      });

      const executedToolCalls = await Promise.all(
        toolCalls.map(async (toolCall) => ({
          toolCall,
          result: await this.toolRegistry.executeTool(
            toolCall.name,
            toolCall.input,
          ),
        })),
      );

      const toolResults = executedToolCalls.map(({ toolCall, result }) => {
        toolTrace.push({
          round: round + 1,
          callId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
          result: buildToolResultPayload(result),
          isError: result.isError,
        });

        return {
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: stringifyToolResult(result),
          is_error: result.isError,
        };
      });

      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    throw new BadGatewayException(
      'Anthropic tool loop terminated unexpectedly.',
    );
  }

  private async resolveOpenAiToolCall(
    toolCall: OpenAiToolCall,
  ): Promise<ResolvedOpenAiToolCall> {
    const parsedInput = safeJsonParse(toolCall.argumentsText);

    if (!parsedInput.ok) {
      return {
        traceInput: {
          rawArgumentsText: toolCall.argumentsText,
        },
        result: createToolArgumentError(
          toolCall.name,
          'invalid_arguments_json',
          parsedInput.message,
        ),
      };
    }

    return {
      traceInput: parsedInput.value,
      result: await this.toolRegistry.executeTool(
        toolCall.name,
        parsedInput.value,
      ),
    };
  }

  private getOpenAiToolDefinitions(): JsonObject[] {
    return this.toolRegistry.getDefinitions().map((definition) => ({
      type: 'function',
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
      strict: true,
    }));
  }

  private getGeminiToolDefinitions(): JsonObject[] {
    return [
      {
        functionDeclarations: this.toolRegistry
          .getDefinitions()
          .map((definition) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.inputSchema,
          })),
      },
    ];
  }

  private getAnthropicToolDefinitions(): JsonObject[] {
    return this.toolRegistry.getDefinitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      input_schema: definition.inputSchema,
    }));
  }

  private async postOpenAiRequest(
    request: NormalizedLlmChatRequest,
    input: JsonObject[],
    systemInstructions?: string,
    tools?: JsonObject[],
    options?: OpenAiRequestOptions,
  ): Promise<JsonObject> {
    const apiKey = this.getRequiredApiKey('openai');
    const payload: JsonObject = {
      model: request.model,
      store: options?.store ?? false,
      input,
    };

    if (options?.previousResponseId) {
      payload.previous_response_id = options.previousResponseId;
    }

    if (systemInstructions) {
      payload.instructions = systemInstructions;
    }

    if (typeof request.maxTokens === 'number') {
      payload.max_output_tokens = request.maxTokens;
    }

    if (
      typeof request.temperature === 'number' &&
      supportsOpenAiTemperature(request.model)
    ) {
      payload.temperature = request.temperature;
    }

    if (request.structuredOutput) {
      payload.text = {
        format: buildOpenAiStructuredOutputFormat(request.structuredOutput),
      };
    }

    const reasoning = getOpenAiReasoningConfig(
      request.model,
      request.reasoningEffort,
    );

    if (reasoning) {
      payload.reasoning = reasoning;
    }

    if (tools) {
      payload.tools = tools;
    }

    return this.postJson(
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
  }

  private async postGeminiRequest(
    request: NormalizedLlmChatRequest,
    contents: JsonObject[],
    systemInstructions?: string,
    tools?: JsonObject[],
  ): Promise<JsonObject> {
    const apiKey = this.getRequiredApiKey('gemini');
    const payload: JsonObject = { contents };
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

    const thinkingConfig = getGeminiThinkingConfig(
      request.model,
      request.reasoningEffort,
    );

    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    if (tools) {
      payload.tools = tools;
      payload.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO',
        },
      };
    }

    const encodedModel = encodeURIComponent(request.model);

    return this.postJson(
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
  }

  private async postAnthropicRequest(
    request: NormalizedLlmChatRequest,
    messages: JsonObject[],
    systemPrompt?: string,
    tools?: JsonObject[],
  ): Promise<JsonObject> {
    const apiKey = this.getRequiredApiKey('anthropic');
    const anthropicThinking = getAnthropicThinkingConfig(
      request.model,
      request.reasoningEffort,
      request.maxTokens,
    );
    const payload: JsonObject = {
      model: request.model,
      max_tokens: anthropicThinking.maxTokens,
      messages,
    };

    if (systemPrompt) {
      payload.system = systemPrompt;
    }

    if (typeof request.temperature === 'number') {
      payload.temperature = request.temperature;
    }

    if (anthropicThinking.thinking) {
      payload.thinking = anthropicThinking.thinking;
    }

    if (tools) {
      payload.tools = tools;
      payload.tool_choice = { type: 'auto' };
    }

    return this.postJson(
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
  }

  private buildOpenAiResponse(
    request: NormalizedLlmChatRequest,
    data: JsonObject,
    toolTrace: LlmToolTraceEntry[] = [],
  ): LlmChatResponse {
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
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    };
  }

  private buildGeminiResponse(
    request: NormalizedLlmChatRequest,
    data: JsonObject,
    toolTrace: LlmToolTraceEntry[] = [],
  ): LlmChatResponse {
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
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    };
  }

  private buildAnthropicResponse(
    request: NormalizedLlmChatRequest,
    data: JsonObject,
    toolTrace: LlmToolTraceEntry[] = [],
  ): LlmChatResponse {
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
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    };
  }

  private toOpenAiMessageInput(message: LlmChatMessage): JsonObject {
    if (!message.images || message.images.length === 0) {
      return {
        role: message.role,
        content: message.content,
      };
    }

    const contentParts: JsonObject[] = [];

    if (message.content.length > 0) {
      contentParts.push({
        type: 'input_text',
        text: message.content,
      });
    }

    contentParts.push(
      ...message.images.map((image) => ({
        type: 'input_image',
        image_url: toDataUrl(image),
      })),
    );

    return {
      role: message.role,
      content: contentParts,
    };
  }

  private toGeminiMessage(message: LlmChatMessage): JsonObject {
    const parts: JsonObject[] = [];

    if (message.content.length > 0) {
      parts.push({ text: message.content });
    }

    if (message.images) {
      parts.push(
        ...message.images.map((image) => ({
          inlineData: {
            mimeType: image.mimeType,
            data: image.base64Data,
          },
        })),
      );
    }

    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts,
    };
  }

  private toAnthropicMessage(message: LlmChatMessage): JsonObject {
    if (!message.images || message.images.length === 0) {
      return {
        role: message.role,
        content: message.content,
      };
    }

    const content: JsonObject[] = [];

    if (message.content.length > 0) {
      content.push({
        type: 'text',
        text: message.content,
      });
    }

    content.push(
      ...message.images.map((image) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType,
          data: image.base64Data,
        },
      })),
    );

    return {
      role: message.role,
      content,
    };
  }

  private extractOpenAiToolCalls(data: JsonObject): OpenAiToolCall[] {
    return getArrayValue(data, 'output')
      .map((item) => getObject(item))
      .filter((item) => getStringValue(item, 'type') === 'function_call')
      .map((item) => ({
        name: getStringValue(item, 'name') ?? '',
        callId: getStringValue(item, 'call_id') ?? '',
        argumentsText: getStringValue(item, 'arguments') ?? '',
      }))
      .filter(
        (toolCall) =>
          toolCall.name.length > 0 &&
          toolCall.callId.length > 0 &&
          toolCall.argumentsText.length > 0,
      );
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
  const reasoningEffort = normalizeOptionalReasoningEffort(
    requestBody.reasoningEffort,
  );
  const tools = normalizeToolOptions(requestBody.tools);
  const structuredOutput = normalizeStructuredOutput(
    requestBody.structuredOutput,
  );

  return {
    provider,
    model,
    messages,
    maxTokens,
    temperature,
    reasoningEffort,
    tools,
    ...(structuredOutput ? { structuredOutput } : {}),
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
  const content = getStringValue(message, 'content')?.trim() ?? '';
  const images = normalizeImages(message['images']);

  if (!role || !['system', 'user', 'assistant'].includes(role)) {
    throw new BadRequestException(
      '`messages[].role` must be `system`, `user`, or `assistant`.',
    );
  }

  if (!content && images.length === 0) {
    throw new BadRequestException(
      '`messages[].content` must be a non-empty string unless images are provided.',
    );
  }

  return {
    role: role as LlmChatMessage['role'],
    content,
    ...(images.length > 0 ? { images } : {}),
  };
}

function normalizeImages(value: unknown): LlmChatImageInput[] {
  if (typeof value === 'undefined') {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new BadRequestException('`messages[].images` must be an array.');
  }

  return value.map((image, index) => {
    if (!isObject(image)) {
      throw new BadRequestException(
        `\`messages[].images[${index}]\` must be a JSON object.`,
      );
    }

    const mimeType = getStringValue(image, 'mimeType')?.trim();
    const base64Data = getStringValue(image, 'base64Data')?.trim();

    if (!mimeType || !mimeType.startsWith('image/')) {
      throw new BadRequestException(
        `\`messages[].images[${index}].mimeType\` must be an image MIME type.`,
      );
    }

    if (!base64Data) {
      throw new BadRequestException(
        `\`messages[].images[${index}].base64Data\` must be a non-empty base64 string.`,
      );
    }

    return {
      mimeType,
      base64Data,
    };
  });
}

function normalizeToolOptions(tools: unknown): NormalizedLlmChatToolOptions {
  if (typeof tools === 'undefined') {
    return { fileSystem: false };
  }

  if (!isObject(tools)) {
    throw new BadRequestException(
      '`tools` must be a JSON object when provided.',
    );
  }

  const fileSystem = tools['fileSystem'];

  if (typeof fileSystem === 'undefined') {
    return { fileSystem: false };
  }

  if (typeof fileSystem !== 'boolean') {
    throw new BadRequestException('`tools.fileSystem` must be a boolean.');
  }

  return { fileSystem };
}

function normalizeStructuredOutput(
  value: unknown,
): LlmStructuredOutputSchema | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (!isObject(value)) {
    throw new BadRequestException(
      '`structuredOutput` must be a JSON object when provided.',
    );
  }

  const name = requireNonEmptyString(
    value.name,
    '`structuredOutput.name` must be a non-empty string.',
  );
  const schema = value.schema;

  if (!isObject(schema)) {
    throw new BadRequestException(
      '`structuredOutput.schema` must be a JSON object.',
    );
  }

  if (
    typeof value.strict !== 'undefined' &&
    typeof value.strict !== 'boolean'
  ) {
    throw new BadRequestException(
      '`structuredOutput.strict` must be a boolean when provided.',
    );
  }

  return {
    name,
    schema,
    strict: value.strict === false ? false : true,
  };
}

function requireNonEmptyString(value: unknown, errorMessage: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(errorMessage);
  }

  return value.trim();
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

function normalizeOptionalReasoningEffort(
  value: unknown,
): LlmReasoningEffort | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestException(
      '`reasoningEffort` must be one of: none, low, medium, high.',
    );
  }

  const normalized = value.trim().toLowerCase();

  if (
    !LLM_REASONING_EFFORTS.includes(
      normalized as (typeof LLM_REASONING_EFFORTS)[number],
    )
  ) {
    throw new BadRequestException(
      '`reasoningEffort` must be one of: none, low, medium, high.',
    );
  }

  return normalized as LlmReasoningEffort;
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

function combineSystemInstructions(
  ...parts: Array<string | undefined>
): string | undefined {
  const definedParts = parts.map((part) => part?.trim()).filter(Boolean);

  return definedParts.length > 0 ? definedParts.join('\n\n') : undefined;
}

function extractGeminiToolCalls(
  candidateContent: JsonObject,
): GeminiToolCall[] {
  return getArrayValue(candidateContent, 'parts')
    .map((part) => getObject(part))
    .map((part) => getObjectValue(part, 'functionCall'))
    .filter((part): part is JsonObject => typeof part !== 'undefined')
    .map((part) => ({
      name: getStringValue(part, 'name') ?? '',
      args: part['args'],
    }))
    .filter((toolCall) => toolCall.name.length > 0);
}

function extractAnthropicToolCalls(content: JsonObject[]): AnthropicToolCall[] {
  return content
    .filter((block) => getStringValue(block, 'type') === 'tool_use')
    .map((block) => ({
      id: getStringValue(block, 'id') ?? '',
      name: getStringValue(block, 'name') ?? '',
      input: block['input'],
    }))
    .filter((toolCall) => toolCall.id.length > 0 && toolCall.name.length > 0);
}

function createToolArgumentError(
  toolName: string,
  code: string,
  message: string,
): LlmToolExecutionResult {
  return {
    toolName,
    isError: true,
    content: {
      ok: false,
      error: {
        code,
        message,
      },
    },
  };
}

function buildToolResultPayload(result: LlmToolExecutionResult): JsonObject {
  return {
    tool: result.toolName,
    ...result.content,
  };
}

function toDataUrl(image: LlmChatImageInput): string {
  return `data:${image.mimeType};base64,${image.base64Data}`;
}

function stringifyToolResult(result: LlmToolExecutionResult): string {
  return JSON.stringify(buildToolResultPayload(result));
}

function getOpenAiReasoningConfig(
  model: string,
  reasoningEffort: LlmReasoningEffort | undefined,
): JsonObject | undefined {
  if (
    !reasoningEffort ||
    reasoningEffort === 'none' ||
    !supportsOpenAiReasoning(model)
  ) {
    return undefined;
  }

  return {
    effort: reasoningEffort,
  };
}

function supportsOpenAiReasoning(model: string): boolean {
  const normalized = model.trim().toLowerCase();

  return (
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  );
}

function supportsOpenAiTemperature(model: string): boolean {
  const normalized = model.trim().toLowerCase();

  return !(
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  );
}

function buildOpenAiStructuredOutputFormat(
  structuredOutput: LlmStructuredOutputSchema,
): JsonObject {
  return {
    type: 'json_schema',
    name: structuredOutput.name,
    strict: structuredOutput.strict !== false,
    schema: structuredOutput.schema,
  };
}

function getGeminiThinkingConfig(
  model: string,
  reasoningEffort: LlmReasoningEffort | undefined,
): JsonObject | undefined {
  if (!reasoningEffort) {
    return undefined;
  }

  if (isGemini3Model(model)) {
    return {
      thinkingLevel: mapGemini3ThinkingLevel(reasoningEffort),
    };
  }

  return {
    thinkingBudget: mapGeminiThinkingBudget(model, reasoningEffort),
  };
}

function isGemini3Model(model: string): boolean {
  return model.trim().toLowerCase().startsWith('gemini-3');
}

function mapGemini3ThinkingLevel(reasoningEffort: LlmReasoningEffort): string {
  switch (reasoningEffort) {
    case 'none':
      return 'MINIMAL';
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
  }
}

function mapGeminiThinkingBudget(
  model: string,
  reasoningEffort: LlmReasoningEffort,
): number {
  const normalized = model.trim().toLowerCase();
  const isProModel = normalized.includes('pro');

  switch (reasoningEffort) {
    case 'none':
      return isProModel ? 128 : 0;
    case 'low':
      return isProModel ? 2_048 : 1_024;
    case 'medium':
      return isProModel ? 8_192 : 4_096;
    case 'high':
      return isProModel ? 24_576 : 16_384;
  }
}

function getAnthropicThinkingConfig(
  model: string,
  reasoningEffort: LlmReasoningEffort | undefined,
  maxTokens: number | undefined,
): { maxTokens: number; thinking?: JsonObject } {
  if (!reasoningEffort || reasoningEffort === 'none') {
    return {
      maxTokens: maxTokens ?? 1_024,
    };
  }

  if (supportsAnthropicAdaptiveThinking(model)) {
    return {
      maxTokens: maxTokens ?? 1_024,
      thinking: {
        type: 'adaptive',
        effort: reasoningEffort,
      },
    };
  }

  const budgetTokens = mapAnthropicThinkingBudget(reasoningEffort);
  const resolvedMaxTokens = Math.max(
    maxTokens ?? budgetTokens + 1_024,
    budgetTokens + 1,
  );

  return {
    maxTokens: resolvedMaxTokens,
    thinking: {
      type: 'enabled',
      budget_tokens: Math.min(budgetTokens, resolvedMaxTokens - 1),
    },
  };
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('4-6');
}

function mapAnthropicThinkingBudget(
  reasoningEffort: LlmReasoningEffort,
): number {
  switch (reasoningEffort) {
    case 'none':
      return 0;
    case 'low':
      return 1_024;
    case 'medium':
      return 4_096;
    case 'high':
      return 8_192;
  }
}

function safeJsonParse(
  value: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      value: JSON.parse(value) as unknown,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Tool arguments were not valid JSON.',
    };
  }
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
