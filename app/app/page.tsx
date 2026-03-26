"use client";

import {
  Accordion,
  ActionIcon,
  Alert,
  AppShell,
  Autocomplete,
  Avatar,
  Badge,
  Box,
  Button,
  Code,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconBrain,
  IconCheck,
  IconCircleDot,
  IconFolderSearch,
  IconRefresh,
  IconRobot,
  IconSend2,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  FormEvent,
  KeyboardEvent,
  startTransition,
  useEffect,
  useRef,
  useState,
} from "react";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type ProviderId = "openai" | "gemini" | "anthropic";
const REASONING_EFFORT_OPTIONS = ["none", "low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORT_OPTIONS)[number];

type ProviderInfo = {
  provider: ProviderId;
  displayName: string;
  aliases: string[];
  apiKeyEnv: string;
  enabled: boolean;
  defaultModel: string;
  exampleModels: string[];
  docsUrl: string;
  allowCustomModel: true;
};

type ProvidersResponse = {
  providers: ProviderInfo[];
};

type LlmChatToolOptions = {
  fileSystem?: boolean;
};

type LlmChatImageInput = {
  mimeType: string;
  base64Data: string;
};

type LlmChatRequest = {
  provider: string;
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
    images?: LlmChatImageInput[];
  }>;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  tools?: LlmChatToolOptions;
};

type LlmChatResponse = {
  provider: ProviderId;
  model: string;
  responseId?: string;
  text: string;
  finishReason?: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  toolTrace?: LlmToolTraceEntry[];
};

type LlmToolTraceEntry = {
  round: number;
  toolName: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  callId?: string;
};

type ExecLogEntry = {
  stream: "stdout" | "stderr" | "system";
  text: string;
  timestamp: string;
};

type ExecArtifact = {
  kind: "image";
  filename: string;
  mimeType: string;
  base64: string;
  byteSize: number;
};

type ExecPlotFigureLayoutDiagnostics = {
  filename: string;
  widthPx: number;
  heightPx: number;
  axesCount: number;
  textElementCount: number;
  visibleTextElementCount: number;
  clippedTextCount: number;
  overlappingTextPairCount: number;
  verySmallTextCount: number;
  minFontSize?: number;
  maxFontSize?: number;
  averageFontSize?: number;
};

type ExecPlotLayoutDiagnostics = {
  totalFigureCount: number;
  totalAxesCount: number;
  totalTextElementCount: number;
  totalVisibleTextElementCount: number;
  totalClippedTextCount: number;
  totalOverlappingTextPairCount: number;
  totalVerySmallTextCount: number;
  figures: ExecPlotFigureLayoutDiagnostics[];
};

type ExecPlotSandboxStatus = {
  available: boolean;
  bootstrapped: boolean;
  command?: string;
  packageDirectory: string;
  requiredPackages: string[];
};

type ExecPlotCapabilitiesResponse = {
  os: string;
  sandbox: ExecPlotSandboxStatus;
};

type ExecPlotResponse = {
  requestedRuntime: "python";
  resolvedRuntime: "python";
  os: string;
  renderProfile: "draft" | "final";
  command: string;
  commandArgs: string[];
  workingDirectory: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  logs: ExecLogEntry[];
  errors: string[];
  sandbox: ExecPlotSandboxStatus;
  artifacts: ExecArtifact[];
  layoutDiagnostics?: ExecPlotLayoutDiagnostics;
};

type ExecPlotWorkflowStatus = "queued" | "running" | "completed" | "failed";
type ExecPlotWorkflowStepStatus = "running" | "completed" | "failed";

type StartExecPlotWorkflowResponse = {
  jobId: string;
  status: "queued" | "running";
};

type ExecPlotWorkflowRequest = {
  provider: string;
  model: string;
  reviewModel?: string;
  prompt: string;
  contextPath?: string;
  enableFileSystemTools?: boolean;
  reasoningEffort?: ReasoningEffort;
};

type ExecPlotWorkflowLlmDetails = {
  provider: string;
  model: string;
  responseId?: string;
  finishReason?: string;
  text: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  toolTrace?: LlmToolTraceEntry[];
  parsed?: unknown;
};

type ExecPlotWorkflowLlmStep = {
  id: string;
  kind: "llm";
  label: string;
  attempt: number;
  status: ExecPlotWorkflowStepStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  llm?: ExecPlotWorkflowLlmDetails;
};

type ExecPlotWorkflowExecStep = {
  id: string;
  kind: "exec";
  label: string;
  attempt: number;
  status: ExecPlotWorkflowStepStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  exec?: ExecPlotResponse;
};

type ExecPlotWorkflowStep =
  | ExecPlotWorkflowLlmStep
  | ExecPlotWorkflowExecStep;

type ExecPlotWorkflowJob = {
  jobId: string;
  status: ExecPlotWorkflowStatus;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  request: {
    provider: string;
    model: string;
    reviewModel?: string;
    prompt: string;
    contextPath?: string;
    enableFileSystemTools: boolean;
    reasoningEffort?: ReasoningEffort;
  };
  draftCode: string;
  finalCode: string;
  critique: string;
  reflection: string;
  draftArtifacts: ExecArtifact[];
  finalArtifacts: ExecArtifact[];
  steps: ExecPlotWorkflowStep[];
  terminalError?: string;
};

type ChatBubble = {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider?: ProviderId;
  model?: string;
  toolTrace?: LlmToolTraceEntry[];
  createdAt: string;
};

async function getErrorMessage(response: Response): Promise<string> {
  const body = await response.text();

  if (!body) {
    return `Request failed with status ${response.status}`;
  }

  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return body;
  }

  return body;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  return (await response.json()) as T;
}

function providerAccent(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "teal";
    case "gemini":
      return "orange";
    case "anthropic":
      return "violet";
  }
}

function formatUsage(response: LlmChatResponse | null) {
  if (!response) {
    return "No response yet";
  }

  const inputTokens = response.usage.inputTokens ?? 0;
  const outputTokens = response.usage.outputTokens ?? 0;
  const totalTokens =
    response.usage.totalTokens ?? inputTokens + outputTokens;

  return `${inputTokens} in / ${outputTokens} out / ${totalTokens} total`;
}

function formatTracePayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  if (byteSize < 1024 * 1024) {
    return `${(byteSize / 1024).toFixed(1)} KB`;
  }

  return `${(byteSize / (1024 * 1024)).toFixed(2)} MB`;
}

function isPlotWorkflowRunning(status: ExecPlotWorkflowStatus | null | undefined) {
  return status === "queued" || status === "running";
}

function isWorkflowLlmStep(
  step: ExecPlotWorkflowStep,
): step is ExecPlotWorkflowLlmStep {
  return step.kind === "llm";
}

function formatWorkflowStepLogs(execution: ExecPlotResponse): string {
  if (execution.logs.length > 0) {
    return execution.logs
      .map((log) => `[${log.stream}] ${log.text}`.trimEnd())
      .join("\n");
  }

  const fallbacks = [execution.stderr.trim(), execution.stdout.trim()]
    .filter(Boolean)
    .join("\n\n");

  return fallbacks || "No logs captured.";
}

function workflowStatusColor(status: ExecPlotWorkflowStatus): string {
  switch (status) {
    case "queued":
      return "gray";
    case "running":
      return "blue";
    case "completed":
      return "teal";
    case "failed":
      return "red";
  }
}

