import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LlmService } from './llm.service';

describe('LlmService', () => {
  let service: LlmService;
  let fetchMock: jest.MockedFunction<typeof fetch>;
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    service = new LlmService();
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('lists provider metadata with env availability', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const providers = service.getProviders();
    const openaiProvider = providers.find(
      (provider) => provider.provider === 'openai',
    );
    const geminiProvider = providers.find(
      (provider) => provider.provider === 'gemini',
    );
    const anthropicProvider = providers.find(
      (provider) => provider.provider === 'anthropic',
    );

    expect(openaiProvider).toEqual(
      expect.objectContaining({
        provider: 'openai',
        enabled: true,
        defaultModel: 'gpt-5.4',
      }),
    );
    expect(openaiProvider?.exampleModels).toEqual(
      expect.arrayContaining(['gpt-5.4', 'gpt-5-mini', 'gpt-5.4-nano']),
    );
    expect(geminiProvider).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        enabled: false,
      }),
    );
    expect(anthropicProvider).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        aliases: ['claude'],
      }),
    );
  });

  it('normalizes the gpt alias to openai', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_123',
          output_text: 'Hello from OpenAI',
          status: 'completed',
          usage: {
            input_tokens: 4,
            output_tokens: 6,
            total_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      service.chat({
        provider: 'gpt',
        model: 'gpt-5.4-nano',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
        maxTokens: 50,
      }),
    ).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5.4-nano',
      responseId: 'resp_123',
      text: 'Hello from OpenAI',
      finishReason: 'completed',
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const body =
      init && typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const headers =
      init && init.headers && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>)
        : {};

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(init?.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer openai-key');
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    expect(body).toEqual({
      model: 'gpt-5.4-nano',
      store: false,
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Hello' }],
      max_output_tokens: 50,
    });
  });

  it('calls Gemini with the selected model', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello from Gemini' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 8,
            candidatesTokenCount: 5,
            totalTokenCount: 13,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      service.chat({
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', content: 'Hello Gemini' }],
        temperature: 1,
      }),
    ).resolves.toEqual({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      responseId: undefined,
      text: 'Hello from Gemini',
      finishReason: 'STOP',
      usage: {
        inputTokens: 8,
        outputTokens: 5,
        totalTokens: 13,
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers =
      init && init.headers && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>)
        : {};

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
    );
    expect(init?.method).toBe('POST');
    expect(headers['x-goog-api-key']).toBe('gemini-key');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes the claude alias to anthropic', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_123',
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 7,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      service.chat({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello Claude' }],
      }),
    ).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      responseId: 'msg_123',
      text: 'Hello from Claude',
      finishReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 7,
        totalTokens: 17,
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers =
      init && init.headers && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>)
        : {};

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(init?.method).toBe('POST');
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects unsupported providers', async () => {
    await expect(
      service.chat({
        provider: 'unknown',
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects requests when the provider api key is missing', async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(
      service.chat({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
