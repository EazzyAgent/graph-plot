import { Module } from '@nestjs/common';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { InspectPathTool } from './tools/inspect-path.tool';
import { ReadFileTool } from './tools/read-file.tool';
import { ToolRegistryService } from './tools/tool-registry.service';

@Module({
  controllers: [LlmController],
  providers: [LlmService, InspectPathTool, ReadFileTool, ToolRegistryService],
  exports: [LlmService],
})
export class LlmModule {}
