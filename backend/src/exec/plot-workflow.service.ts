import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LlmService } from '../llm/llm.service';
import type {
  LlmChatMessage,
  LlmChatResponse,
  LlmReasoningEffort,
  LlmStructuredOutputSchema,
} from '../llm/llm.types';
import { LLM_REASONING_EFFORTS } from '../llm/llm.types';
import { ExecService } from './exec.service';
import type {
  ExecArtifact,
  ExecLogEntry,
  ExecPlotResponse,
  ExecPlotWorkflowExecStep,
  ExecPlotWorkflowJob,
  ExecPlotWorkflowLlmStep,
  ExecPlotWorkflowRequest,
  StartExecPlotWorkflowRequestBody,
  StartExecPlotWorkflowResponse,
} from './exec.types';

type JsonObject = Record<string, unknown>;

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

interface DraftCodePayload {
  pythonCode: string;
}

interface CritiqueRevisionPayload {
  critique: string;
  reflection: string;
  pythonCode: string;
}

interface ExecutionRepairPayload {
  diagnosis: string;
  pythonCode: string;
}

interface FinalFigureReviewCriteria {
  appropriateSpacing: boolean;
  appropriateFontSize: boolean;
  detailsVisible: boolean;
  textUnblocked: boolean;
}

interface FinalFigureReviewPayload {
  passed: boolean;
  criteria: FinalFigureReviewCriteria;
  critique: string;
  reflection: string;
  pythonCode: string;
}

interface StructuredLlmStepOptions<T> {
  jobId: string;
  provider: string;
  model: string;
  label: string;
  attempt: number;
  messages: LlmChatMessage[];
  maxTokens: number;
  reasoningEffort?: LlmReasoningEffort;
  enableFileSystemTools: boolean;
  formatRetryLabel: string;
  requiredSchemaDescription: string;
  parser: (text: string) => ParseResult<T>;
  structuredOutput?: LlmStructuredOutputSchema;
}

interface PlotExecutionOptions {
  jobId: string;
  provider: string;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  prompt: string;
  contextPath?: string;
  enableFileSystemTools: boolean;
  codeField: 'draftCode' | 'finalCode';
  artifactField: 'draftArtifacts' | 'finalArtifacts';
  initialCode: string;
  renderProfile: 'draft' | 'final';
  renderLabel: string;
  repairLabel: string;
}

const MAX_EXECUTION_REPAIR_ATTEMPTS = 3;
const FORMAT_RETRY_ATTEMPTS = 1;
const TRUNCATION_RETRY_ATTEMPTS = 1;
const DEFAULT_LLM_TEMPERATURE = 0.2;
const DRAFT_CODEGEN_MAX_TOKENS = 5_000;
const CRITIQUE_REVISION_MAX_TOKENS = 4_200;
const EXECUTION_REPAIR_MAX_TOKENS = 4_200;
const FINAL_FIGURE_REVIEW_MAX_TOKENS = 4_200;
const FORMAT_REPAIR_MAX_TOKENS = 2_200;
const TRUNCATION_RETRY_MAX_TOKENS = 9_000;
const MAX_EXECUTION_FEEDBACK_LOG_ENTRIES = 40;
const MAX_EXECUTION_FEEDBACK_TEXT_LENGTH = 9_000;
const MAX_FORMAT_REPAIR_SOURCE_TEXT_LENGTH = 17_000;
const MAX_FINAL_FIGURE_REVIEW_REVISIONS = 3;

