import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getFetchCandidates,
  getSearchCandidates,
  resolveResolutionContext,
  type Candidate,
  type ResolutionContext,
} from "./candidates.ts";
import { writeCache, type PreferenceCache, type ProviderRef } from "./cache.ts";
import {
  formatError,
  formatSuccess,
  type WebSearchAttempt,
  type WebSearchDetails,
  type WebSearchOutput,
} from "./format.ts";
import { MAX_URLS } from "./schema.ts";

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;

export interface UrlValidationError {
  url: string;
  error: string;
}

export type ParsedWebSearchInput =
  | {
      ok: true;
      query?: string;
      urls: string[];
      urlErrors: UrlValidationError[];
    }
  | { ok: false; error: string };

interface FetchState {
  url: string;
  data?: unknown;
  provider?: Candidate;
  error?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function summarizeUrlErrors(errors: UrlValidationError[]): string {
  return errors.map((entry) => `${entry.url}: ${entry.error}`).join("; ");
}

export function validateUrl(value: string): string | undefined {
  if (value.length > 8_192) return "URL is longer than 8192 characters";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "not a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http or https";
  }
  if (!parsed.hostname) return "URL must include a host";
  if (parsed.username || parsed.password) {
    return "URL must not include a username or password";
  }
  return undefined;
}

export function parseWebSearchInput(params: unknown): ParsedWebSearchInput {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "Invalid arguments: expected an object." };
  }

  const input = params as Record<string, unknown>;
  if (input.query !== undefined && typeof input.query !== "string") {
    return { ok: false, error: '"query" must be a string.' };
  }
  const trimmedQuery = typeof input.query === "string" ? input.query.trim() : "";
  const query = trimmedQuery.length > 0 ? trimmedQuery : undefined;

  if (input.urls !== undefined && !Array.isArray(input.urls)) {
    return { ok: false, error: '"urls" must be an array of strings.' };
  }

  const rawUrls = Array.isArray(input.urls) ? input.urls : [];
  if (rawUrls.length > MAX_URLS) {
    return { ok: false, error: `At most ${MAX_URLS} URLs are allowed (received ${rawUrls.length}).` };
  }
  if (rawUrls.some((value) => typeof value !== "string")) {
    return { ok: false, error: '"urls" must contain only strings.' };
  }

  const urls: string[] = [];
  const urlErrors: UrlValidationError[] = [];
  for (const value of rawUrls as string[]) {
    const error = validateUrl(value);
    if (error) urlErrors.push({ url: value, error });
    else urls.push(value);
  }

  if (!query && urls.length === 0) {
    const detail = urlErrors.length > 0 ? ` ${summarizeUrlErrors(urlErrors)}` : "";
    return {
      ok: false,
      error: `A non-empty query or at least one valid URL is required.${detail}`,
    };
  }

  return {
    ok: true,
    ...(query ? { query } : {}),
    urls,
    urlErrors,
  };
}

