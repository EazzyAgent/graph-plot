import { Module } from '@nestjs/common';
import { ExecModule } from '../exec/exec.module';
import { LlmModule } from '../llm/llm.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [LlmModule, ExecModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
