import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  FETCH_ATTEMPT_CAP,
  SEARCH_ATTEMPT_CAP,
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
  truncateText,
  type WebSearchAttempt,
  type WebSearchDetails,
  type WebSearchOutput,
  type WebSearchRoute,
} from "./format.ts";
import {
  candidateHealthProvider,
  clearModelFailure,
  clearProviderFailure,
  prioritizeCandidates,
  recordModelFailure,
  recordProviderFailure,
} from "./health.ts";
import { QueryLengthError } from "./providers/types.ts";
import { MAX_URL_LENGTH, MAX_URLS } from "./schema.ts";
import { describeRoute, routeFor } from "./routes.ts";
import { redactDedicatedSecrets } from "./dedicated-config.ts";
import { allowExplicitAttempt } from "./providers/dedicated-http.ts";
import { createAttemptSignal, markAttemptOutput } from "./attempt-timeout.ts";

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

const MAX_ERROR_DETAIL_CHARS = 8_192;
const SEARCH_UNAVAILABLE = "No eligible search interface is available. Run /pi-better-web-search login to configure a search API, or use OpenAI luna, Claude haiku, or another brand's flash model with a supported API.";
const FETCH_UNAVAILABLE = "URL fetch is not available in this conversation.";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function limitErrorMessage(message: string): string {
  message = redactDedicatedSecrets(message);
  const marker = "[truncated]";
  const limited = truncateText(message, MAX_ERROR_DETAIL_CHARS);
  return limited.truncated
    ? `${truncateText(message, MAX_ERROR_DETAIL_CHARS - marker.length).text}${marker}`
    : message;
}

function summarizeUrlErrors(errors: UrlValidationError[]): string {
  return errors.map((entry) => `${entry.url}: ${entry.error}`).join("; ");
}

export function validateUrl(value: string): string | undefined {
  if (value.length === 0) return "URL must not be empty";
  if (Array.from(value).length > MAX_URL_LENGTH) return `URL is longer than ${MAX_URL_LENGTH} characters`;
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
  const unknownKey = Object.keys(input).find((key) => key !== "query" && key !== "urls");
  if (unknownKey !== undefined) {
    return { ok: false, error: `Unknown argument ${JSON.stringify(unknownKey)}. Only "query" and "urls" are supported.` };
  }
  if (input.query !== undefined && typeof input.query !== "string") {
    return { ok: false, error: '"query" must be a string.' };
  }
  const trimmedQuery = typeof input.query === "string" ? input.query.trim() : "";
  const query = trimmedQuery.length > 0 ? trimmedQuery : undefined;

  if (input.urls !== undefined && !Array.isArray(input.urls)) {
    return { ok: false, error: '"urls" must be an array of strings.' };
  }

  const rawUrls = Array.isArray(input.urls) ? input.urls : [];
  if (input.urls !== undefined && rawUrls.length === 0) {
    return { ok: false, error: '"urls" must contain at least one URL when provided.' };
  }
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
  // Node rejects fractional delays; values above int32 max become 1 ms timers.
  return Number.isInteger(configured) && configured >= 1 && configured <= 0x7FFF_FFFF
    ? configured
    : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Adapters are expected to honor the signal, but a timeout must still release
 * the orchestrator if an implementation ignores it.
 */
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    // Always observe the adapter promise, even if it aborted the signal before
    // returning. Otherwise a late rejection would be unhandled.
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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
  activeRoute: WebSearchRoute,
): void {
  onUpdate?.({
    content: [{ type: "text", text }],
    details: { attempts: [...attempts], activeRoute },
  });
}

function attemptKey(candidate: Candidate): ProviderRef {
  return { provider: candidate.model.provider, model: candidate.model.id };
}

// Standalone and model routes can use different credentials and endpoints.
function failureScope(candidate: Candidate): string {
  return `${candidate.model.api === "dedicated-web-search" ? "dedicated" : "model"}:${candidate.model.provider}`;
}

/**
 * Provider-wide failures cannot be fixed by trying another model from the same
 * provider: the credential, balance, network path, or request shape is broken.
 * Model-specific failures (an unsupported or missing model, or a rejected
 * legacy model) can be, so the orchestrator keeps trying sibling models for
 * those. The classifier is intentionally conservative: anything it does not
 * recognize is treated as model-specific, which only costs an extra attempt.
 */
