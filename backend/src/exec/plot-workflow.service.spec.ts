import { ExecService } from './exec.service';
import {
  parseCritiqueRevisionPayload,
  parseDraftCodePayload,
  parseExecutionRepairPayload,
  parseFinalFigureReviewPayload,
  PlotWorkflowService,
} from './plot-workflow.service';
import { LlmService } from '../llm/llm.service';
import type { LlmChatResponse } from '../llm/llm.types';
import type { ExecPlotResponse } from './exec.types';

describe('PlotWorkflowService', () => {
  let service: PlotWorkflowService;

  const execService = {
    runPlot: jest.fn(),
  };

  const llmService = {
    chat: jest.fn(),
    getProvider: jest.fn(() => ({
      provider: 'openai',
      displayName: 'OpenAI',
      aliases: ['gpt'],
      apiKeyEnv: 'OPENAI_API_KEY',
      enabled: true,
      defaultModel: 'gpt-5.4',
      exampleModels: ['gpt-5.4'],
      docsUrl: 'https://developers.openai.com/api/docs/models',
      allowCustomModel: true,
    })),
  };

  beforeEach(() => {
    service = new PlotWorkflowService(
      execService as unknown as ExecService,
      llmService as unknown as LlmService,
    );
    execService.runPlot.mockReset();
    llmService.chat.mockReset();
    llmService.getProvider.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('parses strict JSON payloads for draft, critique, and repair steps', () => {
    expect(parseDraftCodePayload('{"pythonCode":"print(1)"}')).toEqual({
      ok: true,
      value: {
        pythonCode: 'print(1)',
      },
    });
    expect(
      parseCritiqueRevisionPayload(
        '{"critique":"Needs contrast","reflection":"Increase font size","pythonCode":"print(2)"}',
      ),
    ).toEqual({
      ok: true,
      value: {
        critique: 'Needs contrast',
        reflection: 'Increase font size',
        pythonCode: 'print(2)',
      },
    });
    expect(
      parseExecutionRepairPayload(
        '{"diagnosis":"Syntax error","pythonCode":"print(3)"}',
      ),
    ).toEqual({
      ok: true,
      value: {
        diagnosis: 'Syntax error',
        pythonCode: 'print(3)',
      },
    });
    expect(
      parseFinalFigureReviewPayload(
        '{"passed":true,"criteria":{"appropriateSpacing":true,"appropriateFontSize":true,"detailsVisible":true,"textUnblocked":true},"critique":"Looks polished","reflection":"No changes needed","pythonCode":"print(4)"}',
      ),
    ).toEqual({
      ok: true,
      value: {
        passed: true,
        criteria: {
          appropriateSpacing: true,
          appropriateFontSize: true,
          detailsVisible: true,
          textUnblocked: true,
        },
        critique: 'Looks polished',
        reflection: 'No changes needed',
        pythonCode: 'print(4)',
      },
    });
    expect(
      parseDraftCodePayload('```json\n{"pythonCode":"print(1)"}\n```'),
    ).toEqual({
      ok: false,
      message:
        'Response must be a raw JSON object with no markdown or commentary.',
    });
    expect(parseDraftCodePayload('{"pythonCode":"print(1)"')).toEqual({
      ok: false,
      message: 'Response appears truncated before the JSON object completed.',
    });
  });

  it('retries a structured workflow step with more tokens when the JSON looks truncated', async () => {
    llmService.chat
      .mockResolvedValueOnce(
        createLlmResponse('{"pythonCode":"print(1)"', 'incomplete'),
      )
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"ok","reflection":"ok","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: true,
          critique: 'ok',
          reflection: 'ok',
          pythonCode: 'print(2)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot a line chart.',
      enableFileSystemTools: false,
    });
    const job = await service.waitForWorkflowCompletion(started.jobId);

    const chatCalls = llmService.chat.mock.calls as unknown[][];
    const initialDraftCall = getObjectCallArg(chatCalls, 0);
    const retriedDraftCall = getObjectCallArg(chatCalls, 1);

    expect(job.status).toBe('completed');
    expect(chatCalls).toHaveLength(4);
    expect(initialDraftCall?.maxTokens).toBe(5000);
    expect(retriedDraftCall?.maxTokens).toBe(9000);
    expect(
      job.steps.some(
        (step) => step.label === 'Draft code generation completion retry',
      ),
    ).toBe(true);
  });

  it('never re-executes code when the repair response stays malformed', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(createLlmResponse('not json'))
      .mockResolvedValueOnce(createLlmResponse('still not json'));
    execService.runPlot.mockResolvedValueOnce(
      createFailedPlotResponse('SyntaxError: bad code'),
    );

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot a sine wave.',
      enableFileSystemTools: true,
    });
    const job = await service.waitForWorkflowCompletion(started.jobId);

    expect(execService.runPlot).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('failed');
    expect(job.terminalError).toContain('did not return valid JSON');
  });

  it('sends the prompt, current code, and execution feedback into repair calls', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"diagnosis":"Fix the syntax error","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"Looks good","reflection":"Ship it","pythonCode":"print(3)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: true,
          pythonCode: 'print(3)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(
        createFailedPlotResponse('SyntaxError: invalid syntax'),
      )
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot monthly revenue.',
      contextPath: 'C:\\data\\revenue.csv',
      enableFileSystemTools: true,
    });

    await service.waitForWorkflowCompletion(started.jobId);

    const repairCallArgs = llmService.chat.mock.calls[1] as
      | [Record<string, unknown>]
      | undefined;
    const repairCall = repairCallArgs?.[0];
    const repairMessages = Array.isArray(repairCall?.messages)
      ? (repairCall.messages as Array<{ content?: string }>)
      : [];
    const repairUserContent = repairMessages[1]?.content ?? '';

    expect(repairUserContent).toContain(
      'Original figure request:\nPlot monthly revenue.',
    );
    expect(repairUserContent).toContain('Current Python code:\nprint(1)');
    expect(repairUserContent).toContain('SyntaxError: invalid syntax');
    expect(repairUserContent).toContain('C:\\data\\revenue.csv');
  });

  it('retries failed execution stages up to three repair attempts', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse('{"diagnosis":"repair 1","pythonCode":"print(2)"}'),
      )
      .mockResolvedValueOnce(
        createLlmResponse('{"diagnosis":"repair 2","pythonCode":"print(3)"}'),
      )
      .mockResolvedValueOnce(
        createLlmResponse('{"diagnosis":"repair 3","pythonCode":"print(4)"}'),
      );
    execService.runPlot
      .mockResolvedValueOnce(createFailedPlotResponse('draft fail 1'))
      .mockResolvedValueOnce(createFailedPlotResponse('draft fail 2'))
      .mockResolvedValueOnce(createFailedPlotResponse('draft fail 3'))
      .mockResolvedValueOnce(createFailedPlotResponse('draft fail 4'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot a histogram.',
      enableFileSystemTools: false,
    });
    const job = await service.waitForWorkflowCompletion(started.jobId);

    expect(execService.runPlot).toHaveBeenCalledTimes(4);
    expect(llmService.chat).toHaveBeenCalledTimes(4);
    expect(job.status).toBe('failed');
    expect(job.steps.filter((step) => step.kind === 'llm')).toHaveLength(4);
  });

  it('completes the full workflow across draft repair and final repair', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"diagnosis":"Fix the draft","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"Improve labels","reflection":"Tighten spacing","pythonCode":"print(3)"}',
        ),
      )
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"diagnosis":"Fix final export","pythonCode":"print(4)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: true,
          critique: 'Final figure passes review',
          reflection: 'No further polish needed',
          pythonCode: 'print(4)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(createFailedPlotResponse('draft syntax error'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(createFailedPlotResponse('final layout error'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot customer growth.',
      enableFileSystemTools: true,
    });
    const job = await service.waitForWorkflowCompletion(started.jobId);

    expect(job.status).toBe('completed');
    expect(job.draftCode).toBe('print(2)');
    expect(job.finalCode).toBe('print(4)');
    expect(job.critique).toContain('Improve labels');
    expect(job.critique).toContain('Final figure review 1 critique');
    expect(job.reflection).toContain('Tighten spacing');
    expect(job.reflection).toContain('Final figure review 1 reflection');
    expect(job.draftArtifacts).toHaveLength(1);
    expect(job.finalArtifacts).toHaveLength(1);
    expect(
      job.steps.some((step) => step.label === 'Draft execution repair 1'),
    ).toBe(true);
    expect(
      job.steps.some((step) => step.label === 'Final execution repair 1'),
    ).toBe(true);
    expect(
      job.steps.some((step) => step.label === 'Final figure review 1'),
    ).toBe(true);
  });

  it('retains terminal job state for later polling', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"Done","reflection":"Done","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: true,
          critique: 'All criteria satisfied',
          reflection: 'No further changes required',
          pythonCode: 'print(2)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot a line chart.',
      enableFileSystemTools: false,
    });

    await service.waitForWorkflowCompletion(started.jobId);
    const retainedJob = service.getWorkflow(started.jobId);

    expect(retainedJob.status).toBe('completed');
    expect(retainedJob.completedAt).toBeDefined();
    expect(retainedJob.steps.length).toBeGreaterThan(0);
  });

  it('uses the separate review model and passes layout diagnostics into final review', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"Improve spacing","reflection":"Adjust labels","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: true,
          critique: 'All layout checks passed.',
          reflection: 'No more changes needed.',
          pythonCode: 'print(2)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(
        createSuccessfulPlotResponse('final', {
          layoutDiagnostics: {
            totalFigureCount: 1,
            totalAxesCount: 1,
            totalTextElementCount: 6,
            totalVisibleTextElementCount: 6,
            totalClippedTextCount: 0,
            totalOverlappingTextPairCount: 0,
            totalVerySmallTextCount: 0,
            figures: [
              {
                filename: 'final-figure.png',
                widthPx: 1200,
                heightPx: 800,
                axesCount: 1,
                textElementCount: 6,
                visibleTextElementCount: 6,
                clippedTextCount: 0,
                overlappingTextPairCount: 0,
                verySmallTextCount: 0,
                minFontSize: 10,
                maxFontSize: 18,
                averageFontSize: 13,
              },
            ],
          },
        }),
      );

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4-nano',
      reviewModel: 'gpt-5.4',
      prompt: 'Plot monthly bookings.',
      reasoningEffort: 'high',
      enableFileSystemTools: false,
    });

    await service.waitForWorkflowCompletion(started.jobId);

    const chatCalls = llmService.chat.mock.calls as unknown[][];
    const draftCall = getObjectCallArg(chatCalls, 0);
    const critiqueCall = getObjectCallArg(chatCalls, 1);
    const reviewCall = getObjectCallArg(chatCalls, 2);

    expect(draftCall).toMatchObject({
      model: 'gpt-5.4-nano',
      reasoningEffort: 'high',
    });
    expect(getObjectProperty(draftCall, 'structuredOutput')).toMatchObject({
      name: 'draft_code_payload',
    });
    expect(critiqueCall).toMatchObject({
      model: 'gpt-5.4',
    });
    expect(critiqueCall?.reasoningEffort).toBeUndefined();
    expect(getObjectProperty(critiqueCall, 'structuredOutput')).toMatchObject({
      name: 'critique_revision_payload',
    });
    expect(reviewCall).toMatchObject({
      model: 'gpt-5.4',
    });
    expect(reviewCall?.reasoningEffort).toBeUndefined();
    expect(getObjectProperty(reviewCall, 'structuredOutput')).toMatchObject({
      name: 'final_figure_review_payload',
    });
    expect(JSON.stringify(reviewCall ?? {})).toContain(
      'Matplotlib layout diagnostics',
    );
  });

  it('rerenders the final figure when the visual review flags unmet criteria', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"Improve labels","reflection":"Tighten layout","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: false,
          criteria: {
            appropriateSpacing: false,
            appropriateFontSize: true,
            detailsVisible: true,
            textUnblocked: false,
          },
          critique:
            'Labels still overlap and the layout has awkward empty space.',
          reflection:
            'Increase padding, rotate labels, and rebalance the figure.',
          pythonCode: 'print(3)',
        }),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: true,
          critique: 'The figure now satisfies the visual criteria.',
          reflection: 'Spacing and label clarity are acceptable.',
          pythonCode: 'print(3)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot a product mix chart.',
      enableFileSystemTools: false,
    });
    const job = await service.waitForWorkflowCompletion(started.jobId);

    expect(job.status).toBe('completed');
    expect(job.finalCode).toBe('print(3)');
    expect(execService.runPlot).toHaveBeenCalledTimes(3);
    expect(
      job.steps.some(
        (step) => step.label === 'Final polish rerender 1 attempt 1',
      ),
    ).toBe(true);
    expect(job.critique).toContain('Final figure review 1 critique');
    expect(job.reflection).toContain('Final figure review 1 reflection');
  });

  it('fails after three final figure revision rounds if the criteria stay unmet', async () => {
    llmService.chat
      .mockResolvedValueOnce(createLlmResponse('{"pythonCode":"print(1)"}'))
      .mockResolvedValueOnce(
        createLlmResponse(
          '{"critique":"Initial critique","reflection":"Initial reflection","pythonCode":"print(2)"}',
        ),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: false,
          criteria: {
            appropriateSpacing: false,
            appropriateFontSize: true,
            detailsVisible: true,
            textUnblocked: true,
          },
          pythonCode: 'print(3)',
        }),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: false,
          criteria: {
            appropriateSpacing: false,
            appropriateFontSize: true,
            detailsVisible: true,
            textUnblocked: true,
          },
          pythonCode: 'print(4)',
        }),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: false,
          criteria: {
            appropriateSpacing: false,
            appropriateFontSize: true,
            detailsVisible: true,
            textUnblocked: true,
          },
          pythonCode: 'print(5)',
        }),
      )
      .mockResolvedValueOnce(
        createFinalFigureReviewResponse({
          passed: false,
          criteria: {
            appropriateSpacing: false,
            appropriateFontSize: true,
            detailsVisible: true,
            textUnblocked: true,
          },
          pythonCode: 'print(6)',
        }),
      );
    execService.runPlot
      .mockResolvedValueOnce(createSuccessfulPlotResponse('draft'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'))
      .mockResolvedValueOnce(createSuccessfulPlotResponse('final'));

    const started = service.startWorkflow({
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Plot quarterly EBITDA.',
      enableFileSystemTools: false,
    });
    const job = await service.waitForWorkflowCompletion(started.jobId);

    expect(job.status).toBe('failed');
    expect(execService.runPlot).toHaveBeenCalledTimes(5);
    expect(job.terminalError).toContain(
      'did not satisfy the required visual criteria',
    );
  });
});

