# Graph Plot

This repo now keeps the Next frontend and Nest backend separate.

## Local development

- Frontend: `cd app && npm run dev` on `http://localhost:3000`
- Backend: `cd backend && npm run start:dev` on `http://localhost:3001`

## Frontend to backend wiring

- The browser app calls the Nest API directly with `NEXT_PUBLIC_API_BASE_URL`
- Default API base URL: `http://localhost:3001`
- Test endpoints:
  - `GET /api/health`
  - `POST /api/test/echo`

## Backend config

- CORS allows `http://localhost:3000` by default
- Override frontend origin with `FRONTEND_ORIGIN`
- Override backend port with `PORT`

## LLM API

Set provider API keys in `backend/.env` or your shell:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`

Available backend endpoints:

- `GET /api/llm/providers`
- `GET /api/llm/providers/:provider`
- `POST /api/llm/chat`

Example request:

```json
{
  "provider": "gpt",
  "model": "gpt-5.4",
  "messages": [
    { "role": "system", "content": "You are a concise coding assistant." },
    { "role": "user", "content": "Explain breadth-first search in one paragraph." }
  ],
  "maxTokens": 300,
  "tools": {
    "fileSystem": true
  }
}
```

Provider aliases:

- `gpt` -> `openai`
- `claude` -> `anthropic`

The API accepts any model string, so you can swap models without code changes. Current example model IDs in the metadata endpoint are based on the providers' official docs.

When `tools.fileSystem` is `true`, the backend exposes local filesystem tools to the LLM during the chat request. The current tool set lets the model inspect a file/folder path and read a chosen text file.

## Exec API

Available backend endpoints:

- `GET /api/exec/capabilities`
- `POST /api/exec/run`

Supported runtimes:

- `python`
- `bash`
- `powershell`
- `shell`

`shell` uses the backend OS default shell:

- Windows: PowerShell
- macOS/Linux: Bash

Example request:

```json
{
  "runtime": "python",
  "code": "print('hello from python')",
  "timeoutMs": 10000,
  "args": []
}
```

The execution response includes the selected runtime, resolved command, stdout, stderr, structured logs, exit status, and collected errors.
