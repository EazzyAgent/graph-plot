import { Body, Controller, Get, Post } from '@nestjs/common';
import { ExecService } from './exec.service';
import type { ExecPlotRequestBody, ExecRunRequestBody } from './exec.types';

@Controller('exec')
export class ExecController {
  constructor(private readonly execService: ExecService) {}

  @Get('capabilities')
  getCapabilities() {
    return this.execService.getCapabilities();
  }

  @Get('plot/capabilities')
  getPlotCapabilities() {
    return this.execService.getPlotCapabilities();
  }

  @Post('run')
  run(@Body() requestBody: ExecRunRequestBody) {
    return this.execService.run(requestBody);
  }

  @Post('plot')
  runPlot(@Body() requestBody: ExecPlotRequestBody) {
    return this.execService.runPlot(requestBody);
  }
}
