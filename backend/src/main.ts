import { NestFactory } from '@nestjs/core';
import { configureApp, getPort } from './app/app.config';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(getPort());
}
void bootstrap();
