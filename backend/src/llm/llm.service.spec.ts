import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LlmService } from './llm.service';
import { ToolRegistryService } from './tools/tool-registry.service';

describe('LlmService', () => {
  let service: LlmService;
  let fetchMock: jest.MockedFunction<typeof fetch>;
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  const toolRegistry = {
    getDefinitions: jest.fn(() => [
      {
        name: 'inspect_path',
        description: 'Inspect a path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 },
            lineCount: { type: 'integer', minimum: 1, maximum: 200 },
          },
          required: ['path', 'startLine', 'lineCount'],
          additionalProperties: false,
        },
      },
    ]),
    executeTool: jest.fn(),
  };

  beforeEach(() => {
    service = new LlmService(toolRegistry as unknown as ToolRegistryService);
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;
    process.env = { ...originalEnv };
    toolRegistry.getDefinitions.mockClear();
    toolRegistry.executeTool.mockReset();
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

  it('preserves plain OpenAI chat behavior when filesystem tools are disabled', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'resp_123',
        output_text: 'Hello from OpenAI',
        status: 'completed',
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          total_tokens: 10,
        },
      }),
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
        tools: {
          fileSystem: false,
        },
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

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(body).toEqual({
      model: 'gpt-5.4-nano',
      store: false,
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Hello' }],
      max_output_tokens: 50,
    });
    expect(toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it('passes reasoning effort to OpenAI reasoning-capable models', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'resp_reasoning',
        output_text: 'Reasoned answer',
        status: 'completed',
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          total_tokens: 10,
        },
      }),
    );

    await service.chat({
      provider: 'openai',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Solve this.' }],
      reasoningEffort: 'high',
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    expect(body['reasoning']).toEqual({ effort: 'high' });
  });

  it('omits temperature for OpenAI models that reject it', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'resp_openai_no_temp',
        output_text: 'Draft code',
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
        },
      }),
    );

    await service.chat({
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'Write code.' }],
      temperature: 0.2,
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    expect(body['temperature']).toBeUndefined();
  });

  it('still passes temperature for OpenAI models that support it', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'resp_openai_temp',
        output_text: 'Answer',
        status: 'completed',
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          total_tokens: 10,
        },
      }),
    );

    await service.chat({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.4,
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    expect(body['temperature']).toBe(0.4);
  });

  it('passes structured output format to OpenAI when requested', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'resp_structured',
        output_text: '{"pythonCode":"print(1)"}',
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 12,
          total_tokens: 22,
        },
      }),
    );

    await service.chat({
      provider: 'openai',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Return code.' }],
      structuredOutput: {
        name: 'draft_code_payload',
        schema: {
          type: 'object',
          properties: {
            pythonCode: {
              type: 'string',
            },
          },
          required: ['pythonCode'],
          additionalProperties: false,
        },
      },
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    expect(body['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'draft_code_payload',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            pythonCode: {
              type: 'string',
            },
          },
          required: ['pythonCode'],
          additionalProperties: false,
        },
      },
    });
  });

  it('calls Gemini with the selected model', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
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

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
    );
  });

  it('passes thinking configuration to Gemini when reasoning effort is set', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: 'Reasoned Gemini answer' }],
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
    );

    await service.chat({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'Think harder.' }],
      reasoningEffort: 'high',
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    expect(body['generationConfig']).toEqual(
      expect.objectContaining({
        thinkingConfig: {
          thinkingLevel: 'HIGH',
        },
      }),
    );
  });

  it('sends image inputs to OpenAI when a message includes images', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'resp_img',
        output_text: 'Image reviewed.',
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
      }),
    );

    await service.chat({
      provider: 'openai',
      model: 'gpt-5.4',
      messages: [
        {
          role: 'user',
          content: 'Critique this draft figure.',
          images: [
            {
              mimeType: 'image/png',
              base64Data: 'ZmFrZQ==',
            },
          ],
        },
      ],
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);

    expect(body['input']).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Critique this draft figure.',
          },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,ZmFrZQ==',
          },
        ],
      },
    ]);
  });

  it('sends image inputs to Gemini when a message includes images', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: 'Image reviewed.' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 3,
          totalTokenCount: 13,
        },
      }),
    );

    await service.chat({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      messages: [
        {
          role: 'user',
          content: 'Critique this draft figure.',
          images: [
            {
              mimeType: 'image/png',
              base64Data: 'ZmFrZQ==',
            },
          ],
        },
      ],
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);

    expect(body['contents']).toEqual([
      {
        role: 'user',
        parts: [
          {
            text: 'Critique this draft figure.',
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'ZmFrZQ==',
            },
          },
        ],
      },
    ]);
  });

  it('normalizes the claude alias to anthropic', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello from Claude' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 7,
        },
      }),
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
  });

  it('passes thinking configuration to Anthropic when reasoning effort is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'msg_reasoning',
        content: [{ type: 'text', text: 'Reasoned Claude answer' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 12,
          output_tokens: 5,
        },
      }),
    );

    await service.chat({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Review this carefully.' }],
      reasoningEffort: 'medium',
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    expect(body['thinking']).toEqual({
      type: 'adaptive',
      effort: 'medium',
    });
  });

  it('sends image inputs to Anthropic when a message includes images', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'msg_img',
        content: [{ type: 'text', text: 'Image reviewed.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 12,
          output_tokens: 4,
        },
      }),
    );

    await service.chat({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: 'Critique this draft figure.',
          images: [
            {
              mimeType: 'image/png',
              base64Data: 'ZmFrZQ==',
            },
          ],
        },
      ],
    });

    const body = getJsonBody(fetchMock.mock.calls[0]?.[1]);

    expect(body['messages']).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Critique this draft figure.',
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'ZmFrZQ==',
            },
          },
        ],
      },
    ]);
  });

  it('executes OpenAI filesystem tools across multiple rounds', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    toolRegistry.executeTool
      .mockResolvedValueOnce({
        toolName: 'inspect_path',
        isError: false,
        content: {
          ok: true,
          path: 'C:\\repo',
          entries: [
            { name: 'index.ts', path: 'C:\\repo\\index.ts', type: 'file' },
          ],
        },
      })
      .mockResolvedValueOnce({
        toolName: 'read_file',
        isError: false,
        content: {
          ok: true,
          path: 'C:\\repo\\index.ts',
          startLine: 1,
          endLine: 1,
          requestedLineCount: 20,
          returnedLineCount: 1,
          totalLines: 1,
          hasMore: false,
          content: 'console.log("hi")',
          truncated: false,
          sizeBytes: 17,
          returnedBytes: 17,
        },
      });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp_1',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'inspect_path',
              arguments: '{"path":"C:\\\\repo"}',
            },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp_2',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_2',
              name: 'read_file',
              arguments:
                '{"path":"C:\\\\repo\\\\index.ts","startLine":1,"lineCount":20}',
            },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp_3',
          status: 'completed',
          output_text: 'The file logs hi.',
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
          },
        }),
      );

    await expect(
      service.chat({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Inspect C:\\repo\\index.ts' }],
        tools: { fileSystem: true },
      }),
    ).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
      responseId: 'resp_3',
      text: 'The file logs hi.',
      finishReason: 'completed',
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
      },
      toolTrace: [
        {
          round: 1,
          callId: 'call_1',
          toolName: 'inspect_path',
          input: {
            path: 'C:\\repo',
          },
          result: {
            tool: 'inspect_path',
            ok: true,
            path: 'C:\\repo',
            entries: [
              {
                name: 'index.ts',
                path: 'C:\\repo\\index.ts',
                type: 'file',
              },
            ],
          },
          isError: false,
        },
        {
          round: 2,
          callId: 'call_2',
          toolName: 'read_file',
          input: {
            path: 'C:\\repo\\index.ts',
            startLine: 1,
            lineCount: 20,
          },
          result: {
            tool: 'read_file',
            ok: true,
            path: 'C:\\repo\\index.ts',
            startLine: 1,
            endLine: 1,
            requestedLineCount: 20,
            returnedLineCount: 1,
            totalLines: 1,
            hasMore: false,
            content: 'console.log("hi")',
            truncated: false,
            sizeBytes: 17,
            returnedBytes: 17,
          },
          isError: false,
        },
      ],
    });

    expect(toolRegistry.executeTool).toHaveBeenNthCalledWith(
      1,
      'inspect_path',
      {
        path: 'C:\\repo',
      },
    );
    expect(toolRegistry.executeTool).toHaveBeenNthCalledWith(2, 'read_file', {
      path: 'C:\\repo\\index.ts',
      startLine: 1,
      lineCount: 20,
    });

    const firstBody = getJsonBody(fetchMock.mock.calls[0]?.[1]);
    const secondBody = getJsonBody(fetchMock.mock.calls[1]?.[1]);
    const thirdBody = getJsonBody(fetchMock.mock.calls[2]?.[1]);

    expect(firstBody['tools']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'inspect_path' }),
      ]),
    );
    expect(firstBody['store']).toBe(true);
    expect(firstBody['instructions']).toEqual(
      expect.stringContaining("Infer lineCount from the user's request"),
    );
    expect(secondBody['previous_response_id']).toBe('resp_1');
    expect(secondBody['input']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_1',
        }),
      ]),
    );
    expect(secondBody['input']).toHaveLength(1);
    expect(thirdBody['previous_response_id']).toBe('resp_2');
    expect(thirdBody['input']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_2',
        }),
      ]),
    );
    expect(thirdBody['input']).toHaveLength(1);
  });

  it('executes Gemini filesystem tools and returns final text', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    toolRegistry.executeTool.mockResolvedValueOnce({
      toolName: 'inspect_path',
      isError: false,
      content: {
        ok: true,
        path: '/tmp',
        entries: [{ name: 'a.txt', path: '/tmp/a.txt', type: 'file' }],
      },
    });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'inspect_path',
                      args: { path: '/tmp' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: 'I found a.txt.' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
            totalTokenCount: 16,
          },
        }),
      );

    await expect(
      service.chat({
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', content: 'Inspect /tmp' }],
        tools: { fileSystem: true },
      }),
    ).resolves.toEqual({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      responseId: undefined,
      text: 'I found a.txt.',
      finishReason: 'STOP',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      },
      toolTrace: [
        {
          round: 1,
          toolName: 'inspect_path',
          input: {
            path: '/tmp',
          },
          result: {
            tool: 'inspect_path',
            ok: true,
            path: '/tmp',
            entries: [{ name: 'a.txt', path: '/tmp/a.txt', type: 'file' }],
          },
          isError: false,
        },
      ],
    });

    expect(toolRegistry.executeTool).toHaveBeenCalledWith('inspect_path', {
      path: '/tmp',
    });

    const secondBody = getJsonBody(fetchMock.mock.calls[1]?.[1]);
    expect(JSON.stringify(secondBody['contents'])).toContain(
      'functionResponse',
    );
    expect(JSON.stringify(secondBody['contents'])).toContain('inspect_path');
  });

  it('executes Anthropic filesystem tools and returns final text', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    toolRegistry.executeTool.mockResolvedValueOnce({
      toolName: 'inspect_path',
      isError: false,
      content: {
        ok: true,
        path: '/tmp',
        entries: [{ name: 'a.txt', path: '/tmp/a.txt', type: 'file' }],
      },
    });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'msg_1',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'inspect_path',
              input: { path: '/tmp' },
            },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'msg_2',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'I found a.txt.' }],
          usage: {
            input_tokens: 14,
            output_tokens: 4,
          },
        }),
      );

    await expect(
      service.chat({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Inspect /tmp' }],
        tools: { fileSystem: true },
      }),
    ).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      responseId: 'msg_2',
      text: 'I found a.txt.',
      finishReason: 'end_turn',
      usage: {
        inputTokens: 14,
        outputTokens: 4,
        totalTokens: 18,
      },
      toolTrace: [
        {
          round: 1,
          callId: 'toolu_1',
          toolName: 'inspect_path',
          input: {
            path: '/tmp',
          },
          result: {
            tool: 'inspect_path',
            ok: true,
            path: '/tmp',
            entries: [{ name: 'a.txt', path: '/tmp/a.txt', type: 'file' }],
          },
          isError: false,
        },
      ],
    });

    expect(toolRegistry.executeTool).toHaveBeenCalledWith('inspect_path', {
      path: '/tmp',
    });

    const secondBody = getJsonBody(fetchMock.mock.calls[1]?.[1]);
    expect(secondBody['messages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: [
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'toolu_1',
            }),
          ],
        }),
      ]),
    );
  });

  it('returns a tool error result when OpenAI sends malformed arguments', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp_bad_args',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_bad',
              name: 'inspect_path',
              arguments: '{bad json',
            },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'resp_fixed',
          status: 'completed',
          output_text: 'Recovered after the tool error.',
          usage: {
            input_tokens: 5,
            output_tokens: 5,
            total_tokens: 10,
          },
        }),
      );

    const response = await service.chat({
      provider: 'openai',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Inspect this path.' }],
      tools: { fileSystem: true },
    });

    expect(response).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      responseId: 'resp_fixed',
      text: 'Recovered after the tool error.',
      finishReason: 'completed',
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
      },
      toolTrace: [
        {
          round: 1,
          callId: 'call_bad',
          toolName: 'inspect_path',
          input: {
            rawArgumentsText: '{bad json',
          },
          result: {
            tool: 'inspect_path',
            ok: false,
            error: {
              code: 'invalid_arguments_json',
            },
          },
          isError: true,
        },
      ],
    });
    expect(
      (
        response.toolTrace?.[0]?.result as {
          error?: { message?: unknown };
        }
      ).error?.message,
    ).toEqual(expect.any(String));

    expect(toolRegistry.executeTool).not.toHaveBeenCalled();

    const secondBody = getJsonBody(fetchMock.mock.calls[1]?.[1]);
    expect(secondBody['input']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_bad',
        }),
      ]),
    );
    expect(JSON.stringify(secondBody)).toContain('invalid_arguments_json');
  });

  it('enforces the maximum OpenAI tool round limit', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    toolRegistry.executeTool.mockResolvedValue({
      toolName: 'inspect_path',
      isError: false,
      content: {
        ok: true,
        path: '/tmp',
        entries: [],
      },
    });

    for (let index = 0; index < 7; index += 1) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: `resp_${index}`,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: `call_${index}`,
              name: 'inspect_path',
              arguments: '{"path":"/tmp"}',
            },
          ],
          usage: {},
        }),
      );
    }

    await expect(
      service.chat({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Keep inspecting /tmp.' }],
        tools: { fileSystem: true },
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(toolRegistry.executeTool).toHaveBeenCalledTimes(6);
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

  it('rejects invalid tools.fileSystem values', async () => {
    await expect(
      service.chat({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: { fileSystem: 'yes' as never },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid reasoningEffort values', async () => {
    await expect(
      service.chat({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hello' }],
        reasoningEffort: 'extreme' as never,
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

function getJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init || typeof init.body !== 'string') {
    return {};
  }

  const parsed: unknown = JSON.parse(init.body);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

function jsonResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