function timeoutMs(): number {
  const configured = Number(process.env.PI_BETTER_WEB_SEARCH_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function attemptSignal(external: AbortSignal | undefined, timeout: number): AbortSignal {
  const timer = AbortSignal.timeout(timeout);
  return external ? AbortSignal.any([external, timer]) : timer;
}

/**
 * Adapters are expected to honor the signal, but a timeout must still release
 * the orchestrator if an implementation ignores it.
 */
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function progress(
  onUpdate: AgentToolUpdateCallback | undefined,
  text: string,
  attempts: WebSearchAttempt[],
): void {
  onUpdate?.({
    content: [{ type: "text", text }],
    details: { attempts: [...attempts] },
  });
}

function attemptKey(candidate: Candidate): ProviderRef {
  return { provider: candidate.model.provider, model: candidate.model.id };
}

function resultCount(result: { results?: unknown }): number | undefined {
  return Array.isArray(result.results) ? result.results.length : undefined;
}

function attemptSummary(attempts: WebSearchAttempt[], phase: "search" | "fetch"): string {
  return attempts
    .filter((attempt) => attempt.phase === phase)
    .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.message}`)
    .join("; ");
}

function nextCache(
  resolution: ResolutionContext,
  search: Candidate | undefined,
  fetch: Candidate | undefined,
): PreferenceCache | undefined {
  if (!search && !fetch) return undefined;

  const cache: PreferenceCache = { version: 1 };

  if (!resolution.fresh) {
    // The cache already matched discovery, so untouched refs remain valid
    // hints even if a requested operation failed. A stale ref is never
    // carried into the new fingerprint unless it succeeds during this call.
    if (resolution.cache.search) cache.search = resolution.cache.search;
    if (resolution.cache.fetch) cache.fetch = resolution.cache.fetch;
  }

  if (search) cache.search = attemptKey(search);
  if (fetch) cache.fetch = attemptKey(fetch);
  cache.fingerprint = resolution.fingerprint;
  return cache;
}

interface SearchSuccess {
  candidate: Candidate;
  result: Awaited<ReturnType<Candidate["adapter"]["search"]>>;
}

async function runSearch(
  resolution: ResolutionContext,
  query: string,
  externalSignal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  attempts: WebSearchAttempt[],
): Promise<SearchSuccess | undefined> {
  const candidates = getSearchCandidates(resolution);
  if (candidates.length === 0) return undefined;

  for (const candidate of candidates) {
    if (externalSignal?.aborted) throw abortReason(externalSignal);

    const timeout = timeoutMs();
    const signal = attemptSignal(externalSignal, timeout);
    progress(onUpdate, `Searching with ${candidate.model.provider}/${candidate.model.id}...`, attempts);

    try {
      const result = await withSignal(
        candidate.adapter.search(resolution.ctx, candidate.model, query, signal, onUpdate),
        signal,
      );
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      return { candidate, result: result ?? {} };
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      attempts.push({
        phase: "search",
        provider: candidate.model.provider,
        model: candidate.model.id,
        message: errorMessage(error),
      });
    }
  }

  return undefined;
}

function requestedOccurrences(states: FetchState[], remaining: number[]): string[] {
  return remaining.map((index) => states[index].url);
}

function assignFetchEntries(
  states: FetchState[],
  remaining: number[],
  entries: Awaited<ReturnType<NonNullable<Candidate["adapter"]["fetch"]>>>["entries"],
  candidate: Candidate,
): { remaining: number[]; successful: number } {
  const pendingByUrl = new Map<string, number[]>();
  for (const index of remaining) {
    const list = pendingByUrl.get(states[index].url) ?? [];
    list.push(index);
    pendingByUrl.set(states[index].url, list);
  }

  let successful = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const pending = pendingByUrl.get(entry.url);
    const index = pending?.shift();
    if (index === undefined) continue;

    if (entry.error || entry.data === undefined) {
      states[index].error = entry.error || "Provider did not return data for this URL";
      continue;
    }

    states[index].provider = candidate;
    states[index].data = entry.data;
    states[index].error = undefined;
    successful += 1;
  }

  const nextRemaining = remaining.filter((index) => states[index].data === undefined);
  return { remaining: nextRemaining, successful };
}

async function runFetch(
  resolution: ResolutionContext,
  candidates: Candidate[],
  query: string | undefined,
  externalSignal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  attempts: WebSearchAttempt[],
  states: FetchState[],
): Promise<{ candidate?: Candidate; successful: number }> {
  let remaining = states.map((_state, index) => index);

  if (candidates.length === 0) {
    for (const index of remaining) {
      states[index].error = "No URL fetch provider is available";
    }
    return { successful: 0 };
  }

  let preferred: Candidate | undefined;
  let preferredSuccessful = 0;

  for (const candidate of candidates) {
    if (remaining.length === 0) break;
    if (externalSignal?.aborted) throw abortReason(externalSignal);

    const timeout = timeoutMs();
    const signal = attemptSignal(externalSignal, timeout);
    const requested = requestedOccurrences(states, remaining);
    progress(
      onUpdate,
      `Fetching ${requested.length} URL${requested.length === 1 ? "" : "s"} with ${candidate.model.provider}/${candidate.model.id}...`,
      attempts,
    );

    try {
      const result = await withSignal(
        candidate.adapter.fetch!(
          resolution.ctx,
          candidate.model,
          requested,
          query,
          signal,
          onUpdate,
        ),
        signal,
      );
      if (externalSignal?.aborted) throw abortReason(externalSignal);

      const assigned = assignFetchEntries(states, remaining, result?.entries ?? [], candidate);
      remaining = assigned.remaining;

      if (assigned.successful > 0) {
        // Replace only on a strictly larger success count, so the first
        // candidate wins ties.
        if (assigned.successful > preferredSuccessful) {
          preferred = candidate;
          preferredSuccessful = assigned.successful;
        }
      }
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      const message = errorMessage(error);
      attempts.push({
        phase: "fetch",
        provider: candidate.model.provider,
        model: candidate.model.id,
        message,
      });
      for (const index of remaining) {
        states[index].error = message;
      }
    }
  }

  for (const index of remaining) {
    states[index].error ||= "No provider could fetch this URL";
  }

  return {
    ...(preferred ? { candidate: preferred } : {}),
    successful: states.filter((state) => state.data !== undefined).length,
  };
}

function fetchOutput(states: FetchState[], urlErrors: UrlValidationError[]): NonNullable<WebSearchOutput["fetched"]> {
  const fetched: NonNullable<WebSearchOutput["fetched"]> = states.map((state) => {
    if (state.data !== undefined && state.provider) {
      return {
        url: state.url,
        data: state.data,
      };
    }
    return {
      url: state.url,
      error: state.error || "No provider could fetch this URL",
    };
  });

  for (const invalid of urlErrors) {
    fetched.push({ url: invalid.url, error: invalid.error });
  }
  return fetched;
}

export async function runWebSearch(
  params: unknown,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
): Promise<AgentToolResult<WebSearchDetails>> {
  const parsed = parseWebSearchInput(params);
  if (!parsed.ok) {
    return formatError(parsed.error, { attempts: [], error: parsed.error });
  }

  if (signal?.aborted) throw abortReason(signal);

  const { query, urls, urlErrors } = parsed;
  const searchRequested = query !== undefined;
  const validFetchRequested = urls.length > 0;
  const fetchRequested = validFetchRequested || urlErrors.length > 0;
  const attempts: WebSearchAttempt[] = [];
  const resolution = resolveResolutionContext(ctx);

  let searchSuccess: SearchSuccess | undefined;
  if (searchRequested) {
    const candidates = getSearchCandidates(resolution);
    if (candidates.length === 0) {
      const message = "This tool is not available in this conversation.";
      return formatError(message, { attempts, error: message });
    }

    searchSuccess = await runSearch(resolution, query, signal, onUpdate, attempts);
    if (!searchSuccess) {
      const message = "This tool is not available in this conversation.";
      return formatError(message, { attempts, error: message });
    }
  }

  const fetchCandidates = validFetchRequested ? getFetchCandidates(resolution) : [];
  if (validFetchRequested && fetchCandidates.length === 0) {
    const message = "URL fetch is not available in this conversation.";
    // The search half succeeded; remember it even though the URL half did not.
    const cache = nextCache(resolution, searchSuccess?.candidate, undefined);
    if (cache) writeCache(cache);
    return formatError(message, { attempts, error: message });
  }

  const states: FetchState[] = urls.map((url) => ({ url }));
  let fetchCandidate: Candidate | undefined;
  let fetchSuccessful = 0;
  if (validFetchRequested) {
    const fetched = await runFetch(
      resolution,
      fetchCandidates,
      query,
      signal,
      onUpdate,
      attempts,
      states,
    );
    fetchCandidate = fetched.candidate;
    fetchSuccessful = fetched.successful;

    if (!searchRequested && fetchSuccessful === 0) {
      const failure = attemptSummary(attempts, "fetch");
      const urlFailure = [
        ...states.map((state) => `${state.url}: ${state.error || "fetch failed"}`),
        ...urlErrors.map((entry) => `${entry.url}: ${entry.error}`),
      ].join("; ");
      const message = `URL fetch failed. ${failure ? `${failure}. ` : ""}${urlFailure}`;
      return formatError(message, { attempts, error: message });
    }
  }

  const output: WebSearchOutput = {};
  if (query) output.query = query;
  if (searchSuccess) {
    output.search = { ...searchSuccess.result };
  }
  if (fetchRequested) {
    output.fetched = fetchOutput(states, urlErrors);
  }

  const searchResultCount = searchSuccess ? resultCount(searchSuccess.result) : undefined;
  const details: WebSearchDetails = {
    ...(searchSuccess
      ? {
          provider: searchSuccess.candidate.model.provider,
          model: searchSuccess.candidate.model.id,
        }
      : {}),
    ...(fetchRequested && fetchSuccessful > 0
      ? {
          fetchProviders: [
            ...new Set(
              states
                .filter((state) => state.data !== undefined && state.provider)
                .map((state) => state.provider!.family),
            ),
          ],
        }
      : {}),
    attempts,
    ...(searchResultCount !== undefined ? { resultCount: searchResultCount } : {}),
    ...(fetchRequested ? { fetchedCount: fetchSuccessful } : {}),
  };

  const cache = nextCache(
    resolution,
    searchSuccess?.candidate,
    fetchCandidate,
  );
  if (cache) writeCache(cache);

  return formatSuccess(output, details);
}