function ToolTracePanel({
  traces,
  compact = false,
}: {
  traces: LlmToolTraceEntry[];
  compact?: boolean;
}) {
  if (traces.length === 0) {
    return null;
  }

  return (
    <Stack gap={compact ? "xs" : "sm"}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <ThemeIcon color="teal" radius="xl" size={compact ? 30 : 34} variant="light">
            <IconFolderSearch size={compact ? 16 : 18} />
          </ThemeIcon>
          <Box>
            <Text fw={700} size={compact ? "sm" : "md"}>
              Tool trace
            </Text>
            <Text c="dimmed" size="xs">
              Filesystem tool calls made during this response.
            </Text>
          </Box>
        </Group>
        <Badge color="teal" variant="light">
          {traces.length} call{traces.length === 1 ? "" : "s"}
        </Badge>
      </Group>

      <Accordion chevronPosition="right" multiple radius="lg" variant="separated">
        {traces.map((trace, index) => (
          <Accordion.Item
            key={`${trace.toolName}-${trace.callId ?? index}`}
            value={`${trace.toolName}-${index}`}
          >
            <Accordion.Control px={compact ? "sm" : "md"} py={compact ? 10 : "sm"}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Badge color="dark" variant="filled">
                    #{index + 1}
                  </Badge>
                  <Text fw={700} size="sm">
                    {trace.toolName}
                  </Text>
                </Group>
                <Group gap={6} wrap="nowrap">
                  <Badge color="gray" variant="outline">
                    round {trace.round}
                  </Badge>
                  {trace.callId ? <Code>{trace.callId}</Code> : null}
                  <Badge color={trace.isError ? "red" : "teal"} variant="light">
                    {trace.isError ? "error" : "success"}
                  </Badge>
                </Group>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="xs">
                <Text c="dimmed" size="xs">
                  Input
                </Text>
                <Box
                  component="pre"
                  p={compact ? "sm" : "md"}
                  style={{
                    margin: 0,
                    maxHeight: compact ? 180 : 240,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    borderRadius: "18px",
                    border: "1px solid rgba(15, 23, 42, 0.08)",
                    background: "rgba(248,250,252,0.96)",
                    fontFamily: "var(--font-geist-mono)",
                    fontSize: compact ? "12px" : "13px",
                  }}
                >
                  {formatTracePayload(trace.input)}
                </Box>

                <Text c="dimmed" size="xs">
                  Result
                </Text>
                <Box
                  component="pre"
                  p={compact ? "sm" : "md"}
                  style={{
                    margin: 0,
                    maxHeight: compact ? 220 : 300,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    borderRadius: "18px",
                    border: "1px solid rgba(15, 23, 42, 0.08)",
                    background: trace.isError
                      ? "rgba(254,242,242,0.96)"
                      : "rgba(244,251,249,0.96)",
                    fontFamily: "var(--font-geist-mono)",
                    fontSize: compact ? "12px" : "13px",
                  }}
                >
                  {formatTracePayload(trace.result)}
                </Box>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}

function ProviderCard({
  provider,
  isSelected,
  onSelect,
}: {
  provider: ProviderInfo;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const accent = providerAccent(provider.provider);

  return (
    <Paper
      component="button"
      onClick={onSelect}
      p="md"
      radius="xl"
      shadow={isSelected ? "lg" : "xs"}
      withBorder
      style={{
        width: "100%",
        cursor: "pointer",
        textAlign: "left",
        background: isSelected
          ? "linear-gradient(145deg, rgba(255,255,255,0.98), rgba(242,252,251,0.94))"
          : "rgba(255,255,255,0.84)",
        borderColor: isSelected
          ? "rgba(36, 170, 146, 0.34)"
          : "rgba(15, 23, 42, 0.08)",
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group wrap="nowrap" align="flex-start">
          <Avatar color={accent} radius="xl" variant="light">
            {provider.displayName.slice(0, 1)}
          </Avatar>
          <Box>
            <Text fw={700} size="sm">
              {provider.displayName}
            </Text>
            <Text c="dimmed" size="xs" mt={2}>
              Default: {provider.defaultModel}
            </Text>
          </Box>
        </Group>
        <Badge
          color={provider.enabled ? "teal" : "gray"}
          variant={provider.enabled ? "light" : "outline"}
        >
          {provider.enabled ? "Ready" : "Key missing"}
        </Badge>
      </Group>

      <Group gap={6} mt="md">
        {provider.exampleModels.slice(0, 2).map((exampleModel) => (
          <Badge key={exampleModel} color={accent} variant="dot">
            {exampleModel}
          </Badge>
        ))}
      </Group>
    </Paper>
  );
}

function ChatMessage({ message }: { message: ChatBubble }) {
  const isAssistant = message.role === "assistant";

  return (
    <Group
      align="flex-start"
      justify={isAssistant ? "flex-start" : "flex-end"}
      wrap="nowrap"
    >
      {isAssistant ? (
        <ThemeIcon size={42} radius="xl" variant="light" color="brand">
          <IconRobot size={20} />
        </ThemeIcon>
      ) : null}

      <Paper
        p="md"
        radius="xl"
        shadow="sm"
        style={{
          maxWidth: "82%",
          background: isAssistant
            ? "rgba(255,255,255,0.92)"
            : "linear-gradient(165deg, rgba(10,83,73,0.98), rgba(20,122,107,0.92))",
          color: isAssistant ? "var(--mantine-color-dark-9)" : "white",
          border: isAssistant ? "1px solid rgba(15, 23, 42, 0.06)" : "none",
        }}
      >
        <Group justify="space-between" gap="xs" mb="xs">
          <Text fw={700} size="sm">
            {isAssistant ? "Assistant" : "You"}
          </Text>
          <Group gap={6}>
            {message.provider ? (
              <Badge color={providerAccent(message.provider)} variant="light">
                {message.provider}
              </Badge>
            ) : null}
            {message.model ? (
              <Badge color="gray" variant="outline">
                {message.model}
              </Badge>
            ) : null}
          </Group>
        </Group>
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {message.content}
        </Text>
        {isAssistant && message.toolTrace && message.toolTrace.length > 0 ? (
          <Box mt="md">
            <ToolTracePanel compact traces={message.toolTrace} />
          </Box>
        ) : null}
      </Paper>

      {!isAssistant ? (
        <ThemeIcon size={42} radius="xl" variant="filled" color="dark">
          <IconCircleDot size={18} />
        </ThemeIcon>
      ) : null}
    </Group>
  );
}

function WorkflowStepDetails({ step }: { step: ExecPlotWorkflowStep }) {
  if (isWorkflowLlmStep(step)) {
    return (
      <Stack gap="md">
        <Group gap="xs">
          <Badge color="dark" variant="light">
            LLM
          </Badge>
          <Badge
            color={
              step.status === "completed"
                ? "teal"
                : step.status === "running"
                  ? "blue"
                  : "red"
            }
          >
            {step.status}
          </Badge>
          <Badge color="gray" variant="outline">
            attempt {step.attempt}
          </Badge>
          {step.llm?.provider ? (
            <Badge color="gray" variant="outline">
              {step.llm.provider}
            </Badge>
          ) : null}
          {step.llm?.model ? <Code>{step.llm.model}</Code> : null}
        </Group>

        {step.error ? (
          <Alert color="red" icon={<IconAlertCircle size={16} />} radius="lg">
            {step.error}
          </Alert>
        ) : null}

        {typeof step.llm?.parsed !== "undefined" ? (
          <Box>
            <Text c="dimmed" size="xs" mb={6}>
              Parsed output
            </Text>
            <Box
              component="pre"
              p="md"
              style={{
                margin: 0,
                maxHeight: 260,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                borderRadius: "20px",
                background: "rgba(248,250,252,0.96)",
                border: "1px solid rgba(15, 23, 42, 0.08)",
                fontFamily: "var(--font-geist-mono)",
                fontSize: "13px",
              }}
            >
              {formatTracePayload(step.llm.parsed)}
            </Box>
          </Box>
        ) : null}

        {step.llm?.text ? (
          <Box>
            <Text c="dimmed" size="xs" mb={6}>
              Raw model response
            </Text>
            <Box
              component="pre"
              p="md"
              style={{
                margin: 0,
                maxHeight: 320,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                borderRadius: "20px",
                background: "rgba(248,250,252,0.96)",
                border: "1px solid rgba(15, 23, 42, 0.08)",
                fontFamily: "var(--font-geist-mono)",
                fontSize: "13px",
              }}
            >
              {step.llm.text}
            </Box>
          </Box>
        ) : null}

        {step.llm?.toolTrace && step.llm.toolTrace.length > 0 ? (
          <ToolTracePanel traces={step.llm.toolTrace} />
        ) : null}
      </Stack>
    );
  }

  const execution = step.exec;

  return (
    <Stack gap="md">
      <Group gap="xs">
        <Badge color="dark" variant="light">
          EXEC
        </Badge>
        <Badge
          color={
            step.status === "completed"
              ? "teal"
              : step.status === "running"
                ? "blue"
                : "red"
          }
        >
          {step.status}
        </Badge>
        <Badge color="gray" variant="outline">
          attempt {step.attempt}
        </Badge>
        {execution?.renderProfile ? (
          <Badge color={execution.renderProfile === "draft" ? "cyan" : "teal"} variant="light">
            {execution.renderProfile}
          </Badge>
        ) : null}
      </Group>

      {step.error ? (
        <Alert color="red" icon={<IconAlertCircle size={16} />} radius="lg">
          {step.error}
        </Alert>
      ) : null}

      {execution ? (
        <>
          <Group gap="xs">
            <Badge color="gray" variant="outline">
              {execution.durationMs} ms
            </Badge>
            <Badge color="dark" variant="outline">
              {execution.command}
            </Badge>
            {execution.exitCode !== null ? (
              <Badge color="gray" variant="outline">
                exit {execution.exitCode}
              </Badge>
            ) : null}
          </Group>

          <Box
            component="pre"
            p="md"
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              borderRadius: "20px",
              background: "rgba(248,250,252,0.96)",
              border: "1px solid rgba(15, 23, 42, 0.08)",
              fontFamily: "var(--font-geist-mono)",
              fontSize: "13px",
            }}
          >
            {formatWorkflowStepLogs(execution)}
          </Box>

          {execution.layoutDiagnostics ? (
            <Box>
              <Text c="dimmed" size="xs" mb={6}>
                Layout diagnostics
              </Text>
              <Box
                component="pre"
                p="md"
                style={{
                  margin: 0,
                  maxHeight: 260,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  borderRadius: "20px",
                  background: "rgba(248,250,252,0.96)",
                  border: "1px solid rgba(15, 23, 42, 0.08)",
                  fontFamily: "var(--font-geist-mono)",
                  fontSize: "13px",
                }}
              >
                {formatTracePayload(execution.layoutDiagnostics)}
              </Box>
            </Box>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

export default function Home() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-5.4");
  const [reviewModel, setReviewModel] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("medium");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a precise assistant helping with graph-plot related questions.",
  );
  const [draft, setDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatBubble[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [lastResponse, setLastResponse] = useState<LlmChatResponse | null>(null);
  const [isFileSystemToolsEnabled, setIsFileSystemToolsEnabled] = useState(false);
  const [plotPrompt, setPlotPrompt] = useState("");
  const [plotContextPath, setPlotContextPath] = useState("");
  const [isPlotFileToolsEnabled, setIsPlotFileToolsEnabled] = useState(true);
  const [plotWorkflowJobId, setPlotWorkflowJobId] = useState<string | null>(null);
  const [plotWorkflowJob, setPlotWorkflowJob] =
    useState<ExecPlotWorkflowJob | null>(null);
  const [plotWorkflowError, setPlotWorkflowError] = useState<string | null>(null);
  const [plotCapabilities, setPlotCapabilities] =
    useState<ExecPlotCapabilitiesResponse | null>(null);
  const [plotCapabilitiesError, setPlotCapabilitiesError] = useState<string | null>(
    null,
  );
  const [isGeneratingPlot, setIsGeneratingPlot] = useState(false);
  const notifiedPlotWorkflowStatusRef = useRef<string | null>(null);

  const currentProvider =
    providers.find((provider) => provider.provider === selectedProvider) ?? null;

  async function loadProviders() {
    setProvidersLoading(true);
    setProvidersError(null);

    try {
      const response = await fetchJson<ProvidersResponse>("/api/llm/providers", {
        cache: "no-store",
      });

      if (response.providers.length === 0) {
        throw new Error("Backend returned no provider metadata.");
      }

      setProviders(response.providers);

      const selected =
        response.providers.find(
          (provider) => provider.provider === selectedProvider,
        ) ??
        response.providers.find((provider) => provider.enabled) ??
        response.providers[0];

      setSelectedProvider(selected.provider);
      setModel((currentModel) =>
        currentModel.trim() &&
        selected.provider === selectedProvider
          ? currentModel
          : selected.defaultModel,
      );
      setReviewModel("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to load provider metadata.";

      setProviders([]);
      setProvidersError(message);
      notifications.show({
        title: "Backend connection failed",
        message,
        color: "red",
      });
    } finally {
      setProvidersLoading(false);
    }
  }

  async function loadPlotCapabilities() {
    setPlotCapabilitiesError(null);

    try {
      const response = await fetchJson<ExecPlotCapabilitiesResponse>(
        "/api/exec/plot/capabilities",
        {
          cache: "no-store",
        },
      );

      setPlotCapabilities(response);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to load plotting sandbox status.";

      setPlotCapabilities(null);
      setPlotCapabilitiesError(message);
    }
  }

  useEffect(() => {
    void loadProviders();
    void loadPlotCapabilities();
    // This is a one-time bootstrap fetch; user-triggered refreshes use the same function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!plotWorkflowJobId) {
      return;
    }

    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const pollWorkflow = async () => {
      try {
        const workflowJob = await fetchJson<ExecPlotWorkflowJob>(
          `/api/exec/plot/workflows/${plotWorkflowJobId}`,
          {
            cache: "no-store",
          },
        );

        if (cancelled) {
          return;
        }

        setPlotWorkflowJob(workflowJob);
        setIsGeneratingPlot(isPlotWorkflowRunning(workflowJob.status));
        setPlotWorkflowError(null);

        if (workflowJob.status === "completed" || workflowJob.status === "failed") {
          const notificationKey = `${workflowJob.jobId}:${workflowJob.status}`;

          if (notifiedPlotWorkflowStatusRef.current !== notificationKey) {
            notifications.show({
              title:
                workflowJob.status === "completed"
                  ? "Final figure ready"
                  : "Figure workflow failed",
              message:
                workflowJob.status === "completed"
                  ? `Generated ${workflowJob.finalArtifacts.length} final figure${workflowJob.finalArtifacts.length === 1 ? "" : "s"} from the backend workflow.`
                  : workflowJob.terminalError ?? "The plotting workflow failed.",
              color: workflowJob.status === "completed" ? "teal" : "red",
            });
            notifiedPlotWorkflowStatusRef.current = notificationKey;
          }

          return;
        }

        timeoutHandle = setTimeout(() => {
          void pollWorkflow();
        }, 1500);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "Unable to poll the plot workflow status.";

        setPlotWorkflowError(message);
        setIsGeneratingPlot(false);
        notifications.show({
          title: "Plot workflow polling failed",
          message,
          color: "red",
        });
      }
    };

    void pollWorkflow();

    return () => {
      cancelled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };
  }, [plotWorkflowJobId]);

  function handleProviderSelect(provider: ProviderInfo) {
    setSelectedProvider(provider.provider);
    setModel(provider.defaultModel);
    setReviewModel("");
  }

  async function generateFigure() {
    const prompt = plotPrompt.trim();
    const selectedModel = model.trim();
    const selectedReviewModel = reviewModel.trim();

    if (!currentProvider) {
      notifications.show({
        title: "No provider selected",
        message: "Load provider metadata before generating a figure.",
        color: "red",
      });
      return;
    }

    if (!currentProvider.enabled) {
      notifications.show({
        title: "Provider unavailable",
        message: `Set ${currentProvider.apiKeyEnv} in the backend before generating a figure with ${currentProvider.displayName}.`,
        color: "orange",
      });
      return;
    }

    if (!prompt) {
      notifications.show({
        title: "Prompt required",
        message: "Describe the figure you want before generating it.",
        color: "orange",
      });
      return;
    }

    if (!selectedModel) {
      notifications.show({
        title: "Model required",
        message: "Choose or type a model name before generating a figure.",
        color: "orange",
      });
      return;
    }

    setIsGeneratingPlot(true);
    setPlotWorkflowError(null);
    setPlotWorkflowJob(null);
    setPlotWorkflowJobId(null);
    notifiedPlotWorkflowStatusRef.current = null;
    let workflowStarted = false;

    try {
      const contextPath = plotContextPath.trim();
      const startedWorkflow = await fetchJson<StartExecPlotWorkflowResponse>(
        "/api/exec/plot/workflows",
        {
          method: "POST",
          body: JSON.stringify({
            provider: currentProvider.provider,
            model: selectedModel,
            reviewModel: selectedReviewModel || undefined,
            prompt,
            contextPath: contextPath || undefined,
            enableFileSystemTools: isPlotFileToolsEnabled,
            reasoningEffort,
          } satisfies ExecPlotWorkflowRequest),
        },
      );

      workflowStarted = true;
      setPlotWorkflowJobId(startedWorkflow.jobId);

      notifications.show({
        title: "Plot workflow started",
        message: `Started backend workflow ${startedWorkflow.jobId.slice(0, 8)}...`,
        color: "teal",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to start the plot workflow.";

      notifications.show({
        title: "Figure generation failed",
        message,
        color: "red",
      });
      setPlotWorkflowError(message);
      setIsGeneratingPlot(false);
    } finally {
      if (!workflowStarted) {
        setIsGeneratingPlot(false);
      }
    }
  }

  async function submitPrompt() {
    const prompt = draft.trim();
    const selectedModel = model.trim();

    if (!currentProvider) {
      notifications.show({
        title: "No provider selected",
        message: "Load provider metadata before sending a request.",
        color: "red",
      });
      return;
    }

    if (!currentProvider.enabled) {
      notifications.show({
        title: "Provider unavailable",
        message: `Set ${currentProvider.apiKeyEnv} in the backend before chatting with ${currentProvider.displayName}.`,
        color: "orange",
      });
      return;
    }

    if (!prompt) {
      notifications.show({
        title: "Empty message",
        message: "Write a message before sending.",
        color: "orange",
      });
      return;
    }

    if (!selectedModel) {
      notifications.show({
        title: "Model required",
        message: "Choose or type a model name before sending.",
        color: "orange",
      });
      return;
    }

    const userMessage: ChatBubble = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };

    const requestMessages: LlmChatRequest["messages"] = [
      ...(systemPrompt.trim()
        ? [{ role: "system" as const, content: systemPrompt.trim() }]
        : []),
      ...chatMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user" as const, content: prompt },
    ];

    setDraft("");
    startTransition(() => {
      setChatMessages((currentMessages) => [...currentMessages, userMessage]);
    });
    setIsSending(true);

    try {
      const response = await fetchJson<LlmChatResponse>("/api/llm/chat", {
        method: "POST",
        body: JSON.stringify({
          provider: currentProvider.provider,
          model: selectedModel,
          messages: requestMessages,
          reasoningEffort,
          tools: isFileSystemToolsEnabled ? { fileSystem: true } : undefined,
        } satisfies LlmChatRequest),
      });

      setLastResponse(response);

      const assistantMessage: ChatBubble = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.text,
        provider: response.provider,
        model: response.model,
        toolTrace: response.toolTrace,
        createdAt: new Date().toISOString(),
      };

      startTransition(() => {
        setChatMessages((currentMessages) => [
          ...currentMessages,
          assistantMessage,
        ]);
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to submit prompt to the backend.";

      notifications.show({
        title: "Chat request failed",
        message,
        color: "red",
      });
    } finally {
      setIsSending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitPrompt();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void submitPrompt();
    }
  }

  const plotWorkflowSteps = plotWorkflowJob?.steps ?? [];
  const draftArtifacts = plotWorkflowJob?.draftArtifacts ?? [];
  const finalArtifacts = plotWorkflowJob?.finalArtifacts ?? [];
  const plotWorkflowHasDetails = Boolean(
    plotWorkflowJob &&
      (
        plotWorkflowSteps.length > 0 ||
        draftArtifacts.length > 0 ||
        finalArtifacts.length > 0 ||
        plotWorkflowJob.draftCode ||
        plotWorkflowJob.finalCode ||
        plotWorkflowJob.critique ||
        plotWorkflowJob.reflection
      ),
  );

  return (
    <AppShell
      header={{ height: 88 }}
      padding="lg"
      styles={{
        main: {
          background: "transparent",
        },
      }}
    >
      <AppShell.Header
        withBorder={false}
        style={{
          backdropFilter: "blur(20px)",
          background: "rgba(246,240,231,0.74)",
          borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
        }}
      >
        <Container size="xl" h="100%">
          <Group h="100%" justify="space-between">
            <Group>
              <ThemeIcon
                size={52}
                radius="xl"
                variant="gradient"
                gradient={{ from: "teal.6", to: "cyan.6", deg: 135 }}
              >
                <IconSparkles size={24} />
              </ThemeIcon>
              <Box>
                <Text fw={800} size="xl">
                  Graph Plot LLM Console
                </Text>
                <Text c="dimmed" size="sm">
                  Choose a provider, switch models, and chat through your Nest API.
                </Text>
              </Box>
            </Group>
            <Group gap="sm">
              <Badge color="dark" size="lg" variant="light">
                {apiBaseUrl}
              </Badge>
              <ActionIcon
                aria-label="Refresh providers"
                color="dark"
                onClick={() => void loadProviders()}
                radius="xl"
                size="xl"
                variant="subtle"
              >
                <IconRefresh size={18} />
              </ActionIcon>
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="xl" py="xl">
          <Stack gap="xl">
            <Paper
              p="xl"
              radius="32px"
              shadow="xl"
              style={{
                background:
                  "linear-gradient(145deg, rgba(8,47,73,0.96), rgba(15,118,110,0.88))",
                color: "white",
              }}
            >
              <Grid align="center">
                <Grid.Col span={{ base: 12, lg: 8 }}>
                  <Stack gap="sm">
                    <Badge
                      color="cyan"
                      variant="light"
                      style={{ width: "fit-content" }}
                    >
                      Advanced UI + model switching
                    </Badge>
                    <Title order={1}>A real chat workspace for your LLM API.</Title>
                    <Text c="rgba(255,255,255,0.82)" maw={720} size="lg">
                      This page is now a frontend for `/api/llm/chat` and
                      `/api/llm/providers`, with provider discovery, model
                      selection, and conversation history.
                    </Text>
                  </Stack>
                </Grid.Col>
                <Grid.Col span={{ base: 12, lg: 4 }}>
                  <SimpleGrid cols={2} spacing="md">
                    <Paper
                      p="md"
                      radius="xl"
                      style={{ background: "rgba(255,255,255,0.12)" }}
                    >
                      <Text
                        c="rgba(255,255,255,0.72)"
                        size="xs"
                        style={{ textTransform: "uppercase" }}
                      >
                        Providers
                      </Text>
                      <Text fw={800} size="xl">
                        {providers.length || 3}
                      </Text>
                    </Paper>
                    <Paper
                      p="md"
                      radius="xl"
                      style={{ background: "rgba(255,255,255,0.12)" }}
                    >
                      <Text
                        c="rgba(255,255,255,0.72)"
                        size="xs"
                        style={{ textTransform: "uppercase" }}
                      >
                        Last usage
                      </Text>
                      <Text fw={700} size="sm">
                        {formatUsage(lastResponse)}
                      </Text>
                    </Paper>
                  </SimpleGrid>
                </Grid.Col>
              </Grid>
            </Paper>

            <Grid gutter="xl">
              <Grid.Col span={{ base: 12, lg: 4 }}>
                <Stack gap="lg">
                  <Paper
                    p="lg"
                    radius="30px"
                    shadow="md"
                    style={{ background: "rgba(255,255,255,0.86)" }}
                  >
                    <Group justify="space-between" mb="md">
                      <Box>
                        <Text fw={800}>Provider routing</Text>
                        <Text c="dimmed" size="sm">
                          Pick a provider and override its model if needed.
                        </Text>
                      </Box>
                      {providersLoading ? <Loader size="sm" /> : null}
                    </Group>

                    {providersError ? (
                      <Alert
                        color="red"
                        icon={<IconAlertCircle size={16} />}
                        mb="md"
                        radius="xl"
                      >
                        {providersError}
                      </Alert>
                    ) : null}

                    <Stack gap="sm">
                      {providers.map((provider) => (
                        <ProviderCard
                          key={provider.provider}
                          provider={provider}
                          isSelected={provider.provider === selectedProvider}
                          onSelect={() => handleProviderSelect(provider)}
                        />
                      ))}
                    </Stack>

                    <Divider my="lg" />

                    <Stack gap="sm">
                      <Autocomplete
                        data={currentProvider?.exampleModels ?? []}
                        label="Model"
                        onChange={setModel}
                        placeholder="Type or choose a model"
                        radius="xl"
                        value={model}
                      />

                      <Autocomplete
                        data={[...REASONING_EFFORT_OPTIONS]}
                        label="Reasoning effort"
                        onChange={(value) => {
                          const normalized = value.trim().toLowerCase();
                          if (
                            REASONING_EFFORT_OPTIONS.includes(
                              normalized as ReasoningEffort,
                            )
                          ) {
                            setReasoningEffort(normalized as ReasoningEffort);
                            return;
                          }

                          if (!normalized) {
                            setReasoningEffort("medium");
                          }
                        }}
                        placeholder="none, low, medium, or high"
                        radius="xl"
                        value={reasoningEffort}
                      />

                      <Textarea
                        autosize
                        label="System prompt"
                        minRows={4}
                        onChange={(event) =>
                          setSystemPrompt(event.currentTarget.value)
                        }
                        placeholder="Define the assistant behavior for this thread"
                        radius="xl"
                        value={systemPrompt}
                      />

                      <Paper
                        p="md"
                        radius="xl"
                        withBorder
                        style={{
                          background:
                            "linear-gradient(180deg, rgba(244,251,249,0.98), rgba(255,255,255,0.92))",
                          borderColor: "rgba(15, 23, 42, 0.08)",
                        }}
                      >
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                          <Group align="flex-start" wrap="nowrap">
                            <ThemeIcon color="teal" radius="xl" variant="light">
                              <IconFolderSearch size={18} />
                            </ThemeIcon>
                            <Box>
                              <Group gap={8}>
                                <Text fw={700} size="sm">
                                  Filesystem tools
                                </Text>
                                <Badge color="teal" variant="light">
                                  Opt-in
                                </Badge>
                              </Group>
                              <Text c="dimmed" size="xs" mt={4}>
                                Let the model inspect folders and read files
                                through the backend tool system.
                              </Text>
                            </Box>
                          </Group>
                          <Switch
                            checked={isFileSystemToolsEnabled}
                            color="teal"
                            onChange={(event) =>
                              setIsFileSystemToolsEnabled(
                                event.currentTarget.checked,
                              )
                            }
                            size="md"
                          />
                        </Group>
                      </Paper>

                      {currentProvider ? (
                        <Group justify="space-between" mt="xs">
                          <Button
                            component="a"
                            href={currentProvider.docsUrl}
                            leftSection={<IconArrowUpRight size={16} />}
                            radius="xl"
                            target="_blank"
                            variant="light"
                          >
                            Provider docs
                          </Button>
                          <Badge
                            color={currentProvider.enabled ? "teal" : "orange"}
                            variant="light"
                          >
                            {currentProvider.apiKeyEnv}
                          </Badge>
                        </Group>
                      ) : null}
                    </Stack>
                  </Paper>

                  <Paper
                    p="lg"
                    radius="30px"
                    shadow="md"
                    style={{ background: "rgba(255,255,255,0.86)" }}
                  >
                    <Group justify="space-between" mb="md">
                      <Box>
                        <Text fw={800}>Response telemetry</Text>
                        <Text c="dimmed" size="sm">
                          Metadata from the last completed response.
                        </Text>
                      </Box>
                      <ThemeIcon color="brand" radius="xl" variant="light">
                        <IconBrain size={18} />
                      </ThemeIcon>
                    </Group>

                    {lastResponse ? (
                      <Stack gap="sm">
                        <Group gap="xs">
                          <Badge color={providerAccent(lastResponse.provider)}>
                            {lastResponse.provider}
                          </Badge>
                          <Badge color="gray" variant="outline">
                            {lastResponse.model}
                          </Badge>
                        </Group>
                        <Text c="dimmed" size="sm">
                          Response id
                        </Text>
                        <Text
                          fw={600}
                          size="sm"
                          style={{ fontFamily: "var(--font-geist-mono)" }}
                        >
                          {lastResponse.responseId ?? "No response id"}
                        </Text>
                        <Text size="sm">
                          Finish reason: {lastResponse.finishReason ?? "n/a"}
                        </Text>
                        <Text size="sm">{formatUsage(lastResponse)}</Text>
                        {lastResponse.toolTrace &&
                        lastResponse.toolTrace.length > 0 ? (
                          <>
                            <Text size="sm">
                              Tool calls: {lastResponse.toolTrace.length}
                            </Text>
                            <Group gap={6}>
                              {lastResponse.toolTrace.map((trace, index) => (
                                <Badge
                                  key={`${trace.toolName}-${trace.callId ?? index}`}
                                  color={trace.isError ? "red" : "teal"}
                                  variant="light"
                                >
                                  {trace.toolName}
                                </Badge>
                              ))}
                            </Group>
                          </>
                        ) : null}
                      </Stack>
                    ) : (
                      <Text c="dimmed" size="sm">
                        Send a message to populate response metadata.
                      </Text>
                    )}
                  </Paper>
                </Stack>
              </Grid.Col>

              <Grid.Col span={{ base: 12, lg: 8 }}>
                <Paper
                  p="lg"
                  radius="32px"
                  shadow="xl"
                  style={{
                    background: "rgba(255,255,255,0.82)",
                    backdropFilter: "blur(18px)",
                  }}
                >
                  <Group justify="space-between" mb="md">
                    <Box>
                      <Text fw={800} size="lg">
                        Conversation
                      </Text>
                      <Text c="dimmed" size="sm">
                        Current target: {currentProvider?.displayName ?? "Loading..."}{" "}
                        with {model || "no model"}
                      </Text>
                    </Box>
                    <Group gap="sm">
                      <Badge
                        color={isFileSystemToolsEnabled ? "teal" : "gray"}
                        leftSection={<IconFolderSearch size={12} />}
                        variant={isFileSystemToolsEnabled ? "light" : "outline"}
                      >
                        {isFileSystemToolsEnabled
                          ? "Filesystem tools on"
                          : "Filesystem tools off"}
                      </Badge>
                      {currentProvider?.enabled ? (
                        <Badge color="teal" leftSection={<IconCheck size={12} />}>
                          Provider ready
                        </Badge>
                      ) : (
                        <Badge color="orange" leftSection={<IconX size={12} />}>
                          Key missing
                        </Badge>
                      )}
                      <ActionIcon
                        aria-label="Clear conversation"
                        color="red"
                        onClick={() => {
                          setChatMessages([]);
                          setLastResponse(null);
                        }}
                        radius="xl"
                        variant="light"
                      >
                        <IconTrash size={18} />
                      </ActionIcon>
                    </Group>
                  </Group>

                  {!currentProvider?.enabled && currentProvider ? (
                    <Alert
                      color="orange"
                      icon={<IconAlertCircle size={16} />}
                      mb="md"
                      radius="xl"
                    >
                      {currentProvider.apiKeyEnv} is not configured in the
                      backend. You can still change providers and models, but
                      sending is disabled until the key is set.
                    </Alert>
                  ) : null}

                  <ScrollArea h={560} offsetScrollbars scrollbarSize={8}>
                    <Stack gap="md" py="xs">
                      {chatMessages.length === 0 ? (
                        <Paper
                          p="xl"
                          radius="28px"
                          withBorder
                          style={{
                            borderStyle: "dashed",
                            background:
                              "linear-gradient(180deg, rgba(246,252,251,0.92), rgba(255,255,255,0.86))",
                          }}
                        >
                          <Stack align="center" gap="sm">
                            <ThemeIcon
                              color="brand"
                              radius="xl"
                              size={52}
                              variant="light"
                            >
                              <IconSparkles size={24} />
                            </ThemeIcon>
                            <Text fw={700}>Start the first turn</Text>
                            <Text c="dimmed" maw={480} ta="center">
                              Pick a provider card, confirm the model, and send
                              a prompt. The frontend will send the full message
                              history plus your system prompt to the backend.
                            </Text>
                          </Stack>
                        </Paper>
                      ) : null}

                      {chatMessages.map((message) => (
                        <ChatMessage key={message.id} message={message} />
                      ))}

                      {isSending ? (
                        <Group justify="flex-start">
                          <Paper
                            p="md"
                            radius="xl"
                            shadow="xs"
                            style={{ background: "rgba(255,255,255,0.92)" }}
                          >
                            <Group gap="sm">
                              <Loader size="sm" />
                              <Text size="sm" c="dimmed">
                                Waiting for {currentProvider?.displayName ?? "provider"}...
                              </Text>
                            </Group>
                          </Paper>
                        </Group>
                      ) : null}
                    </Stack>
                  </ScrollArea>

                  <Divider my="lg" />

                  <form onSubmit={handleSubmit}>
                    <Stack gap="md">
                      <Textarea
                        autosize
                        description="Press Ctrl/Cmd + Enter to send"
                        minRows={4}
                        onChange={(event) => setDraft(event.currentTarget.value)}
                        onKeyDown={handleComposerKeyDown}
                        placeholder="Ask a question, test a prompt, or compare models..."
                        radius="28px"
                        value={draft}
                      />
                      <Group justify="space-between">
                        <Text c="dimmed" size="sm">
                          Model suggestions come from `/api/llm/providers`, but
                          you can type any valid model id. Turn on filesystem
                          tools if you want the model to inspect local paths.
                        </Text>
                        <Button
                          disabled={
                            isSending ||
                            !draft.trim() ||
                            !model.trim() ||
                            !currentProvider?.enabled
                          }
                          leftSection={<IconSend2 size={16} />}
                          radius="xl"
                          type="submit"
                        >
                          Send to model
                        </Button>
                      </Group>
                    </Stack>
                  </form>
                </Paper>
              </Grid.Col>
            </Grid>

            <Paper
              p="xl"
              radius="32px"
              shadow="xl"
              style={{
                background:
                  "linear-gradient(160deg, rgba(255,255,255,0.92), rgba(240,249,255,0.78))",
                backdropFilter: "blur(18px)",
              }}
            >
              <Stack gap="xl">
                <Group justify="space-between" align="flex-start">
                  <Box>
                    <Badge color="cyan" variant="light" style={{ width: "fit-content" }}>
                      Figure Lab
                    </Badge>
                    <Title mt="sm" order={2}>
                      Run a draft, critique it, diagnose layout issues, and iterate to the final figure.
                    </Title>
                    <Text c="dimmed" maw={760} mt="xs">
                      The backend now owns the full plot workflow: draft codegen,
                      draft render, repeated LLM repair on failed execution,
                      critique/revision, final render, matplotlib layout diagnostics,
                      and recursive review-driven rerenders. The UI starts a job,
                      polls it, and renders the full attempt timeline.
                    </Text>
                  </Box>
                  <Group gap="xs">
                    <Badge color="dark" variant="light">
                      {currentProvider?.displayName ?? "No provider"}
                    </Badge>
                    <Badge color="gray" variant="outline">
                      {model || "no model"}
                    </Badge>
                    <Badge color="dark" variant="outline">
                      review {reviewModel.trim() || model || "same model"}
                    </Badge>
                    <Badge color="grape" variant="light">
                      reasoning {reasoningEffort}
                    </Badge>
                    <Badge
                      color={isPlotFileToolsEnabled ? "teal" : "gray"}
                      leftSection={<IconFolderSearch size={12} />}
                      variant={isPlotFileToolsEnabled ? "light" : "outline"}
                    >
                      {isPlotFileToolsEnabled ? "LLM file tools on" : "LLM file tools off"}
                    </Badge>
                    <Badge
                      color={
                        plotCapabilities?.sandbox.available
                          ? plotCapabilities.sandbox.bootstrapped
                            ? "teal"
                            : "orange"
                          : "red"
                      }
                      variant="light"
                    >
                      {plotCapabilities?.sandbox.available
                        ? plotCapabilities.sandbox.bootstrapped
                          ? "Sandbox ready"
                          : "Bootstrap on first run"
                        : "Python missing"}
                    </Badge>
                    {plotWorkflowJob ? (
                      <Badge
                        color={workflowStatusColor(plotWorkflowJob.status)}
                        variant="light"
                      >
                        {plotWorkflowJob.status}
                      </Badge>
                    ) : null}
                  </Group>
                </Group>

                <Grid gutter="xl">
                  <Grid.Col span={{ base: 12, lg: 5 }}>
                    <Stack gap="md">
                      {plotCapabilitiesError ? (
                        <Alert
                          color="red"
                          icon={<IconAlertCircle size={16} />}
                          radius="xl"
                        >
                          {plotCapabilitiesError}
                        </Alert>
                      ) : null}

                      <Textarea
                        autosize
                        label="Figure request"
                        minRows={6}
                        onChange={(event) => setPlotPrompt(event.currentTarget.value)}
                        placeholder="Example: Plot a smooth sine and cosine curve with labeled axes, legend, and a clean presentation style."
                        radius="xl"
                        value={plotPrompt}
                      />

                      <TextInput
                        label="Local data path"
                        onChange={(event) =>
                          setPlotContextPath(event.currentTarget.value)
                        }
                        placeholder="Optional: C:\\data\\sales.csv or /Users/me/project/data"
                        radius="xl"
                        value={plotContextPath}
                      />

                      <Autocomplete
                        data={currentProvider?.exampleModels ?? []}
                        description="Optional: leave blank to reuse the primary model for critique, repair, and final review."
                        label="Review model"
                        onChange={setReviewModel}
                        placeholder="Optional stronger reviewer model"
                        radius="xl"
                        value={reviewModel}
                      />

                      <Paper
                        p="md"
                        radius="xl"
                        withBorder
                        style={{
                          background:
                            "linear-gradient(180deg, rgba(244,251,249,0.98), rgba(255,255,255,0.92))",
                          borderColor: "rgba(15, 23, 42, 0.08)",
                        }}
                      >
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                          <Group align="flex-start" wrap="nowrap">
                            <ThemeIcon color="teal" radius="xl" variant="light">
                              <IconFolderSearch size={18} />
                            </ThemeIcon>
                            <Box>
                              <Group gap={8}>
                                <Text fw={700} size="sm">
                                  LLM filesystem inspection
                                </Text>
                                <Badge color="teal" variant="light">
                                  Recommended
                                </Badge>
                              </Group>
                              <Text c="dimmed" size="xs" mt={4}>
                                Let the model inspect directories and read files
                                before it writes plotting code.
                              </Text>
                            </Box>
                          </Group>
                          <Switch
                            checked={isPlotFileToolsEnabled}
                            color="teal"
                            onChange={(event) =>
                              setIsPlotFileToolsEnabled(
                                event.currentTarget.checked,
                              )
                            }
                            size="md"
                          />
                        </Group>
                      </Paper>

                      <Paper
                        p="md"
                        radius="xl"
                        withBorder
                        style={{
                          background:
                            "linear-gradient(180deg, rgba(248,250,252,0.96), rgba(255,255,255,0.94))",
                        }}
                      >
                        <Stack gap="xs">
                          <Text fw={700} size="sm">
                            Plot sandbox
                          </Text>
                          <Text c="dimmed" size="xs">
                            Python packages:{" "}
                            {plotCapabilities?.sandbox.requiredPackages.join(", ") ??
                              "matplotlib, numpy, pandas, seaborn"}
                          </Text>
                          <Text c="dimmed" size="xs">
                            Runtime command:{" "}
                            {plotCapabilities?.sandbox.command ?? "Not detected yet"}
                          </Text>
                          <Text c="dimmed" size="xs">
                            Package directory:{" "}
                            {plotCapabilities?.sandbox.packageDirectory ??
                              "Loading sandbox status..."}
                          </Text>
                        </Stack>
                      </Paper>

                      {plotWorkflowJob ? (
                        <Paper
                          p="md"
                          radius="xl"
                          withBorder
                          style={{
                            background:
                              "linear-gradient(180deg, rgba(248,250,252,0.96), rgba(255,255,255,0.94))",
                          }}
                        >
                          <Stack gap="xs">
                            <Text fw={700} size="sm">
                              Workflow status
                            </Text>
                            <Group gap="xs">
                              <Badge
                                color={workflowStatusColor(plotWorkflowJob.status)}
                                variant="light"
                              >
                                {plotWorkflowJob.status}
                              </Badge>
                              <Code>{plotWorkflowJob.jobId}</Code>
                            </Group>
                            <Text c="dimmed" size="xs">
                              Current stage: {plotWorkflowJob.currentStage}
                            </Text>
                          </Stack>
                        </Paper>
                      ) : null}

                      {plotWorkflowError || plotWorkflowJob?.terminalError ? (
                        <Alert
                          color="red"
                          icon={<IconAlertCircle size={16} />}
                          radius="xl"
                        >
                          {plotWorkflowError ??
                            plotWorkflowJob?.terminalError ??
                            "The plotting workflow failed."}
                        </Alert>
                      ) : null}

                      <Group justify="space-between">
                        <Text c="dimmed" size="sm">
                          Filesystem tools are passed into the backend workflow.
                          Failed execution stages trigger repeated LLM reflection
                          with the current code, sandbox feedback, and layout
                          diagnostics before the workflow moves on or stops.
                        </Text>
                        <Button
                          disabled={
                            isGeneratingPlot ||
                            !plotPrompt.trim() ||
                            !model.trim() ||
                            !currentProvider?.enabled
                          }
                          leftSection={<IconSparkles size={16} />}
                          onClick={() => void generateFigure()}
                          radius="xl"
                        >
                          {isGeneratingPlot ? "Generating..." : "Generate figure"}
                        </Button>
                      </Group>
                    </Stack>
                  </Grid.Col>

                  <Grid.Col span={{ base: 12, lg: 7 }}>
                    {finalArtifacts.length || draftArtifacts.length ? (
                      <Stack gap="md">
                        {finalArtifacts.length ? (
                          <Stack gap="md">
                            <Group justify="space-between">
                              <Text fw={800} size="lg">
                                Final figure
                              </Text>
                              <Badge color="teal" variant="light">
                                Final render
                              </Badge>
                            </Group>
                            {finalArtifacts.map((artifact) => {
                              const artifactUrl = `data:${artifact.mimeType};base64,${artifact.base64}`;

                              return (
                                <Paper
                                  key={`final-${artifact.filename}`}
                                  p="md"
                                  radius="28px"
                                  shadow="md"
                                  withBorder
                                  style={{ background: "rgba(255,255,255,0.9)" }}
                                >
                                  <Stack gap="md">
                                    <Box
                                      component="img"
                                      alt={artifact.filename}
                                      src={artifactUrl}
                                      style={{
                                        width: "100%",
                                        display: "block",
                                        borderRadius: "20px",
                                        border: "1px solid rgba(15, 23, 42, 0.08)",
                                        background: "white",
                                      }}
                                    />
                                    <Group justify="space-between">
                                      <Box>
                                        <Text fw={700} size="sm">
                                          {artifact.filename}
                                        </Text>
                                        <Text c="dimmed" size="xs">
                                          {artifact.mimeType} · {formatBytes(artifact.byteSize)}
                                        </Text>
                                      </Box>
                                      <Button
                                        component="a"
                                        download={artifact.filename}
                                        href={artifactUrl}
                                        leftSection={<IconArrowUpRight size={16} />}
                                        radius="xl"
                                        variant="light"
                                      >
                                        Download
                                      </Button>
                                    </Group>
                                  </Stack>
                                </Paper>
                              );
                            })}
                          </Stack>
                        ) : null}

                        {draftArtifacts.length ? (
                          <Stack gap="md">
                            <Group justify="space-between">
                              <Text fw={800} size="lg">
                                Draft figure
                              </Text>
                              <Badge color="cyan" variant="light">
                                Draft low-res render
                              </Badge>
                            </Group>
                            {draftArtifacts.map((artifact) => {
                              const artifactUrl = `data:${artifact.mimeType};base64,${artifact.base64}`;

                              return (
                                <Paper
                                  key={`draft-${artifact.filename}`}
                                  p="md"
                                  radius="28px"
                                  shadow="sm"
                                  withBorder
                                  style={{ background: "rgba(255,255,255,0.78)" }}
                                >
                                  <Stack gap="md">
                                    <Box
                                      component="img"
                                      alt={artifact.filename}
                                      src={artifactUrl}
                                      style={{
                                        width: "100%",
                                        display: "block",
                                        borderRadius: "20px",
                                        border: "1px solid rgba(15, 23, 42, 0.08)",
                                        background: "white",
                                      }}
                                    />
                                    <Group justify="space-between">
                                      <Box>
                                        <Text fw={700} size="sm">
                                          {artifact.filename}
                                        </Text>
                                        <Text c="dimmed" size="xs">
                                          {artifact.mimeType} · {formatBytes(artifact.byteSize)}
                                        </Text>
                                      </Box>
                                      <Button
                                        component="a"
                                        download={artifact.filename}
                                        href={artifactUrl}
                                        leftSection={<IconArrowUpRight size={16} />}
                                        radius="xl"
                                        variant="subtle"
                                      >
                                        Download draft
                                      </Button>
                                    </Group>
                                  </Stack>
                                </Paper>
                              );
                            })}
                          </Stack>
                        ) : null}
                      </Stack>
                    ) : plotWorkflowJob && isPlotWorkflowRunning(plotWorkflowJob.status) ? (
                      <Paper
                        p="xl"
                        radius="28px"
                        withBorder
                        style={{
                          minHeight: 360,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background:
                            "linear-gradient(180deg, rgba(245,252,255,0.92), rgba(255,255,255,0.88))",
                        }}
                      >
                        <Stack align="center" gap="sm">
                          <Loader size="lg" />
                          <Text fw={700}>Workflow running</Text>
                          <Text c="dimmed" maw={420} ta="center">
                            {plotWorkflowJob.currentStage}
                          </Text>
                        </Stack>
                      </Paper>
                    ) : (
                      <Paper
                        p="xl"
                        radius="28px"
                        withBorder
                        style={{
                          minHeight: 360,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background:
                            "linear-gradient(180deg, rgba(245,252,255,0.92), rgba(255,255,255,0.88))",
                          borderStyle: "dashed",
                        }}
                      >
                        <Stack align="center" gap="sm">
                          <ThemeIcon
                            color="brand"
                            radius="xl"
                            size={52}
                            variant="light"
                          >
                            <IconBrain size={24} />
                          </ThemeIcon>
                          <Text fw={700}>No figure yet</Text>
                          <Text c="dimmed" maw={420} ta="center">
                            Describe the chart you want, then let the selected
                            model generate a draft, critique it, and render the
                            final output here.
                          </Text>
                        </Stack>
                      </Paper>
                    )}
                  </Grid.Col>
                </Grid>

                {plotWorkflowHasDetails ? (
                  <Accordion chevronPosition="right" multiple radius="xl" variant="separated">
                    <Accordion.Item value="draft-code">
                      <Accordion.Control>
                        <Text fw={700}>Draft Python code</Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Box
                          component="pre"
                          p="md"
                          style={{
                            margin: 0,
                            maxHeight: 360,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            borderRadius: "20px",
                            background: "rgba(248,250,252,0.96)",
                            border: "1px solid rgba(15, 23, 42, 0.08)",
                            fontFamily: "var(--font-geist-mono)",
                            fontSize: "13px",
                          }}
                        >
                          {plotWorkflowJob?.draftCode || "No draft code generated yet."}
                        </Box>
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="critique-reflection">
                      <Accordion.Control>
                        <Text fw={700}>Critique and reflection</Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        {plotWorkflowJob?.critique || plotWorkflowJob?.reflection ? (
                          <Stack gap="md">
                            <Box>
                              <Text c="dimmed" size="xs" mb={6}>
                                Critique
                              </Text>
                              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                                {plotWorkflowJob?.critique || "No critique text returned."}
                              </Text>
                            </Box>
                            <Box>
                              <Text c="dimmed" size="xs" mb={6}>
                                Reflection
                              </Text>
                              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                                {plotWorkflowJob?.reflection ||
                                  "No reflection text returned."}
                              </Text>
                            </Box>
                          </Stack>
                        ) : (
                          <Text c="dimmed" size="sm">
                            The critique pass has not produced reflection notes yet.
                          </Text>
                        )}
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="final-code">
                      <Accordion.Control>
                        <Text fw={700}>Final revised Python code</Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Box
                          component="pre"
                          p="md"
                          style={{
                            margin: 0,
                            maxHeight: 360,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            borderRadius: "20px",
                            background: "rgba(248,250,252,0.96)",
                            border: "1px solid rgba(15, 23, 42, 0.08)",
                            fontFamily: "var(--font-geist-mono)",
                            fontSize: "13px",
                          }}
                        >
                          {plotWorkflowJob?.finalCode || "No revised code generated yet."}
                        </Box>
                      </Accordion.Panel>
                    </Accordion.Item>

                    <Accordion.Item value="workflow-timeline">
                      <Accordion.Control>
                        <Text fw={700}>Workflow timeline</Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        {plotWorkflowSteps.length > 0 ? (
                          <Accordion chevronPosition="right" multiple radius="xl" variant="separated">
                            {plotWorkflowSteps.map((step) => (
                              <Accordion.Item key={step.id} value={step.id}>
                                <Accordion.Control>
                                  <Group justify="space-between" wrap="nowrap">
                                    <Group gap="xs" wrap="nowrap">
                                      <Badge color="dark" variant="light">
                                        {step.kind.toUpperCase()}
                                      </Badge>
                                      <Text fw={700} size="sm">
                                        {step.label}
                                      </Text>
                                    </Group>
                                    <Group gap="xs" wrap="nowrap">
                                      <Badge color="gray" variant="outline">
                                        attempt {step.attempt}
                                      </Badge>
                                      <Badge
                                        color={
                                          step.status === "completed"
                                            ? "teal"
                                            : step.status === "running"
                                              ? "blue"
                                              : "red"
                                        }
                                        variant="light"
                                      >
                                        {step.status}
                                      </Badge>
                                    </Group>
                                  </Group>
                                </Accordion.Control>
                                <Accordion.Panel>
                                  <WorkflowStepDetails step={step} />
                                </Accordion.Panel>
                              </Accordion.Item>
                            ))}
                          </Accordion>
                        ) : (
                          <Text c="dimmed" size="sm">
                            Start the workflow to inspect its step-by-step timeline.
                          </Text>
                        )}
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                ) : null}
              </Stack>
            </Paper>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
