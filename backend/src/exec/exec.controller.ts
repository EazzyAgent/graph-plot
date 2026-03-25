import { Body, Controller, Get, Post } from '@nestjs/common';
import { ExecService } from './exec.service';
import type { ExecRunRequestBody } from './exec.types';

@Controller('exec')
export class ExecController {
  constructor(private readonly execService: ExecService) {}

  @Get('capabilities')
  getCapabilities() {
    return this.execService.getCapabilities();
  }

  @Post('run')
  run(@Body() requestBody: ExecRunRequestBody) {
    return this.execService.run(requestBody);
  }
}
