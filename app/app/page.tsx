"use client";

import {
  ActionIcon,
  Alert,
  AppShell,
  Autocomplete,
  Avatar,
  Badge,
  Box,
  Button,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
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
  useState,
} from "react";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type ProviderId = "openai" | "gemini" | "anthropic";

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

type LlmChatRequest = {
  provider: string;
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  maxTokens?: number;
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
};

type ChatBubble = {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider?: ProviderId;
  model?: string;
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
      </Paper>

      {!isAssistant ? (
        <ThemeIcon size={42} radius="xl" variant="filled" color="dark">
          <IconCircleDot size={18} />
        </ThemeIcon>
      ) : null}
    </Group>
  );
}

export default function Home() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-5.4");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a precise assistant helping with graph-plot related questions.",
  );
  const [draft, setDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatBubble[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [lastResponse, setLastResponse] = useState<LlmChatResponse | null>(null);

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

  useEffect(() => {
    void loadProviders();
    // This is a one-time bootstrap fetch; user-triggered refreshes use the same function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleProviderSelect(provider: ProviderInfo) {
    setSelectedProvider(provider.provider);
    setModel(provider.defaultModel);
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
        } satisfies LlmChatRequest),
      });

      setLastResponse(response);

      const assistantMessage: ChatBubble = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response.text,
        provider: response.provider,
        model: response.model,
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
                          you can type any valid model id.
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
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
