import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

export type ResolvedAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; baseUrl?: string }
  | { ok: false; error: string };

type HeaderValue = string | null | undefined;
type HeaderSource = Record<string, HeaderValue> | undefined;

const AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key", "x-goog-api-key"]);
const OPENCODE_HOST = "opencode.ai";

function normalizeHeaders(headers: Record<string, HeaderValue> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Resolve credentials for a model. pi's registry is authoritative, but older
 * registry versions can return `{ ok: true }` for env-only credentials. Since
 * this package calls fetch() directly, mirror pi-ai's env fallback here. Any
 * explicit headers returned by the registry are preserved.
 */
export async function resolveAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
  let resolved: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  try {
    resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  if (!resolved.ok) {
    return { ok: false, error: resolved.error || "Failed to resolve credentials" };
  }

  const headers = normalizeHeaders(resolved.headers as Record<string, HeaderValue> | undefined);
  let apiKey = resolved.apiKey;
  if (!apiKey && !hasAuthHeader(headers)) {
    try {
      apiKey = getEnvApiKey(model.provider);
    } catch {
      // Keep the registry result if the environment lookup fails.
    }
  }

  return {
    ok: true,
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(typeof resolved.baseUrl === "string" ? { baseUrl: resolved.baseUrl } : {}),
  };
}

export function hasAuthHeader(headers: Record<string, HeaderValue> | undefined): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(
    ([name, value]) => typeof value === "string" && value.length > 0 && AUTH_HEADER_NAMES.has(name.toLowerCase()),
  );
}

export function hasHeader(headers: Record<string, HeaderValue> | undefined, name: string): boolean {
  if (!headers) return false;
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

export function getHeader(headers: Record<string, HeaderValue> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized && typeof value === "string") return value;
  }
  return undefined;
}

export function setHeaderIfAbsent(
  headers: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined || hasHeader(headers, name)) return;
  headers[name] = value;
}

/**
 * Merge header sources case-insensitively. Later sources override earlier
 * ones; a null value deletes an existing header, matching ProviderHeaders.
 */
export function mergeHeaders(...sources: HeaderSource[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const normalized = name.toLowerCase();
      if (value === null) {
        for (const existing of Object.keys(merged)) {
          if (existing.toLowerCase() === normalized) delete merged[existing];
        }
        continue;
      }
      if (typeof value !== "string") continue;
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === normalized) delete merged[existing];
      }
      merged[name] = value;
    }
  }
  return merged;
}

export interface BuildRequestHeadersOptions {
  model: Model<Api>;
  ctx: ExtensionContext;
  auth?: ResolvedAuth;
  base?: Record<string, HeaderValue>;
  bearer?: boolean;
  apiKeyHeader?: string;
}

export function buildRequestHeaders({
  model,
  ctx,
  auth,
  base,
  bearer,
  apiKeyHeader,
}: BuildRequestHeadersOptions): Record<string, string> {
  const success = auth?.ok ? auth : undefined;
  const headers = mergeHeaders(
    base,
    getProviderSessionHeaders(model, ctx),
    model.headers,
    success?.headers,
  );

  if (success?.apiKey) {
    if (bearer) setHeaderIfAbsent(headers, "Authorization", `Bearer ${success.apiKey}`);
    if (apiKeyHeader) setHeaderIfAbsent(headers, apiKeyHeader, success.apiKey);
  }

  return headers;
}

export function baseUrlFor(model: Model<Api>, auth: ResolvedAuth | undefined): string {
  return auth?.ok && auth.baseUrl ? auth.baseUrl : model.baseUrl;
}

export function hasEnvAuth(provider: string): boolean {
  try {
    return !!getEnvApiKey(provider);
  } catch {
    return false;
  }
}

function isOpenCodeModel(model: Model<Api>): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  try {
    return new URL(model.baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

/**
 * OpenCode Zen/Go require a stable per-conversation session id. pi adds these
 * headers to its own provider calls, so direct fetch() calls must mirror them.
 */
export function getProviderSessionHeaders(
  model: Model<Api>,
  ctx: ExtensionContext,
): Record<string, string> | undefined {
  if (!isOpenCodeModel(model)) return undefined;
  try {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return undefined;
    return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
