import { createHash } from "node:crypto";
import { providerFetch } from "../attempt-timeout.ts";
import { redactSecrets } from "../redact.ts";
import { dedicatedKey, DEDICATED_INFO, type DedicatedProvider } from "../dedicated-config.ts";
import { HttpError, errorMessage, isAbortError, readJson, responseError, retryAfterMs } from "./http.ts";

const backoffs = new Map<string, { until: number; status: number; message: string }>();
const explicitAttempts = new WeakSet<AbortSignal>();

/** Bypass a previous Retry-After once for an explicitly selected provider. */
export function allowExplicitAttempt(signal: AbortSignal): void {
  explicitAttempts.add(signal);
}

/** One attempt, no hidden SDK retries. Retry-After blocks subsequent calls,
 * across search/fetch, while the orchestrator immediately tries other providers. */
export async function dedicatedRequest(
  provider: DedicatedProvider,
  url: URL | string | ((hasKey: boolean) => URL | string),
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const info = DEDICATED_INFO[provider];
  const key = dedicatedKey(provider);
  if (provider !== "keenable" && !key) {
    throw new Error(`${info.env} is not set and no saved key exists. Create a key at ${info.setup}, then use /pi-better-web-search login or your environment; do not paste it into chat.`);
  }
  if (key && /[^\x21-\x7e]/.test(key)) {
    throw new Error(`${info.env} contains invalid header characters. Correct it in your own terminal.`);
  }
  const identity = `${provider}:${createHash("sha256").update(key ?? "public").digest("hex")}`;
  const backoff = backoffs.get(identity);
  const explicit = signal ? explicitAttempts.delete(signal) : false;
  if (!explicit && backoff && backoff.until > Date.now()) {
    const remaining = backoff.until - Date.now();
    throw new HttpError(backoff.status, `${info.name} Retry-After is active. Retry in ${Math.ceil(remaining / 1000)} seconds.\n${backoff.message}`);
  }
  // An explicit probe bypasses the existing backoff for this request only.
  // It must not clear the server's delay for concurrent or later auto calls.
  if (backoff && backoff.until <= Date.now()) backoffs.delete(identity);
  const redact = (text: string) => redactSecrets(text, [key]);
  try {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (provider === "perplexity" || provider === "deepseek") headers.set("Authorization", `Bearer ${key}`);
    else if (key) headers.set("X-API-Key", key);
    else headers.set("X-Keenable-Title", "pi-better-web-search");
    // Auth-dependent paths must use the same key snapshot as request headers.
    const target = typeof url === "function" ? url(!!key) : url;
    const response = await providerFetch(target, { ...init, headers, signal });
    if (!response.ok) {
      const error = await responseError(response, info.name, headers);
      const delay = retryAfterMs(response.headers.get("Retry-After"));
      if (delay > 0) {
        const until = Date.now() + delay;
        const existing = backoffs.get(identity);
        if (!existing || until > existing.until) backoffs.set(identity, { until, status: response.status, message: error.message });
      }
      throw error;
    }
    const data = await readJson<unknown>(response, headers, signal);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`${info.name} returned an invalid response object`);
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof HttpError) throw new HttpError(error.status, redact(error.message), undefined, error.code);
    const failure = new Error(redact(errorMessage(error)));
    if (isAbortError(error)) failure.name = "AbortError";
    throw failure;
  }
}

/** Test isolation; runtime backoff is never persisted. */
export function resetDedicatedBackoffs(provider?: string): void {
  if (!provider) backoffs.clear();
  else for (const key of backoffs.keys()) if (key.startsWith(`${provider}:`)) backoffs.delete(key);
}