function getObjectCallArg(
  calls: unknown[][],
  index: number,
): Record<string, unknown> | undefined {
  const firstArg = calls[index]?.[0];

  return firstArg && typeof firstArg === 'object'
    ? (firstArg as Record<string, unknown>)
    : undefined;
}

function getObjectProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const property = value?.[key];

  return property && typeof property === 'object'
    ? (property as Record<string, unknown>)
    : undefined;
}

function createLlmResponse(
  text: string,
  finishReason = 'completed',
): LlmChatResponse {
  return {
    provider: 'openai',
    model: 'gpt-5.4',
    responseId: 'resp_123',
    text,
    finishReason,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    },
  };
}

function createSuccessfulPlotResponse(
  renderProfile: 'draft' | 'final',
  overrides?: Partial<ExecPlotResponse>,
): ExecPlotResponse {
  return {
    requestedRuntime: 'python',
    resolvedRuntime: 'python',
    os: process.platform,
    renderProfile,
    command: 'python',
    commandArgs: ['plot_runner.py'],
    workingDirectory: process.cwd(),
    startedAt: '2026-03-26T00:00:00.000Z',
    completedAt: '2026-03-26T00:00:01.000Z',
    durationMs: 1000,
    status: 'completed',
    exitCode: 0,
    signal: null,
    stdout: 'ok',
    stderr: '',
    logs: [],
    errors: [],
    sandbox: {
      available: true,
      bootstrapped: true,
      command: 'python',
      packageDirectory: 'C:\\tmp\\python-plot-packages',
      requiredPackages: ['matplotlib', 'numpy', 'pandas', 'seaborn'],
    },
    artifacts: [
      {
        kind: 'image',
        filename: `${renderProfile}-figure.png`,
        mimeType: 'image/png',
        base64: 'ZmFrZQ==',
        byteSize: 4,
      },
    ],
    ...overrides,
  };
}

function createFailedPlotResponse(errorMessage: string): ExecPlotResponse {
  return {
    ...createSuccessfulPlotResponse('draft'),
    status: 'failed',
    exitCode: 1,
    stderr: errorMessage,
    errors: [errorMessage],
    artifacts: [],
  };
}

function createFinalFigureReviewResponse(
  overrides?: Partial<{
    passed: boolean;
    criteria: {
      appropriateSpacing: boolean;
      appropriateFontSize: boolean;
      detailsVisible: boolean;
      textUnblocked: boolean;
    };
    critique: string;
    reflection: string;
    pythonCode: string;
  }>,
): LlmChatResponse {
  return createLlmResponse(
    JSON.stringify({
      passed: overrides?.passed ?? true,
      criteria: {
        appropriateSpacing: true,
        appropriateFontSize: true,
        detailsVisible: true,
        textUnblocked: true,
        ...overrides?.criteria,
      },
      critique: overrides?.critique ?? 'Visual quality is acceptable.',
      reflection: overrides?.reflection ?? 'No additional polish is required.',
      pythonCode: overrides?.pythonCode ?? 'print(1)',
    }),
  );
}
