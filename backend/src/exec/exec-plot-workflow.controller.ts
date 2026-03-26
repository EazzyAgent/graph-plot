import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PlotWorkflowService } from './plot-workflow.service';
import type { StartExecPlotWorkflowRequestBody } from './exec.types';

@Controller('exec/plot/workflows')
export class ExecPlotWorkflowController {
  constructor(private readonly plotWorkflowService: PlotWorkflowService) {}

  @Post()
  @HttpCode(202)
  start(@Body() requestBody: StartExecPlotWorkflowRequestBody) {
    return this.plotWorkflowService.startWorkflow(requestBody);
  }

  @Get(':jobId')
  get(@Param('jobId') jobId: string) {
    return this.plotWorkflowService.getWorkflow(jobId);
  }
}
