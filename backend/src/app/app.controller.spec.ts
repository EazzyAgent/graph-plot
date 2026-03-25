import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('should return backend health metadata', () => {
      const response = appController.getHealth();

      expect(response.service).toBe('graph-plot-backend');
      expect(response.status).toBe('ok');
      expect(typeof response.timestamp).toBe('string');
    });
  });

  describe('echoMessage', () => {
    it('should trim and echo the message payload', () => {
      const response = appController.echoMessage({ message: '  graph plot  ' });

      expect(response.length).toBe(10);
      expect(response.received).toBe('graph plot');
      expect(typeof response.timestamp).toBe('string');
      expect(response.uppercase).toBe('GRAPH PLOT');
    });
  });
});