@Injectable()
export class PlotWorkflowService {
  private readonly jobs = new Map<string, ExecPlotWorkflowJob>();
  private readonly jobPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly execService: ExecService,
    private readonly llmService: LlmService,
  ) {}

  startWorkflow(
    requestBody: StartExecPlotWorkflowRequestBody,
  ): StartExecPlotWorkflowResponse {
    const request = this.normalizeStartRequest(requestBody);
    const providerInfo = this.llmService.getProvider(request.provider);

    if (!providerInfo.enabled) {
      throw new ServiceUnavailableException(
        `Missing ${providerInfo.apiKeyEnv}. Set the API key before starting a plot workflow with ${providerInfo.displayName}.`,
      );
    }

    const now = new Date().toISOString();
    const jobId = randomUUID();
    const normalizedRequest: ExecPlotWorkflowRequest = {
      ...request,
      provider: providerInfo.provider,
    };
    const job: ExecPlotWorkflowJob = {
      jobId,
      status: 'running',
      currentStage: 'Starting workflow',
      createdAt: now,
      updatedAt: now,
      request: normalizedRequest,
      draftCode: '',
      finalCode: '',
      critique: '',
      reflection: '',
      draftArtifacts: [],
      finalArtifacts: [],
      steps: [],
    };

    this.jobs.set(jobId, job);

    const workflowPromise = this.runWorkflow(jobId, normalizedRequest)
      .then(() => {
        this.completeJob(jobId);
      })
      .catch((error) => {
        this.failJob(jobId, error);
      })
      .finally(() => {
        this.jobPromises.delete(jobId);
      });

    this.jobPromises.set(jobId, workflowPromise);

    return {
      jobId,
      status: 'running',
    };
  }

  getWorkflow(jobId: string): ExecPlotWorkflowJob {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new NotFoundException(
        `Plot workflow job "${jobId}" was not found.`,
      );
    }

    return cloneJob(job);
  }

  async waitForWorkflowCompletion(jobId: string): Promise<ExecPlotWorkflowJob> {
    const workflowPromise = this.jobPromises.get(jobId);

    if (workflowPromise) {
      await workflowPromise;
    }

    return this.getWorkflow(jobId);
  }

  private async runWorkflow(
    jobId: string,
    request: ExecPlotWorkflowRequest,
  ): Promise<void> {
    const draftCode = await this.runDraftCodegen(jobId, request);
    this.updateJob(jobId, (job) => {
      job.draftCode = draftCode;
    });

    const draftExecution = await this.executePlotWithRepair({
      jobId,
      provider: request.provider,
      model: getReviewModel(request),
      reasoningEffort: request.reasoningEffort,
      prompt: request.prompt,
      contextPath: request.contextPath,
      enableFileSystemTools: request.enableFileSystemTools,
      codeField: 'draftCode',
      artifactField: 'draftArtifacts',
      initialCode: draftCode,
      renderProfile: 'draft',
      renderLabel: 'Draft render',
      repairLabel: 'Draft execution repair',
    });

    const critiqueRevision = await this.runCritiqueRevision(
      jobId,
      request,
      this.getJob(jobId).draftCode,
      draftExecution.artifacts,
    );

    this.updateJob(jobId, (job) => {
      job.critique = critiqueRevision.critique;
      job.reflection = critiqueRevision.reflection;
      job.finalCode = critiqueRevision.pythonCode;
    });

    const initialFinalExecution = await this.executePlotWithRepair({
      jobId,
      provider: request.provider,
      model: getReviewModel(request),
      reasoningEffort: request.reasoningEffort,
      prompt: request.prompt,
      contextPath: request.contextPath,
      enableFileSystemTools: request.enableFileSystemTools,
      codeField: 'finalCode',
      artifactField: 'finalArtifacts',
      initialCode: critiqueRevision.pythonCode,
      renderProfile: 'final',
      renderLabel: 'Final render',
      repairLabel: 'Final execution repair',
    });

    await this.runFinalFigureReviewLoop(
      jobId,
      request,
      this.getJob(jobId).finalCode,
      initialFinalExecution,
    );
  }

  private async runDraftCodegen(
    jobId: string,
    request: ExecPlotWorkflowRequest,
  ): Promise<string> {
    const response = await this.runStructuredLlmStep<DraftCodePayload>({
      jobId,
      provider: request.provider,
      model: request.model,
      label: 'Draft code generation',
      attempt: 1,
      messages: [
        {
          role: 'system',
          content:
            'You are a Google senior developer and data visualization engineer. Write executable Python plotting code for a figure that is polished to the standard of publication in Nature. Do not put in text or title that is not necessary. Keep information compact and concise. Return only a JSON object shaped exactly like {"pythonCode": string}. The pythonCode value must contain complete executable Python code and no markdown fences. Use matplotlib through plt, seaborn through sns, numpy through np, and pandas through pd. Create one or more polished figures, do not call plt.show(), and do not save files manually. If the request depends on local data or files, use the filesystem tools before writing code. First inspect_path to discover files, then use read_file iteratively in small windows before generating code.',
        },
        {
          role: 'user',
          content: request.contextPath
            ? [
                'Figure request:',
                request.prompt,
                `Local path to inspect before generating code:\n${request.contextPath}`,
                'If that path contains relevant files, inspect the path and inspect the important files before writing the plotting code.',
              ].join('\n\n')
            : request.prompt,
        },
      ],
      maxTokens: DRAFT_CODEGEN_MAX_TOKENS,
      reasoningEffort: request.reasoningEffort,
      enableFileSystemTools: request.enableFileSystemTools,
      formatRetryLabel: 'Draft code generation JSON repair',
      requiredSchemaDescription: '{"pythonCode": string}',
      parser: parseDraftCodePayload,
      structuredOutput: createDraftCodeStructuredOutput(),
    });

    return response.parsed.pythonCode;
  }

  private async runCritiqueRevision(
    jobId: string,
    request: ExecPlotWorkflowRequest,
    draftCode: string,
    draftArtifacts: ExecArtifact[],
  ): Promise<CritiqueRevisionPayload> {
    const response = await this.runStructuredLlmStep<CritiqueRevisionPayload>({
      jobId,
      provider: request.provider,
      model: getReviewModel(request),
      label: 'Critique and revision',
      attempt: 1,
      messages: [
        {
          role: 'system',
          content:
            'Your are a top level developer in Apple. You are reviewing a low-resolution draft chart. Critique the draft figure, reflect on how to improve it to make it suitable for publication in Nature, following the best design principles, and then rewrite the Python plotting code. Return only a JSON object shaped exactly like {"critique": string, "reflection": string, "pythonCode": string}. The pythonCode value must contain complete executable Python code and no markdown fences. Keep `critique` concise, with at most 6 short bullet-style lines. Keep `reflection` concise, with at most 4 short bullet-style lines. Spend tokens on the revised code, not long prose. Use plt, sns, np, and pd. If local files are still relevant, you may use the filesystem tools again before revising the code.',
        },
        {
          role: 'user',
          content: [
            'Original figure request:',
            request.prompt,
            request.contextPath
              ? `Local data path:\n${request.contextPath}`
              : undefined,
            'Current draft code:',
            draftCode,
            'Review the attached draft figure(s), critique what is visually weak or missing, reflect on the changes to make, then provide improved plotting code for the final render.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          images: toWorkflowImages(draftArtifacts),
        },
      ],
      maxTokens: CRITIQUE_REVISION_MAX_TOKENS,
      enableFileSystemTools: request.enableFileSystemTools,
      formatRetryLabel: 'Critique and revision JSON repair',
      requiredSchemaDescription:
        '{"critique": string, "reflection": string, "pythonCode": string}',
      parser: parseCritiqueRevisionPayload,
      structuredOutput: createCritiqueRevisionStructuredOutput(),
    });

    return response.parsed;
  }

  private async executePlotWithRepair(
    options: PlotExecutionOptions,
  ): Promise<ExecPlotResponse> {
    let currentCode = options.initialCode;

    this.updateJob(options.jobId, (job) => {
      job[options.codeField] = currentCode;
    });

    for (
      let executionAttempt = 1;
      executionAttempt <= MAX_EXECUTION_REPAIR_ATTEMPTS + 1;
      executionAttempt += 1
    ) {
      const execution = await this.executePlotStep(
        options.jobId,
        `${options.renderLabel} attempt ${executionAttempt}`,
        executionAttempt,
        currentCode,
        options.renderProfile,
      );

      if (isSuccessfulPlotExecution(execution)) {
        this.updateJob(options.jobId, (job) => {
          job[options.codeField] = currentCode;
          job[options.artifactField] = execution.artifacts;
        });

        return execution;
      }

      if (executionAttempt > MAX_EXECUTION_REPAIR_ATTEMPTS) {
        throw new BadGatewayException(
          buildExecFailureMessage(execution) ||
            `${options.renderLabel} did not produce a figure.`,
        );
      }

      const repairAttempt = executionAttempt;
      const repair = await this.runStructuredLlmStep<ExecutionRepairPayload>({
        jobId: options.jobId,
        provider: options.provider,
        model: options.model,
        label: `${options.repairLabel} ${repairAttempt}`,
        attempt: repairAttempt,
        messages: [
          {
            role: 'system',
            content:
              'You are debugging Python plotting code after an external sandbox execution failure. Diagnose the failure from the user request, the current code, and the execution feedback, then rewrite the Python code so it runs successfully and still satisfies the plotting request. Return only a JSON object shaped exactly like {"diagnosis": string, "pythonCode": string}. The pythonCode value must contain complete corrected executable Python code and no markdown fences. Keep `diagnosis` concise, under 6 short lines, and spend tokens on the corrected code. Use plt, sns, np, and pd. Do not call plt.show(), and do not save files manually. If local files are still relevant, you may use the filesystem tools before revising the code.',
          },
          {
            role: 'user',
            content: [
              `Execution stage:\n${options.renderLabel}`,
              `Original figure request:\n${options.prompt}`,
              options.contextPath
                ? `Local data path:\n${options.contextPath}`
                : undefined,
              `Current Python code:\n${currentCode}`,
              `External execution feedback:\n${formatExecutionFeedback(execution)}`,
              'Revise the code so it resolves the runtime issue and successfully produces the requested figure in this sandbox.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        maxTokens: EXECUTION_REPAIR_MAX_TOKENS,
        reasoningEffort: options.reasoningEffort,
        enableFileSystemTools: options.enableFileSystemTools,
        formatRetryLabel: `${options.repairLabel} ${repairAttempt} JSON repair`,
        requiredSchemaDescription:
          '{"diagnosis": string, "pythonCode": string}',
        parser: parseExecutionRepairPayload,
        structuredOutput: createExecutionRepairStructuredOutput(),
      });

      currentCode = repair.parsed.pythonCode;
      this.updateJob(options.jobId, (job) => {
        job[options.codeField] = currentCode;
      });
    }

    throw new BadGatewayException(
      'Plot execution repair loop terminated unexpectedly.',
    );
  }

  private async runFinalFigureReviewLoop(
    jobId: string,
    request: ExecPlotWorkflowRequest,
    initialCode: string,
    initialExecution: ExecPlotResponse,
  ): Promise<void> {
    let currentCode = initialCode;
    let currentExecution = initialExecution;

    for (
      let revisionDepth = 0;
      revisionDepth <= MAX_FINAL_FIGURE_REVIEW_REVISIONS;
      revisionDepth += 1
    ) {
      const reviewAttempt = revisionDepth + 1;
      const review = await this.runFinalFigureReview(
        jobId,
        request,
        currentCode,
        currentExecution.artifacts,
        currentExecution.layoutDiagnostics,
        reviewAttempt,
      );
      const passed = didFinalFigureReviewPass(review);

      this.updateJob(jobId, (job) => {
        job.critique = appendWorkflowNotes(
          job.critique,
          `Final figure review ${reviewAttempt} critique`,
          review.critique,
        );
        job.reflection = appendWorkflowNotes(
          job.reflection,
          `Final figure review ${reviewAttempt} reflection`,
          review.reflection,
        );
      });

      if (passed) {
        return;
      }

      if (revisionDepth >= MAX_FINAL_FIGURE_REVIEW_REVISIONS) {
        throw new BadGatewayException(
          buildFinalFigureReviewFailureMessage(review),
        );
      }

      currentCode = review.pythonCode;
      this.updateJob(jobId, (job) => {
        job.finalCode = currentCode;
      });

      currentExecution = await this.executePlotWithRepair({
        jobId,
        provider: request.provider,
        model: getReviewModel(request),
        reasoningEffort: request.reasoningEffort,
        prompt: request.prompt,
        contextPath: request.contextPath,
        enableFileSystemTools: request.enableFileSystemTools,
        codeField: 'finalCode',
        artifactField: 'finalArtifacts',
        initialCode: currentCode,
        renderProfile: 'final',
        renderLabel: `Final polish rerender ${reviewAttempt}`,
        repairLabel: `Final polish rerender ${reviewAttempt} execution repair`,
      });
    }

    throw new BadGatewayException(
      'Final figure review loop terminated unexpectedly.',
    );
  }

  private async runFinalFigureReview(
    jobId: string,
    request: ExecPlotWorkflowRequest,
    currentCode: string,
    finalArtifacts: ExecArtifact[],
    layoutDiagnostics: ExecPlotResponse['layoutDiagnostics'],
    attempt: number,
  ): Promise<FinalFigureReviewPayload> {
    const response = await this.runStructuredLlmStep<FinalFigureReviewPayload>({
      jobId,
      provider: request.provider,
      model: getReviewModel(request),
      label: `Final figure review ${attempt}`,
      attempt,
      messages: [
        {
          role: 'system',
          content:
            'You are a top level designer in Apple. You are reviewing a chart for visual quality. Check whether all of these criteria are met: compact layout, appropriate spacing between text, appropriate font size, details visible, and text not blocked/clipped/overlapping. Return only a JSON object shaped exactly like {"passed": boolean, "criteria": {"compactLayout": boolean, "appropriateSpacing": boolean, "appropriateFontSize": boolean, "detailsVisible": boolean, "textUnblocked": boolean}, "critique": string, "reflection": string, "pythonCode": string}. Set passed to true only if every criterion is true. If any criterion is false, passed must be false and pythonCode must contain a complete revised executable Python replacement that improves the figure. If every criterion is true, return the current code unchanged in pythonCode. Keep `critique` concise, with at most 6 short bullet-style lines. Keep `reflection` concise, with at most 4 short bullet-style lines. Spend tokens on the Python code when changes are needed to make it suitable for publication in Nature, make sure to follow the best design principles. Use plt, sns, np, and pd. Do not use markdown fences. Do not call plt.show(), and do not save files manually. If local files are still relevant, you may use the filesystem tools before revising the code.',
        },
        {
          role: 'user',
          content: [
            'Original figure request:',
            request.prompt,
            request.contextPath
              ? `Local data path:\n${request.contextPath}`
              : undefined,
            layoutDiagnostics
              ? `Matplotlib layout diagnostics:\n${formatLayoutDiagnostics(
                  layoutDiagnostics,
                )}`
              : 'Matplotlib layout diagnostics were unavailable for this render.',
            'Current final Python code:',
            currentCode,
            'Review the attached final figure(s) against the required visual criteria. If anything is still off, critique it, reflect on the necessary fixes, and return improved code.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          images: toWorkflowImages(finalArtifacts),
        },
      ],
      maxTokens: FINAL_FIGURE_REVIEW_MAX_TOKENS,
      enableFileSystemTools: request.enableFileSystemTools,
      formatRetryLabel: `Final figure review ${attempt} JSON repair`,
      requiredSchemaDescription:
        '{"passed": boolean, "criteria": {"appropriateSpacing": boolean, "appropriateFontSize": boolean, "detailsVisible": boolean, "textUnblocked": boolean}, "critique": string, "reflection": string, "pythonCode": string}',
      parser: parseFinalFigureReviewPayload,
      structuredOutput: createFinalFigureReviewStructuredOutput(),
    });

    return response.parsed;
  }

  private async executePlotStep(
    jobId: string,
    label: string,
    attempt: number,
    code: string,
    renderProfile: 'draft' | 'final',
  ): Promise<ExecPlotResponse> {
    this.setCurrentStage(jobId, label);
    const stepId = this.startExecStep(jobId, label, attempt);

    try {
      const execution = await this.execService.runPlot({
        code,
        timeoutMs: 120_000,
        installMissingPackages: true,
        renderProfile,
      });

      this.finishExecStep(
        jobId,
        stepId,
        execution,
        isSuccessfulPlotExecution(execution) ? 'completed' : 'failed',
        isSuccessfulPlotExecution(execution)
          ? undefined
          : buildExecFailureMessage(execution),
      );

      return execution;
    } catch (error) {
      this.finishExecStep(
        jobId,
        stepId,
        undefined,
        'failed',
        getErrorMessage(error),
      );
      throw error;
    }
  }

  private async runStructuredLlmStep<T>(
    options: StructuredLlmStepOptions<T>,
  ): Promise<{ response: LlmChatResponse; parsed: T }> {
    let lastAttempt = await this.performStructuredLlmCall(options);

    if (lastAttempt.ok) {
      return {
        response: lastAttempt.response,
        parsed: lastAttempt.parsed,
      };
    }

    let lastError = lastAttempt.message;

    for (
      let retryAttempt = 1;
      retryAttempt <= TRUNCATION_RETRY_ATTEMPTS &&
      shouldRetryStructuredCall(lastAttempt.response, lastError);
      retryAttempt += 1
    ) {
      const completionRetryAttempt = await this.performStructuredLlmCall({
        ...options,
        label: `${options.label} completion retry`,
        attempt: retryAttempt,
        maxTokens: Math.min(options.maxTokens * 2, TRUNCATION_RETRY_MAX_TOKENS),
      });

      if (completionRetryAttempt.ok) {
        return {
          response: completionRetryAttempt.response,
          parsed: completionRetryAttempt.parsed,
        };
      }

      lastAttempt = completionRetryAttempt;
      lastError = completionRetryAttempt.message;
    }

    for (
      let repairAttempt = 1;
      repairAttempt <= FORMAT_RETRY_ATTEMPTS;
      repairAttempt += 1
    ) {
      const formatRepairAttempt = await this.performStructuredLlmCall({
        ...options,
        label: options.formatRetryLabel,
        attempt: repairAttempt,
        messages: buildFormatRepairMessages(
          options.requiredSchemaDescription,
          lastAttempt.response.text,
        ),
        maxTokens: FORMAT_REPAIR_MAX_TOKENS,
        enableFileSystemTools: false,
      });

      if (formatRepairAttempt.ok) {
        return {
          response: formatRepairAttempt.response,
          parsed: formatRepairAttempt.parsed,
        };
      }

      lastError = formatRepairAttempt.message;
    }

    throw new BadGatewayException(
      `${options.label} did not return valid JSON after format repair: ${lastError}`,
    );
  }

  private async performStructuredLlmCall<T>(
    options: Omit<
      StructuredLlmStepOptions<T>,
      'formatRetryLabel' | 'requiredSchemaDescription'
    > & {
      requiredSchemaDescription?: string;
      formatRetryLabel?: string;
    },
  ): Promise<
    | { ok: true; response: LlmChatResponse; parsed: T }
    | { ok: false; response: LlmChatResponse; message: string }
  > {
    this.setCurrentStage(options.jobId, options.label);
    const stepId = this.startLlmStep(
      options.jobId,
      options.label,
      options.attempt,
    );

    try {
      const response = await this.llmService.chat({
        provider: options.provider,
        model: options.model,
        messages: options.messages,
        maxTokens: options.maxTokens,
        temperature: DEFAULT_LLM_TEMPERATURE,
        reasoningEffort: options.reasoningEffort,
        tools: options.enableFileSystemTools ? { fileSystem: true } : undefined,
        structuredOutput: options.structuredOutput,
      });
      const parsed = options.parser(response.text);

      if (!parsed.ok) {
        this.finishLlmStep(
          options.jobId,
          stepId,
          'failed',
          response,
          undefined,
          parsed.message,
        );

        return {
          ok: false,
          response,
          message: parsed.message,
        };
      }

      this.finishLlmStep(
        options.jobId,
        stepId,
        'completed',
        response,
        parsed.value,
      );

      return {
        ok: true,
        response,
        parsed: parsed.value,
      };
    } catch (error) {
      this.finishLlmStep(
        options.jobId,
        stepId,
        'failed',
        undefined,
        undefined,
        getErrorMessage(error),
      );
      throw error;
    }
  }

  private normalizeStartRequest(
    requestBody: StartExecPlotWorkflowRequestBody,
  ): ExecPlotWorkflowRequest {
    if (!isObject(requestBody)) {
      throw new BadRequestException('Request body must be a JSON object.');
    }

    const provider = requestBody.provider?.trim();
    const model = requestBody.model?.trim();
    const reviewModel = requestBody.reviewModel?.trim();
    const prompt = requestBody.prompt?.trim();
    const contextPath = requestBody.contextPath?.trim();
    const enableFileSystemTools = requestBody.enableFileSystemTools;
    const reasoningEffort = normalizeReasoningEffort(
      requestBody.reasoningEffort,
    );

    if (!provider) {
      throw new BadRequestException('`provider` must be a non-empty string.');
    }

    if (!model) {
      throw new BadRequestException('`model` must be a non-empty string.');
    }

    if (!prompt) {
      throw new BadRequestException('`prompt` must be a non-empty string.');
    }

    if (
      typeof enableFileSystemTools !== 'undefined' &&
      typeof enableFileSystemTools !== 'boolean'
    ) {
      throw new BadRequestException(
        '`enableFileSystemTools` must be a boolean when provided.',
      );
    }

    return {
      provider,
      model,
      ...(reviewModel ? { reviewModel } : {}),
      prompt,
      ...(contextPath ? { contextPath } : {}),
      enableFileSystemTools: enableFileSystemTools ?? false,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }

  private startLlmStep(jobId: string, label: string, attempt: number): string {
    const stepId = randomUUID();

    this.updateJob(jobId, (job) => {
      const step: ExecPlotWorkflowLlmStep = {
        id: stepId,
        kind: 'llm',
        label,
        attempt,
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      job.steps.push(step);
    });

    return stepId;
  }

  private startExecStep(jobId: string, label: string, attempt: number): string {
    const stepId = randomUUID();

    this.updateJob(jobId, (job) => {
      const step: ExecPlotWorkflowExecStep = {
        id: stepId,
        kind: 'exec',
        label,
        attempt,
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      job.steps.push(step);
    });

    return stepId;
  }

  private finishLlmStep(
    jobId: string,
    stepId: string,
    status: 'completed' | 'failed',
    response?: LlmChatResponse,
    parsed?: unknown,
    error?: string,
  ): void {
    this.updateJob(jobId, (job) => {
      const step = job.steps.find(
        (candidate): candidate is ExecPlotWorkflowLlmStep =>
          candidate.id === stepId && candidate.kind === 'llm',
      );

      if (!step) {
        return;
      }

      step.status = status;
      step.completedAt = new Date().toISOString();
      step.error = error;

      if (response) {
        step.llm = {
          provider: response.provider,
          model: response.model,
          responseId: response.responseId,
          finishReason: response.finishReason,
          text: response.text,
          usage: response.usage,
          ...(response.toolTrace ? { toolTrace: response.toolTrace } : {}),
          ...(typeof parsed !== 'undefined' ? { parsed } : {}),
        };
      }
    });
  }

  private finishExecStep(
    jobId: string,
    stepId: string,
    execution: ExecPlotResponse | undefined,
    status: 'completed' | 'failed',
    error?: string,
  ): void {
    this.updateJob(jobId, (job) => {
      const step = job.steps.find(
        (candidate): candidate is ExecPlotWorkflowExecStep =>
          candidate.id === stepId && candidate.kind === 'exec',
      );

      if (!step) {
        return;
      }

      step.status = status;
      step.completedAt = new Date().toISOString();
      step.error = error;

      if (execution) {
        step.exec = execution;
      }
    });
  }

  private setCurrentStage(jobId: string, currentStage: string): void {
    this.updateJob(jobId, (job) => {
      job.status = 'running';
      job.currentStage = currentStage;
    });
  }

  private completeJob(jobId: string): void {
    this.updateJob(jobId, (job) => {
      job.status = 'completed';
      job.currentStage = 'Completed';
      job.completedAt = new Date().toISOString();
      job.terminalError = undefined;
    });
  }

  private failJob(jobId: string, error: unknown): void {
    this.updateJob(jobId, (job) => {
      job.status = 'failed';
      job.currentStage = 'Failed';
      job.completedAt = new Date().toISOString();
      job.terminalError = getErrorMessage(error);
    });
  }

  private updateJob(
    jobId: string,
    updater: (job: ExecPlotWorkflowJob) => void,
  ): void {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new NotFoundException(
        `Plot workflow job "${jobId}" was not found.`,
      );
    }

    updater(job);
    job.updatedAt = new Date().toISOString();
  }

  private getJob(jobId: string): ExecPlotWorkflowJob {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new NotFoundException(
        `Plot workflow job "${jobId}" was not found.`,
      );
    }

    return job;
  }
}

export function parseDraftCodePayload(
  text: string,
): ParseResult<DraftCodePayload> {
  const parsed = parseStrictJsonObject(text);

  if (!parsed.ok) {
    return parsed;
  }

  const pythonCode = getTrimmedString(parsed.value, 'pythonCode');

  if (!pythonCode) {
    return {
      ok: false,
      message: 'Response JSON must include a non-empty `pythonCode` string.',
    };
  }

  return {
    ok: true,
    value: { pythonCode },
  };
}

export function parseCritiqueRevisionPayload(
  text: string,
): ParseResult<CritiqueRevisionPayload> {
  const parsed = parseStrictJsonObject(text);

  if (!parsed.ok) {
    return parsed;
  }

  const critique = getTrimmedString(parsed.value, 'critique');
  const reflection = getTrimmedString(parsed.value, 'reflection');
  const pythonCode = getTrimmedString(parsed.value, 'pythonCode');

  if (!critique || !reflection || !pythonCode) {
    return {
      ok: false,
      message:
        'Response JSON must include non-empty `critique`, `reflection`, and `pythonCode` strings.',
    };
  }

  return {
    ok: true,
    value: {
      critique,
      reflection,
      pythonCode,
    },
  };
}

export function parseExecutionRepairPayload(
  text: string,
): ParseResult<ExecutionRepairPayload> {
  const parsed = parseStrictJsonObject(text);

  if (!parsed.ok) {
    return parsed;
  }

  const diagnosis = getTrimmedString(parsed.value, 'diagnosis');
  const pythonCode = getTrimmedString(parsed.value, 'pythonCode');

  if (!diagnosis || !pythonCode) {
    return {
      ok: false,
      message:
        'Response JSON must include non-empty `diagnosis` and `pythonCode` strings.',
    };
  }

  return {
    ok: true,
    value: {
      diagnosis,
      pythonCode,
    },
  };
}

export function parseFinalFigureReviewPayload(
  text: string,
): ParseResult<FinalFigureReviewPayload> {
  const parsed = parseStrictJsonObject(text);

  if (!parsed.ok) {
    return parsed;
  }

  const passed = parsed.value['passed'];
  const critique = getTrimmedString(parsed.value, 'critique');
  const reflection = getTrimmedString(parsed.value, 'reflection');
  const pythonCode = getTrimmedString(parsed.value, 'pythonCode');
  const criteria = parseFinalFigureReviewCriteria(parsed.value['criteria']);

  if (typeof passed !== 'boolean') {
    return {
      ok: false,
      message: 'Response JSON must include a boolean `passed` field.',
    };
  }

  if (!criteria.ok) {
    return criteria;
  }

  if (!critique || !reflection || !pythonCode) {
    return {
      ok: false,
      message:
        'Response JSON must include non-empty `critique`, `reflection`, and `pythonCode` strings.',
    };
  }

  return {
    ok: true,
    value: {
      passed,
      criteria: criteria.value,
      critique,
      reflection,
      pythonCode,
    },
  };
}

function parseStrictJsonObject(text: string): ParseResult<JsonObject> {
  const trimmed = text.trim();

  if (!trimmed.startsWith('{')) {
    return {
      ok: false,
      message:
        'Response must be a raw JSON object with no markdown or commentary.',
    };
  }

  if (!trimmed.endsWith('}')) {
    return {
      ok: false,
      message: 'Response appears truncated before the JSON object completed.',
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (!isObject(parsed)) {
      return {
        ok: false,
        message: 'Response must parse to a JSON object.',
      };
    }

    return {
      ok: true,
      value: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : 'Response was not valid JSON.',
    };
  }
}

function shouldRetryStructuredCall(
  response: LlmChatResponse,
  parseMessage: string,
): boolean {
  const finishReason = response.finishReason?.trim().toLowerCase();

  return (
    parseMessage.toLowerCase().includes('truncated') ||
    finishReason === 'incomplete' ||
    finishReason === 'max_output_tokens'
  );
}

function buildFormatRepairMessages(
  requiredSchemaDescription: string,
  invalidResponseText: string,
): LlmChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are correcting a previous model response so it exactly matches the required JSON contract. Return only a JSON object. Do not use markdown fences. Do not add commentary before or after the JSON.',
    },
    {
      role: 'user',
      content: [
        `Return a JSON object that matches this schema exactly:\n${requiredSchemaDescription}`,
        `Previous invalid response:\n${trimText(invalidResponseText, MAX_FORMAT_REPAIR_SOURCE_TEXT_LENGTH)}`,
      ].join('\n\n'),
    },
  ];
}

function toWorkflowImages(artifacts: ExecArtifact[]) {
  return artifacts.map((artifact) => ({
    mimeType: artifact.mimeType,
    base64Data: artifact.base64,
  }));
}

function formatExecutionFeedback(execution: ExecPlotResponse): string {
  const sections = [
    `Render profile: ${execution.renderProfile}`,
    `Status: ${execution.status}`,
    `Exit code: ${execution.exitCode ?? 'null'}`,
    `Artifact count: ${execution.artifacts.length}`,
    execution.layoutDiagnostics
      ? `Layout diagnostics:\n${formatLayoutDiagnostics(
          execution.layoutDiagnostics,
        )}`
      : undefined,
    execution.signal ? `Signal: ${execution.signal}` : undefined,
    execution.errors.length > 0
      ? `Errors:\n${trimText(execution.errors.join('\n'), 2_000)}`
      : undefined,
    execution.logs.length > 0
      ? `Recent logs:\n${formatLogFeedback(execution.logs)}`
      : undefined,
    !execution.logs.length && execution.stderr.trim()
      ? `stderr:\n${trimText(execution.stderr.trim(), 4_000)}`
      : undefined,
    !execution.logs.length && execution.stdout.trim()
      ? `stdout:\n${trimText(execution.stdout.trim(), 2_000)}`
      : undefined,
    execution.artifacts.length === 0
      ? 'No figure artifacts were produced.'
      : undefined,
  ];

  return sections.filter(Boolean).join('\n\n');
}

function formatLogFeedback(logs: ExecLogEntry[]): string {
  const recentLogs = logs.slice(-MAX_EXECUTION_FEEDBACK_LOG_ENTRIES);
  const renderedLogs = recentLogs
    .map((log) => `[${log.stream}] ${log.text}`.trimEnd())
    .join('\n');

  return trimText(renderedLogs, MAX_EXECUTION_FEEDBACK_TEXT_LENGTH);
}

function formatLayoutDiagnostics(
  layoutDiagnostics: NonNullable<ExecPlotResponse['layoutDiagnostics']>,
): string {
  return trimText(JSON.stringify(layoutDiagnostics, null, 2), 4_000);
}

function trimText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 16))}\n...[truncated]`;
}

function buildExecFailureMessage(execution: ExecPlotResponse): string {
  if (execution.errors.length > 0) {
    return execution.errors[0] ?? 'Plot execution failed.';
  }

  if (execution.status === 'timed_out') {
    return 'Plot execution timed out.';
  }

  if (execution.artifacts.length === 0) {
    return 'The plotting sandbox ran without producing any figure artifacts.';
  }

  return 'Plot execution failed.';
}

function buildFinalFigureReviewFailureMessage(
  review: FinalFigureReviewPayload,
): string {
  const unmetCriteria = getFailedFinalFigureCriteria(review.criteria);

  if (unmetCriteria.length === 0) {
    return 'Final figure review did not pass after the maximum revision depth.';
  }

  return `Final figure review did not satisfy the required visual criteria after ${MAX_FINAL_FIGURE_REVIEW_REVISIONS} revision passes. Unmet criteria: ${unmetCriteria.join(', ')}.`;
}

function didFinalFigureReviewPass(review: FinalFigureReviewPayload): boolean {
  return (
    review.passed && getFailedFinalFigureCriteria(review.criteria).length === 0
  );
}

function createDraftCodeStructuredOutput(): LlmStructuredOutputSchema {
  return {
    name: 'draft_code_payload',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        pythonCode: {
          type: 'string',
        },
      },
      required: ['pythonCode'],
      additionalProperties: false,
    },
  };
}

function createCritiqueRevisionStructuredOutput(): LlmStructuredOutputSchema {
  return {
    name: 'critique_revision_payload',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        critique: {
          type: 'string',
        },
        reflection: {
          type: 'string',
        },
        pythonCode: {
          type: 'string',
        },
      },
      required: ['critique', 'reflection', 'pythonCode'],
      additionalProperties: false,
    },
  };
}

function createExecutionRepairStructuredOutput(): LlmStructuredOutputSchema {
  return {
    name: 'execution_repair_payload',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        diagnosis: {
          type: 'string',
        },
        pythonCode: {
          type: 'string',
        },
      },
      required: ['diagnosis', 'pythonCode'],
      additionalProperties: false,
    },
  };
}

function createFinalFigureReviewStructuredOutput(): LlmStructuredOutputSchema {
  return {
    name: 'final_figure_review_payload',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        passed: {
          type: 'boolean',
        },
        criteria: {
          type: 'object',
          properties: {
            appropriateSpacing: {
              type: 'boolean',
            },
            appropriateFontSize: {
              type: 'boolean',
            },
            detailsVisible: {
              type: 'boolean',
            },
            textUnblocked: {
              type: 'boolean',
            },
          },
          required: [
            'appropriateSpacing',
            'appropriateFontSize',
            'detailsVisible',
            'textUnblocked',
          ],
          additionalProperties: false,
        },
        critique: {
          type: 'string',
        },
        reflection: {
          type: 'string',
        },
        pythonCode: {
          type: 'string',
        },
      },
      required: ['passed', 'criteria', 'critique', 'reflection', 'pythonCode'],
      additionalProperties: false,
    },
  };
}

function isSuccessfulPlotExecution(execution: ExecPlotResponse): boolean {
  return execution.status === 'completed' && execution.artifacts.length > 0;
}

function cloneJob(job: ExecPlotWorkflowJob): ExecPlotWorkflowJob {
  return JSON.parse(JSON.stringify(job)) as ExecPlotWorkflowJob;
}

function getTrimmedString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

function parseFinalFigureReviewCriteria(
  value: unknown,
): ParseResult<FinalFigureReviewCriteria> {
  if (!isObject(value)) {
    return {
      ok: false,
      message: 'Response JSON must include a `criteria` object.',
    };
  }

  const criteriaKeys = [
    'appropriateSpacing',
    'appropriateFontSize',
    'detailsVisible',
    'textUnblocked',
  ] as const;
  const criteria = {} as FinalFigureReviewCriteria;

  for (const key of criteriaKeys) {
    if (typeof value[key] !== 'boolean') {
      return {
        ok: false,
        message: `Response JSON must include a boolean \`criteria.${key}\` field.`,
      };
    }

    criteria[key] = value[key];
  }

  return {
    ok: true,
    value: criteria,
  };
}

