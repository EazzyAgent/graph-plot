import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [LlmModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
