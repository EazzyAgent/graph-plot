import { Test, TestingModule } from '@nestjs/testing';
import { ExecPlotWorkflowController } from './exec-plot-workflow.controller';
import { PlotWorkflowService } from './plot-workflow.service';
import type {
  ExecPlotWorkflowJob,
  StartExecPlotWorkflowResponse,
} from './exec.types';

describe('ExecPlotWorkflowController', () => {
  let controller: ExecPlotWorkflowController;

  const startWorkflowResponse: StartExecPlotWorkflowResponse = {
    jobId: 'job-123',
    status: 'running',
  };

  const workflowJob: ExecPlotWorkflowJob = {
    jobId: 'job-123',
    status: 'running',
    currentStage: 'Draft code generation',
    createdAt: '2026-03-26T00:00:00.000Z',
    updatedAt: '2026-03-26T00:00:00.000Z',
    request: {
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot a sine wave.',
      enableFileSystemTools: true,
    },
    draftCode: '',
    finalCode: '',
    critique: '',
    reflection: '',
    draftArtifacts: [],
    finalArtifacts: [],
    steps: [],
  };

  const plotWorkflowService = {
    startWorkflow: jest.fn(() => Promise.resolve(startWorkflowResponse)),
    getWorkflow: jest.fn(() => workflowJob),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecPlotWorkflowController],
      providers: [
        {
          provide: PlotWorkflowService,
          useValue: plotWorkflowService,
        },
      ],
    }).compile();

    controller = module.get<ExecPlotWorkflowController>(
      ExecPlotWorkflowController,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('starts plot workflows through the workflow service', async () => {
    await expect(
      controller.start({
        provider: 'openai',
        model: 'gpt-5.4',
        prompt: 'Plot a sine wave.',
        enableFileSystemTools: true,
      }),
    ).resolves.toEqual(startWorkflowResponse);
  });

  it('returns plot workflow jobs', () => {
    expect(controller.get('job-123')).toEqual(workflowJob);
  });
});