function getFailedFinalFigureCriteria(
  criteria: FinalFigureReviewCriteria,
): string[] {
  return [
    criteria.appropriateSpacing ? null : 'appropriateSpacing',
    criteria.appropriateFontSize ? null : 'appropriateFontSize',
    criteria.detailsVisible ? null : 'detailsVisible',
    criteria.textUnblocked ? null : 'textUnblocked',
  ].filter((value): value is string => value !== null);
}

function appendWorkflowNotes(
  existing: string,
  title: string,
  note: string,
): string {
  const trimmedNote = note.trim();

  if (!trimmedNote) {
    return existing;
  }

  const section = `${title}\n${trimmedNote}`;

  if (!existing.trim()) {
    return section;
  }

  return `${existing.trim()}\n\n${section}`;
}

function normalizeReasoningEffort(
  value: unknown,
): LlmReasoningEffort | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestException(
      '`reasoningEffort` must be one of: none, low, medium, high.',
    );
  }

  const normalized = value.trim().toLowerCase();

  if (
    !LLM_REASONING_EFFORTS.includes(
      normalized as (typeof LLM_REASONING_EFFORTS)[number],
    )
  ) {
    throw new BadRequestException(
      '`reasoningEffort` must be one of: none, low, medium, high.',
    );
  }

  return normalized as LlmReasoningEffort;
}

function getReviewModel(request: ExecPlotWorkflowRequest): string {
  return request.reviewModel?.trim() || request.model;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown workflow error.';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}