const PROVIDER_WIDE_FAILURE_PATTERNS: readonly RegExp[] = [
  // HTTP status codes as adapters format them: `(401 Unauthorized)`,
  // `(500 Internal Server Error)`, `HTTP 429`, `status code 403`.
  /(?:\(|HTTP\s+|status(?:\s+code)?\s*)(?:401|403|429)\b/i,
  /(?:\(|HTTP\s+|status(?:\s+code)?\s*)5\d{2}\b/i,
  /\bunauthoriz(?:ed|ation)?\b/i,
  /\bforbidden\b/i,
  /\binsufficient\b[^.]*\b(?:balance|quota|credit|credits|funds|billing)\b/i,
  /\brate.?limit/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/,
  /\bfetch failed\b/i,
  /\btimed?\s?out\b/i,
  /\bbytestring\b/i,
];

const MODEL_PERMISSION_PATTERNS: readonly RegExp[] = [
  /\bmodel[_ -](?:not[_ -](?:found|allowed|available|supported)|access[_ -]denied)\b/i,
  /\bmodels?\b[^\n]{0,200}\b(?:not (?:found|allowed|available|accessible|enabled|supported)|does not exist|access denied|permission denied)\b/i,
  /\b(?:do(?:es)? not have|don't have|no|lack(?:s)?|denied|not (?:allowed|authorized|permitted))\b[^\n]{0,160}\b(?:access|permission|use)\b[^\n]{0,160}\bmodels?\b/i,
  /\b(?:access|permission)\b[^\n]{0,160}\b(?:denied|not (?:granted|allowed|permitted))\b[^\n]{0,160}\bmodels?\b/i,
  /\b(?:access|permission)\b[^\n]{0,160}\bmodels?\b[^\n]{0,160}\b(?:denied|not (?:granted|allowed|permitted))\b/i,
];

export function isProviderWideFailure(message: string, error?: unknown): boolean {
  const details = typeof error === "object" && error !== null
    ? error as { status?: unknown; code?: unknown }
    : undefined;
  const isForbidden = details?.status === 403 || details?.status === "403"
    || /(?:\(|HTTP\s+|status(?:\s+code)?\s*)403\b|\bforbidden\b/i.test(message);
  const code = typeof details?.code === "string" ? details.code : "";
  if (isForbidden && MODEL_PERMISSION_PATTERNS.some((pattern) => pattern.test(`${code} ${message}`))) {
    return false;
  }
  const status = typeof details?.status === "number" || typeof details?.status === "string"
    ? Number(details.status)
    : NaN;
  if (status === 401 || status === 402 || status === 403 || status === 429 || (status >= 500 && status < 600)) return true;
  return PROVIDER_WIDE_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

function resultCount(result: { results?: unknown }): number | undefined {
  return Array.isArray(result.results) ? result.results.length : undefined;
}

function attemptMessages(attempts: WebSearchAttempt[], phase: "search" | "fetch"): string {
  const messages = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.phase !== phase) continue;
    const message = attempt.message.trim();
    if (message) messages.add(message);
  }
  return [...messages].join("; ");
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
  const candidates = getSearchCandidates(resolution, Infinity);
  if (candidates.length === 0) return undefined;

  // Skipped candidates do not consume the budget. Consider the full discovery
  // set when applying cooldowns so a healthy provider beyond the cap is usable.
  const failedProviders = new Set<string>();
  let attemptCount = 0;

  for (const candidate of prioritizeCandidates("search", candidates, Date.now(), resolution.preferences.search)) {
    if (externalSignal?.aborted) throw abortReason(externalSignal);
    if (failedProviders.has(failureScope(candidate))) continue;
    if (attemptCount >= SEARCH_ATTEMPT_CAP) break;
    attemptCount += 1;
    const attemptStartedAt = Date.now();

    const timeout = timeoutMs();
    const attempt = createAttemptSignal(externalSignal, timeout);
    const { signal } = attempt;
    let active = true;
    const relayUpdate: AgentToolUpdateCallback = (...args) => {
      if (!active || signal.aborted) return;
      markAttemptOutput(signal);
      onUpdate?.(...args);
    };
    if (candidate === candidates[0] && candidate.model.provider === resolution.preferences.search) allowExplicitAttempt(signal);
    const route = routeFor(candidate, "search");
    progress(onUpdate, `${describeRoute(route)}...`, attempts, route);

    try {
      const result = await withSignal(
        candidate.adapter.search(resolution.ctx, candidate.model, query, signal, relayUpdate),
        signal,
      );
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      clearProviderFailure("search", candidateHealthProvider(candidate));
      clearModelFailure("search", candidateHealthProvider(candidate), candidate.model.id);
      return { candidate, result: result ?? {} };
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      // Input validation is actionable by the model and must not poison health
      // or silently fall through to another provider.
      if (error instanceof QueryLengthError) throw error;
      const rawMessage = errorMessage(error);
      const providerWide = isProviderWideFailure(rawMessage, error);
      const message = limitErrorMessage(rawMessage);
      attempts.push({
        phase: "search",
        provider: candidate.model.provider,
        model: candidate.model.id,
        message,
      });
      if (providerWide) {
        failedProviders.add(failureScope(candidate));
        recordProviderFailure("search", candidateHealthProvider(candidate), message, Date.now(), attemptStartedAt);
      } else {
        recordModelFailure(
          "search",
          candidateHealthProvider(candidate),
          candidate.model.id,
          message,
          Date.now(),
          attemptStartedAt,
        );
      }
    } finally {
      active = false;
      attempt.dispose();
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
      states[index].error = limitErrorMessage(entry.error || "Provider did not return data for this URL");
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
      states[index].error = FETCH_UNAVAILABLE;
    }
    return { successful: 0 };
  }

  let preferred: Candidate | undefined;
  let preferredSuccessful = 0;

  // As with search, a provider-wide failure is not retried with another model
  // from the same provider id.
  const failedProviders = new Set<string>();
  let attemptCount = 0;

  for (const candidate of prioritizeCandidates("fetch", candidates, Date.now(), resolution.preferences.fetch)) {
    if (remaining.length === 0) break;
    if (externalSignal?.aborted) throw abortReason(externalSignal);
    if (failedProviders.has(failureScope(candidate))) continue;
    if (attemptCount >= FETCH_ATTEMPT_CAP) break;
    attemptCount += 1;
    const attemptStartedAt = Date.now();

    const timeout = timeoutMs();
    const attempt = createAttemptSignal(externalSignal, timeout);
    const { signal } = attempt;
    let active = true;
    const relayUpdate: AgentToolUpdateCallback = (...args) => {
      if (!active || signal.aborted) return;
      markAttemptOutput(signal);
      onUpdate?.(...args);
    };
    if (candidate === candidates[0] && candidate.model.provider === resolution.preferences.fetch) allowExplicitAttempt(signal);
    const requested = requestedOccurrences(states, remaining);
    const route = routeFor(candidate, "fetch");
    progress(
      onUpdate,
      `${describeRoute(route)} — fetching ${requested.length} URL${requested.length === 1 ? "" : "s"}...`,
      attempts,
      route,
    );

    try {
      const result = await withSignal(
        candidate.adapter.fetch!(
          resolution.ctx,
          candidate.model,
          requested,
          query,
          signal,
          relayUpdate,
        ),
        signal,
      );
      if (externalSignal?.aborted) throw abortReason(externalSignal);

      const assigned = assignFetchEntries(states, remaining, result?.entries ?? [], candidate);
      remaining = assigned.remaining;
      if (result?.providerError) {
        const message = limitErrorMessage(result.providerError);
        attempts.push({
          phase: "fetch",
          provider: candidate.model.provider,
          model: candidate.model.id,
          message,
        });
        failedProviders.add(failureScope(candidate));
        recordProviderFailure("fetch", candidateHealthProvider(candidate), message, Date.now(), attemptStartedAt);
        for (const index of remaining) states[index].error ||= message;
      } else if (assigned.successful > 0) {
        clearProviderFailure("fetch", candidateHealthProvider(candidate));
        clearModelFailure("fetch", candidateHealthProvider(candidate), candidate.model.id);
      }

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
      const rawMessage = errorMessage(error);
      const providerWide = isProviderWideFailure(rawMessage, error);
      const message = limitErrorMessage(rawMessage);
      attempts.push({
        phase: "fetch",
        provider: candidate.model.provider,
        model: candidate.model.id,
        message,
      });
      if (providerWide) {
        failedProviders.add(failureScope(candidate));
        recordProviderFailure("fetch", candidateHealthProvider(candidate), message, Date.now(), attemptStartedAt);
      } else {
        recordModelFailure(
          "fetch",
          candidateHealthProvider(candidate),
          candidate.model.id,
          message,
          Date.now(),
          attemptStartedAt,
        );
      }
      for (const index of remaining) {
        states[index].error = message;
      }
    } finally {
      active = false;
      attempt.dispose();
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

  // Search and fetch fail independently. Only decide the overall outcome after
  // both requested operations have had a chance to return useful data.
  let searchSuccess: SearchSuccess | undefined;
  let searchFailure: string | undefined;
  let queryLengthFailure = false;
  if (searchRequested) {
    try {
      searchSuccess = await runSearch(resolution, query, signal, onUpdate, attempts);
    } catch (error) {
      if (!(error instanceof QueryLengthError)) throw error;
      searchFailure = error.message;
      queryLengthFailure = true;
    }
    if (!searchSuccess) {
      searchFailure ??= attemptMessages(attempts, "search") || SEARCH_UNAVAILABLE;
    }
  }

  const fetchCandidates = validFetchRequested ? getFetchCandidates(resolution, Infinity) : [];
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
  }

  if (!searchSuccess && fetchSuccessful === 0) {
    const failures: string[] = [];
    if (searchFailure) failures.push(fetchRequested ? `Search failed. ${searchFailure}` : searchFailure);
    if (fetchRequested) {
      if (validFetchRequested && fetchCandidates.length === 0) {
        failures.push(FETCH_UNAVAILABLE);
      } else {
        const failure = attemptMessages(attempts, "fetch");
        const urlFailure = [
          ...states.map((state) => `${state.url}: ${state.error || "fetch failed"}`),
          ...urlErrors.map((entry) => `${entry.url}: ${entry.error}`),
        ].join("; ");
        failures.push(`URL fetch failed. ${failure ? `${failure}. ` : ""}${urlFailure}`);
      }
    }
    const message = failures.join("; ");
    return formatError(message, { attempts, error: message }, queryLengthFailure && !fetchRequested ? "" : "Failed: ");
  }

  const visibleSearchError = searchFailure ? limitErrorMessage(searchFailure) : undefined;
  const output: WebSearchOutput = {};
  if (searchSuccess) {
    output.search = { ...searchSuccess.result };
  } else if (visibleSearchError) {
    output.search = { error: visibleSearchError };
  }
  if (fetchRequested) {
    output.fetched = fetchOutput(states, urlErrors);
  }

  const searchResultCount = searchSuccess ? resultCount(searchSuccess.result) : undefined;
  const routes: WebSearchRoute[] = searchSuccess ? [routeFor(searchSuccess.candidate, "search")] : [];
  const seenFetchRoutes = new Set<string>();
  for (const state of states) {
    if (!state.provider || state.data === undefined) continue;
    const route = routeFor(state.provider, "fetch");
    const key = JSON.stringify(route);
    if (seenFetchRoutes.has(key)) continue;
    seenFetchRoutes.add(key);
    routes.push(route);
  }
  const details: WebSearchDetails = {
    routes,
    ...(visibleSearchError ? { searchError: visibleSearchError } : {}),
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
    ...(fetchRequested
      ? { fetchedCount: fetchSuccessful, fetchFailedCount: urls.length + urlErrors.length - fetchSuccessful }
      : {}),
  };

  const cache = nextCache(
    resolution,
    searchSuccess?.candidate,
    fetchCandidate,
  );
  if (cache) writeCache(cache);

  return formatSuccess(output, details);
}
