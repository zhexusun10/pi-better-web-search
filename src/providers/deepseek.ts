import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  baseUrlFor,
  buildRequestHeaders,
  getHeader,
  resolveAuth,
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

export const DEEPSEEK_SEARCH_COUNT = 10;
export const DEEPSEEK_NEED_CONTENT = true;
export const DEEPSEEK_MAX_URL_LENGTH = 8192;
export const DEEPSEEK_MAX_QUERY_LENGTH = 128;
const DEEPSEEK_TOOL_PATHS = {
  search: "/v1/tools/search",
  fetch: "/v1/tools/fetch",
} as const;

export type DeepSeekTool = keyof typeof DEEPSEEK_TOOL_PATHS;

/**
 * Build the native Search/Fetch endpoint from a model or proxy base URL.
 * Only the suffixes that belong to the model API are removed; any proxy origin
 * or path prefix is preserved.
 */
export function resolveDeepSeekToolUrl(baseUrl: string, tool: DeepSeekTool): string {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  base = base.replace(/\/(?:anthropic\/v1|anthropic|v1)$/i, "");
  return `${base}${DEEPSEEK_TOOL_PATHS[tool]}`;
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

function validateQuery(query: string): string | undefined {
  const length = typeof query === "string" ? Array.from(query).length : 0;
  if (typeof query !== "string" || query.trim().length === 0) {
    return `Invalid query: a non-whitespace query of 1-${DEEPSEEK_MAX_QUERY_LENGTH} Unicode characters is required`;
  }
  if (length < 1 || length > DEEPSEEK_MAX_QUERY_LENGTH) {
    return `Invalid query: length must be 1-${DEEPSEEK_MAX_QUERY_LENGTH} Unicode characters`;
  }
  return undefined;
}

function validateFetchUrl(url: string): string | undefined {
  if (typeof url !== "string" || !url) return "Invalid URL: a non-empty string is required";
  if (url.length > DEEPSEEK_MAX_URL_LENGTH) {
    return `Invalid URL: length must not exceed ${DEEPSEEK_MAX_URL_LENGTH} characters`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    return `Invalid URL: ${errorMessage(error)}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Invalid URL: only http and https are supported";
  }
  if (!parsed.hostname) return "Invalid URL: a host is required";
  if (parsed.username || parsed.password) {
    return "Invalid URL: username and password are not allowed";
  }
  return undefined;
}

interface DeepSeekTarget {
  headers: Record<string, string>;
  searchUrl: string;
  fetchUrl: string;
}

async function resolveDeepSeekTarget(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<DeepSeekTarget> {
  const auth = await resolveAuth(ctx, model);
  if (!auth.ok) {
    throw new Error(auth.error || "Failed to resolve DeepSeek credentials");
  }

  const headers = buildRequestHeaders({
    model,
    ctx,
    auth,
    base: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    bearer: true,
  });

  if (!getHeader(headers, "Authorization")?.trim()) {
    throw new Error(
      "No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.",
    );
  }

  const baseUrl = baseUrlFor(model, auth);
  return {
    headers,
    searchUrl: resolveDeepSeekToolUrl(baseUrl, "search"),
    fetchUrl: resolveDeepSeekToolUrl(baseUrl, "fetch"),
  };
}

export const deepseekAdapter: ProviderAdapter = {
  family: "deepseek",
  label: "DeepSeek",
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

    const queryError = validateQuery(query);
    if (queryError) throw new Error(queryError);

    const target = await resolveDeepSeekTarget(ctx, model);
    checkAbort(signal);

    const response = await fetch(target.searchUrl, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({
        query,
        count: DEEPSEEK_SEARCH_COUNT,
        need_content: DEEPSEEK_NEED_CONTENT,
      }),
      signal,
    });
    checkAbort(signal);

    if (!response.ok) {
      throw await responseError(response, "DeepSeek");
    }

    const data = await readJson<{ results?: unknown } | null>(response);
    checkAbort(signal);
    return { results: data?.results };
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

    const target = await resolveDeepSeekTarget(ctx, model);
    const entries: ProviderFetchEntry[] = [];

    for (const url of urls) {
      checkAbort(signal);

      const validationError = validateFetchUrl(url);
      if (validationError) {
        entries.push({ url, error: validationError });
        continue;
      }

      let response: Response;
      try {
        response = await fetch(target.fetchUrl, {
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
        const httpError = await responseError(response, "DeepSeek");
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
