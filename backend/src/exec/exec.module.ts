import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ExecPlotWorkflowController } from './exec-plot-workflow.controller';
import { ExecController } from './exec.controller';
import { ExecService } from './exec.service';
import { PlotWorkflowService } from './plot-workflow.service';

@Module({
  imports: [LlmModule],
  controllers: [ExecController, ExecPlotWorkflowController],
  providers: [ExecService, PlotWorkflowService],
  exports: [ExecService, PlotWorkflowService],
})
export class ExecModule {}
