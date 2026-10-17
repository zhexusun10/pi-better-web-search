import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  baseUrlFor,
  buildRequestHeaders,
  getHeader,
  resolveAuth,
  type ResolvedAuth,
} from "../auth.ts";
import {
  errorMessage,
  isAbortError,
  readJson,
  responseError,
} from "./http.ts";
import type {
  ProviderAdapter,
  ProviderFetchEntry,
  ProviderFetchResult,
  ProviderSearchResult,
} from "./types.ts";

export const OLLAMA_SEARCH_MAX_RESULTS = 10;

// Compatibility aliases for embedders and tests that used earlier names.
export const OLLAMA_MAX_RESULTS = OLLAMA_SEARCH_MAX_RESULTS;
export const OLLAMA_WEB_SEARCH_MAX_RESULTS = OLLAMA_SEARCH_MAX_RESULTS;
export const MAX_RESULTS = OLLAMA_SEARCH_MAX_RESULTS;

/** Strip a trailing OpenAI-compatible `/vN` suffix so `/api/*` resolves. */
export function resolveOllamaApiRoot(
  model: Model<Api> | string,
  auth?: ResolvedAuth,
): string {
  const raw = typeof model === "string" ? model : baseUrlFor(model, auth);
  const base = (raw || "").trim().replace(/\/+$/, "");
  return base.replace(/\/v\d+$/i, "");
}

function abortError(): Error {
  const error = new Error("Request was aborted");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function rethrowAbort(error: unknown, signal: AbortSignal | undefined): void {
  if (!isAbortError(error, signal)) return;
  if (isAbortError(error)) throw error;
  if (signal?.aborted) throw abortError();
  throw error;
}

interface OllamaTarget {
  headers: Record<string, string>;
  root: string;
}

async function resolveOllamaTarget(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<OllamaTarget> {
  const auth = await resolveAuth(ctx, model);
  if (!auth.ok) {
    throw new Error(auth.error || "Failed to resolve Ollama credentials");
  }

  // Older pi-ai releases do not map OLLAMA_API_KEY for the ollama-cloud
  // provider, so mirror the reference adapter's environment fallback here.
  const envKey = process.env.OLLAMA_API_KEY;
  const effectiveAuth: ResolvedAuth =
    !auth.apiKey && envKey && !getHeader(auth.headers, "Authorization")
      ? { ...auth, apiKey: envKey }
      : auth;

  const headers = buildRequestHeaders({
    model,
    ctx,
    auth: effectiveAuth,
    base: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    bearer: true,
  });

  if (!getHeader(headers, "Authorization")?.trim()) {
    throw new Error(
      "Ollama web search needs an API key - set OLLAMA_API_KEY or run /login ollama-cloud.",
    );
  }

  return {
    headers,
    root: resolveOllamaApiRoot(model, effectiveAuth),
  };
}

export const ollamaAdapter: ProviderAdapter = {
  family: "ollama",
  label: "Ollama",
  supportsSearch: true,
  supportsUrls: true,

  async search(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    signal: AbortSignal | undefined,
    _onUpdate?: AgentToolUpdateCallback,
  ): Promise<ProviderSearchResult> {
    checkAbort(signal);

    const target = await resolveOllamaTarget(ctx, model);
    checkAbort(signal);

    const response = await fetch(`${target.root}/api/web_search`, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        query,
        max_results: OLLAMA_SEARCH_MAX_RESULTS,
      }),
      signal,
    });
    checkAbort(signal);

    if (!response.ok) {
      throw await responseError(response, "Ollama");
    }

    const data = await readJson<{ results?: unknown }>(response);
    checkAbort(signal);
    return { results: data?.results ?? [] };
  },

  async fetch(
    ctx: ExtensionContext,
    model: Model<Api>,
    urls: string[],
    _query: string | undefined,
    signal: AbortSignal | undefined,
    _onUpdate?: AgentToolUpdateCallback,
  ): Promise<ProviderFetchResult> {
    checkAbort(signal);

    const target = await resolveOllamaTarget(ctx, model);
    const entries: ProviderFetchEntry[] = [];

    for (const url of urls) {
      checkAbort(signal);

      let response: Response;
      try {
        response = await fetch(`${target.root}/api/web_fetch`, {
          method: "POST",
          headers: target.headers,
          body: JSON.stringify({ url }),
          signal,
        });
      } catch (error) {
        rethrowAbort(error, signal);
        entries.push({ url, error: errorMessage(error) });
        continue;
      }
      checkAbort(signal);

      if (!response.ok) {
        const httpError = await responseError(response, "Ollama");
        checkAbort(signal);
        if (response.status === 403 || response.status === 404) {
          entries.push({ url, error: httpError.message });
          continue;
        }
        throw httpError;
      }

      try {
        const data = await readJson(response);
        checkAbort(signal);
        entries.push({ url, data });
      } catch (error) {
        rethrowAbort(error, signal);
        entries.push({ url, error: errorMessage(error) });
      }
    }

    return { entries };
  },
};
