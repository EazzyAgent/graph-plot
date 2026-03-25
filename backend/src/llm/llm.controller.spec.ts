import { Test, TestingModule } from '@nestjs/testing';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import type { LlmChatResponse, LlmProviderInfo } from './llm.types';

describe('LlmController', () => {
  let controller: LlmController;

  const providerResponse: LlmProviderInfo = {
    provider: 'openai',
    displayName: 'OpenAI',
    aliases: ['gpt'],
    apiKeyEnv: 'OPENAI_API_KEY',
    enabled: false,
    defaultModel: 'gpt-5.4',
    exampleModels: ['gpt-5.4'],
    docsUrl: 'https://developers.openai.com/api/docs/models',
    allowCustomModel: true,
  };

  const chatResponse: LlmChatResponse = {
    provider: 'openai',
    model: 'gpt-5.4',
    responseId: 'resp_123',
    text: 'hello',
    finishReason: 'completed',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };

  const llmService = {
    getProviders: jest.fn(() => [providerResponse]),
    getProvider: jest.fn(() => providerResponse),
    chat: jest.fn(() => Promise.resolve(chatResponse)),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [LlmController],
      providers: [
        {
          provide: LlmService,
          useValue: llmService,
        },
      ],
    }).compile();

    controller = app.get<LlmController>(LlmController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns provider metadata', () => {
    expect(controller.getProviders()).toEqual({
      providers: [providerResponse],
    });
  });

  it('returns a single provider', () => {
    expect(controller.getProvider('openai')).toEqual(providerResponse);
    expect(llmService.getProvider).toHaveBeenCalledWith('openai');
  });

  it('delegates chat requests to the service', async () => {
    await expect(
      controller.chat({
        provider: 'gpt',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).resolves.toEqual(chatResponse);
  });
});
