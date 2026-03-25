import type { INestApplication } from '@nestjs/common';

const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:3000';
const DEFAULT_PORT = 3001;

export function configureApp(app: INestApplication): void {
  const configuredOrigins =
    process.env.FRONTEND_ORIGIN?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];

  app.enableCors({
    origin:
      configuredOrigins.length > 0
        ? configuredOrigins
        : [DEFAULT_FRONTEND_ORIGIN],
  });
  app.setGlobalPrefix('api');
}

export function getPort(): number {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}
