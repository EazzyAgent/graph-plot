"use client";

import { FormEvent, useEffect, useState } from "react";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type ApiHealthResponse = {
  service: string;
  status: "ok";
  timestamp: string;
};

type ApiEchoResponse = {
  length: number;
  received: string;
  timestamp: string;
  uppercase: string;
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function JsonPanel({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  return (
    <div className="rounded-3xl border border-black/10 bg-black px-4 py-4 text-sm text-lime-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.24em] text-lime-400/80">
        {title}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function Home() {
  const [health, setHealth] = useState<ApiHealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [message, setMessage] = useState("Graph plot handshake");
  const [echoResponse, setEchoResponse] = useState<ApiEchoResponse | null>(null);
  const [echoError, setEchoError] = useState<string | null>(null);
  const [echoLoading, setEchoLoading] = useState(false);

  async function loadHealth() {
    setHealthLoading(true);
    setHealthError(null);

    try {
      const nextHealth = await fetchJson<ApiHealthResponse>("/api/health", {
        cache: "no-store",
      });
      setHealth(nextHealth);
    } catch (error) {
      setHealth(null);
      setHealthError(
        error instanceof Error ? error.message : "Unable to reach backend.",
      );
    } finally {
      setHealthLoading(false);
    }
  }

  useEffect(() => {
    void loadHealth();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEchoLoading(true);
    setEchoError(null);

    try {
      const response = await fetchJson<ApiEchoResponse>("/api/test/echo", {
        body: JSON.stringify({ message }),
        method: "POST",
      });
      setEchoResponse(response);
    } catch (error) {
      setEchoResponse(null);
      setEchoError(
        error instanceof Error ? error.message : "Unable to submit payload.",
      );
    } finally {
      setEchoLoading(false);
    }
  }

  return (
    <div className="min-h-screen px-6 py-10 text-stone-950 sm:px-10">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <section className="overflow-hidden rounded-[2rem] border border-black/10 bg-[linear-gradient(135deg,rgba(8,47,73,0.95),rgba(22,101,52,0.9))] p-8 text-stone-50 shadow-[0_24px_80px_rgba(15,23,42,0.18)] sm:p-10">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-cyan-200/85">
                Graph Plot Frontend
              </p>
              <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
                Frontend and backend are now split cleanly.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-cyan-50/85 sm:text-lg">
                This page runs entirely in the browser and talks directly to the
                Nest API. No route handlers, server actions, or proxy logic are
                left inside the Next app.
              </p>
            </div>
            <div className="rounded-3xl border border-white/15 bg-white/10 px-5 py-4 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-100/75">
                API Base URL
              </p>
              <p className="mt-2 font-mono text-sm text-white">{apiBaseUrl}</p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[2rem] border border-black/10 bg-white/80 p-6 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="flex flex-col gap-4 border-b border-black/10 pb-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-700">
                  GET /api/health
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-stone-950">
                  Backend status check
                </h2>
              </div>
              <button
                className="rounded-full bg-stone-950 px-5 py-3 text-sm font-semibold text-stone-50 transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-500"
                onClick={() => void loadHealth()}
                disabled={healthLoading}
                type="button"
              >
                {healthLoading ? "Checking..." : "Refresh status"}
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <div className="rounded-3xl bg-stone-100/80 p-5">
                <p className="text-sm font-medium text-stone-600">
                  Frontend origin
                </p>
                <p className="mt-1 font-mono text-sm text-stone-950">
                  http://localhost:3000
                </p>
              </div>

              {healthError ? (
                <div className="rounded-3xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">
                  {healthError}
                </div>
              ) : null}

              {health ? (
                <JsonPanel title="Health response" value={health} />
              ) : (
                <div className="rounded-3xl border border-dashed border-black/15 bg-stone-50 px-5 py-8 text-sm text-stone-500">
                  {healthLoading
                    ? "Waiting for backend response..."
                    : "No health payload loaded yet."}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[2rem] border border-black/10 bg-[#fff9ef] p-6 shadow-[0_20px_70px_rgba(15,23,42,0.08)]">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-amber-700">
              POST /api/test/echo
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-stone-950">
              Payload round-trip
            </h2>
            <p className="mt-3 text-sm leading-7 text-stone-600">
              Submit text from the browser and verify the backend receives it,
              trims it, and returns transformed data.
            </p>

            <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
              <label className="block">
                <span className="text-sm font-medium text-stone-700">
                  Test message
                </span>
                <textarea
                  className="mt-2 min-h-32 w-full rounded-3xl border border-black/10 bg-white px-4 py-4 text-base text-stone-950 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Type a message for the Nest backend..."
                  value={message}
                />
              </label>

              <button
                className="w-full rounded-full bg-emerald-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-emerald-400"
                disabled={echoLoading}
                type="submit"
              >
                {echoLoading ? "Sending..." : "Send test payload"}
              </button>
            </form>

            <div className="mt-6 space-y-4">
              {echoError ? (
                <div className="rounded-3xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">
                  {echoError}
                </div>
              ) : null}

              {echoResponse ? (
                <JsonPanel title="Echo response" value={echoResponse} />
              ) : (
                <div className="rounded-3xl border border-dashed border-black/15 bg-white/70 px-5 py-8 text-sm text-stone-500">
                  Submit the form to confirm the browser can post JSON to the
                  backend.
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
