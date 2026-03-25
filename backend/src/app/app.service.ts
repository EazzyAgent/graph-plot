import { Injectable } from '@nestjs/common';

export interface ApiHealthResponse {
  service: string;
  status: 'ok';
  timestamp: string;
}

export interface ApiEchoResponse {
  length: number;
  received: string;
  timestamp: string;
  uppercase: string;
}

@Injectable()
export class AppService {
  getHealth(): ApiHealthResponse {
    return {
      service: 'graph-plot-backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  echoMessage(message: string): ApiEchoResponse {
    const trimmedMessage = message.trim();

    return {
      length: trimmedMessage.length,
      received: trimmedMessage,
      timestamp: new Date().toISOString(),
      uppercase: trimmedMessage.toUpperCase(),
    };
  }
}
