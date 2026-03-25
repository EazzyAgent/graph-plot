import { Body, Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';

interface EchoRequestBody {
  message?: string;
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  @Post('test/echo')
  echoMessage(@Body() body: EchoRequestBody = {}) {
    return this.appService.echoMessage(body.message ?? '');
  }
}
