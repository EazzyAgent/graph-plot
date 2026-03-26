import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApp } from './../src/app/app.config';
import { AppModule } from './../src/app/app.module';
import type {
  ExecCapabilitiesResponse,
  ExecPlotCapabilitiesResponse,
  ExecRunResponse,
} from './../src/exec/exec.types';
import type { LlmProviderInfo } from './../src/llm/llm.types';
import type {
  ApiEchoResponse,
  ApiHealthResponse,
} from './../src/app/app.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/api/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((response) => {
        const body = response.body as ApiHealthResponse;

        expect(body.service).toBe('graph-plot-backend');
        expect(body.status).toBe('ok');
        expect(typeof body.timestamp).toBe('string');
      });
  });

  it('/api/test/echo (POST)', () => {
    return request(app.getHttpServer())
      .post('/api/test/echo')
      .send({ message: '  hello frontend  ' })
      .expect(201)
      .expect((response) => {
        const body = response.body as ApiEchoResponse;

        expect(body.length).toBe(14);
        expect(body.received).toBe('hello frontend');
        expect(typeof body.timestamp).toBe('string');
        expect(body.uppercase).toBe('HELLO FRONTEND');
      });
  });

  it('/api/llm/providers (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/llm/providers')
      .expect(200)
      .expect((response) => {
        const body = response.body as { providers: LlmProviderInfo[] };

        expect(Array.isArray(body.providers)).toBe(true);
        expect(body.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ provider: 'openai' }),
            expect.objectContaining({ provider: 'gemini' }),
            expect.objectContaining({ provider: 'anthropic' }),
          ]),
        );
      });
  });

  it('/api/llm/chat rejects invalid tools flag (POST)', () => {
    return request(app.getHttpServer())
      .post('/api/llm/chat')
      .send({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: { fileSystem: 'yes' },
      })
      .expect(400);
  });

  it('/api/exec/capabilities (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/exec/capabilities')
      .expect(200)
      .expect((response) => {
        const body = response.body as ExecCapabilitiesResponse;

        expect(body.os).toBe(process.platform);
        expect(Array.isArray(body.runtimes)).toBe(true);
        expect(body.runtimes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ runtime: 'python' }),
            expect.objectContaining({ runtime: 'bash' }),
            expect.objectContaining({ runtime: 'powershell' }),
            expect.objectContaining({ runtime: 'shell' }),
          ]),
        );
      });
  });

  it('/api/exec/run (POST)', () => {
    const code =
      process.platform === 'win32'
        ? 'Write-Output "exec ok"'
        : 'echo "exec ok"';

    return request(app.getHttpServer())
      .post('/api/exec/run')
      .send({
        runtime: 'shell',
        code,
      })
      .expect(201)
      .expect((response) => {
        const body = response.body as ExecRunResponse;

        expect(body.status).toBe('completed');
        expect(body.stdout).toContain('exec ok');
        expect(body.requestedRuntime).toBe('shell');
        expect(Array.isArray(body.logs)).toBe(true);
      });
  });

  it('/api/exec/plot/capabilities (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/exec/plot/capabilities')
      .expect(200)
      .expect((response) => {
        const body = response.body as ExecPlotCapabilitiesResponse;

        expect(body.os).toBe(process.platform);
        expect(typeof body.sandbox.available).toBe('boolean');
        expect(typeof body.sandbox.bootstrapped).toBe('boolean');
        expect(Array.isArray(body.sandbox.requiredPackages)).toBe(true);
      });
  });
});
