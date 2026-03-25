import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { LlmService } from './llm.service';
import type { LlmChatRequestBody } from './llm.types';

@Controller('llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Get('providers')
  getProviders() {
    return {
      providers: this.llmService.getProviders(),
    };
  }

  @Get('providers/:provider')
  getProvider(@Param('provider') provider: string) {
    return this.llmService.getProvider(provider);
  }

  @Post('chat')
  chat(@Body() requestBody: LlmChatRequestBody) {
    return this.llmService.chat(requestBody);
  }
}
