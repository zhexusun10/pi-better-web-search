import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { hasEnvAuth } from "./auth.ts";
import { configuredDedicatedProviders, dedicatedFingerprintEntries, DEDICATED_INFO, DEDICATED_PROVIDERS, isParallelActive, type DedicatedProvider } from "./dedicated-config.ts";
import { readProviderPreferences, type ProviderPreferences } from "./preferences.ts";
import {
  fingerprintAvailableModels,
  isFreshDiscovery,
  readCache,
  type PreferenceCache,
  type ProviderRef,
} from "./cache.ts";
import {
  getAdapterForFamily,
  getProviderFamily,
  isChatModel,
} from "./families.ts";
import { PROVIDER_FAMILIES } from "./providers/types.ts";
import type { ProviderAdapter, ProviderFamily } from "./providers/types.ts";

export interface Candidate {
  model: Model<Api>;
  family: ProviderFamily;
  adapter: ProviderAdapter;
  /** Provider-level tools use no inference model and have no model-tier limit. */
  nativeTools?: true;
}

export interface ResolutionContext {
  ctx: ExtensionContext;
  current?: Candidate;
  currentProvider?: string;
  available: Candidate[];
  cache: PreferenceCache;
  preferences: ProviderPreferences;
  fingerprint: string;
  fresh: boolean;
}

/** One initial attempt plus at most six fallback attempts per phase. */
export const SEARCH_ATTEMPT_CAP = 7;
export const FETCH_ATTEMPT_CAP = 7;

// Compatibility aliases for embedders and tests that used earlier names.
export const MAX_SEARCH_ATTEMPTS = SEARCH_ATTEMPT_CAP;
export const MAX_FETCH_ATTEMPTS = FETCH_ATTEMPT_CAP;
export const SEARCH_MAX_ATTEMPTS = SEARCH_ATTEMPT_CAP;
export const FETCH_MAX_ATTEMPTS = FETCH_ATTEMPT_CAP;
export const SEARCH_ATTEMPT_LIMIT = SEARCH_ATTEMPT_CAP;
export const FETCH_ATTEMPT_LIMIT = FETCH_ATTEMPT_CAP;
export const SEARCH_CANDIDATE_CAP = SEARCH_ATTEMPT_CAP;
export const FETCH_CANDIDATE_CAP = FETCH_ATTEMPT_CAP;
export const SEARCH_CANDIDATE_LIMIT = SEARCH_ATTEMPT_CAP;
export const FETCH_CANDIDATE_LIMIT = FETCH_ATTEMPT_CAP;
export const MAX_SEARCH_CANDIDATES = SEARCH_ATTEMPT_CAP;
export const MAX_FETCH_CANDIDATES = FETCH_ATTEMPT_CAP;
export const SEARCH_CAP = SEARCH_ATTEMPT_CAP;
export const FETCH_CAP = FETCH_ATTEMPT_CAP;

/** Ignore gateway namespaces when recognizing model brands and versions. */
function normalizedModelId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}

/** Brand order only applies to models with a supported adapter and light tier. */
function modelBrandRank(id: string): number {
  const normalized = normalizedModelId(id);
  if (/^deepseek(?:[-_.:]|\d|$)/.test(normalized)) return 0;
  if (/^(?:gpt|chatgpt|codex)(?:[-_.:]|\d|$)/.test(normalized) || /^o\d/.test(normalized)) return 1;
  if (/^claude(?:[-_.:]|$)/.test(normalized)) return 2;
  if (/^(?:gemini|gemma)(?:[-_.:]|$)/.test(normalized)) return 3;
  return 4;
}

/**
 * A strict allowlist for inference-backed routes, not a price estimate:
 * never fall back to a larger tier. API-only tools invoke no inference model.
 * Classify by model brand, not API family, so gateways follow the same rule.
 */
function isLightweightCandidate(candidate: Candidate): boolean {
  if (candidate.adapter.standalone || candidate.nativeTools) return true;
  const id = normalizedModelId(candidate.model.id);
  const brand = modelBrandRank(id);
  const tier = brand === 1 ? "luna" : brand === 2 ? "haiku" : "flash";
  return new RegExp(`(?:^|[^a-z])${tier}(?:$|[^a-z0-9])`, "i").test(id);
}

/** Parse numeric versions by brand, including Claude's dotted/dashed minors. */
function versionTuple(id: string): number[] {
  const normalized = normalizedModelId(id);
  let match: RegExpMatchArray | null;
  if (/^claude(?:[-_.:]|$)/.test(normalized)) {
    match = normalized.match(/^claude[-_](?:(?:haiku|sonnet|opus|fable)[-_])?(\d+(?:[.-]\d+)*)/);
  } else {
    match = normalized.match(/^(?:deepseek|gpt|chatgpt|codex|o|gemini|gemma|grok)[-_ ]?v?(\d+(?:\.\d+)*)/);
    // Unknown brands can still use e.g. custom-v6.1-flash. Do not treat
    // parameter counts (120b) or preview dates as a model version.
    match ??= normalized.match(/(?:^|[-_:])v?(\d+(?:\.\d+)*)(?=$|[-_:])/);
  }
  if (!match) return [];
  const parts: number[] = [];
  for (const part of match[1].split(/[.-]/)) {
    if (part.length >= 8) break; // e.g. claude-haiku-5-5-20260101
    parts.push(Number(part));
  }
  return parts;
}

/** Compare version tuples so that a larger, newer version sorts first. */
function compareVersionsDesc(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return b - a;
  }
  return 0;
}

function isCandidate(value: Candidate | Model<Api>): value is Candidate {
  return "model" in value && "family" in value && "adapter" in value;
}

function modelOf(value: Candidate | Model<Api>): Model<Api> {
  return isCandidate(value) ? value.model : value;
}

/** Stable identity used for dedupe and cache refs: provider plus model id. */
export function candidateKey(value: Candidate | Model<Api>): string {
  const model = modelOf(value);
  return `${model.provider}/${model.id}`;
}

/** Human-readable candidate name used in progress and error messages. */
export function describeCandidate(value: Candidate | Model<Api>): string {
  const model = modelOf(value);
  const family = isCandidate(value) ? value.family : getProviderFamily(model);
  return family
    ? `${candidateKey(model)} (${family})`
    : candidateKey(model);
}

function candidateForModel(model: Model<Api> | undefined): Candidate | undefined {
  if (!isChatModel(model)) return undefined;
  const family = getProviderFamily(model);
  if (!family) return undefined;
  const adapter = getAdapterForFamily(family);
  if (!adapter) return undefined;
  return { model, family, adapter };
}

/** Internal routing identity for legacy cache/health interfaces only. Never
 * registered as a pi model, displayed as an inference model, or sent to an API. */
function dedicatedCandidate(provider: DedicatedProvider): Candidate {
  const model: Model<Api> = {
    provider, id: DEDICATED_INFO[provider].fetch ? "search-fetch" : "search",
    name: DEDICATED_INFO[provider].name, api: "dedicated-web-search",
    baseUrl: DEDICATED_INFO[provider].baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0, maxTokens: 0,
  };
  const adapter = getAdapterForFamily(provider)!;
  return { model, family: provider, adapter: provider === "deepseek" ? { ...adapter, standalone: true } : adapter };
}

/** Reuse pi's DeepSeek login even while its chat catalog is empty, filtered,
 * stale, or contains only non-flash ids. Never read/copy pi's credential file. */
function piDeepSeekToolsCandidate(
  ctx: ExtensionContext,
  nativeCandidates: Candidate[],
  current: Candidate | undefined,
): Candidate | undefined {
  if (nativeCandidates.some(candidate => candidate.family === "deepseek" && supportsUrls(candidate))) {
    return undefined; // The existing authenticated model route already works.
  }
  try {
    const registry = ctx.modelRegistry;
    const provider = registry.getProvider?.("deepseek");
    // Preserve configured native/proxy origins; never borrow another provider's key.
    const baseUrl = provider?.baseUrl
      || registry.getAll?.().find(model => model.provider === "deepseek" && isChatModel(model))?.baseUrl;
    if (!baseUrl) return undefined;
    const model: Model<Api> = {
      ...dedicatedCandidate("deepseek").model,
      id: "pi-search-fetch",
      api: "pi-native-web-search",
      baseUrl,
    };
    const configured = registry.getProviderAuthStatus?.("deepseek").configured
      || registry.hasConfiguredAuth(model);
    if (!configured) return undefined;
    if (current?.family === "deepseek" && supportsUrls(current) && registry.hasConfiguredAuth(current.model)) {
      return undefined;
    }
    return { model, family: "deepseek", adapter: getAdapterForFamily("deepseek")!, nativeTools: true };
  } catch {
    // Older registries or failed provider discovery must not break other routes.
    return undefined;
  }
}

function availableModels(ctx: ExtensionContext): Model<Api>[] {
  try {
    const models = ctx.modelRegistry.getAvailable();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

/**
 * Collect the current model and the authenticated chat models once. The cache
 * and fingerprint come from the same snapshot so candidate ordering and cache
 * freshness cannot disagree within a tool call.
 */
export function resolveResolutionContext(
  ctx: ExtensionContext,
  model?: Model<Api>,
): ResolutionContext {
  const conversationModel = model ?? ctx.model;
  const current = candidateForModel(conversationModel);
  const models = availableModels(ctx);
  const available: Candidate[] = [];
  const seen = new Set<string>();

  for (const availableModel of models) {
    const candidate = candidateForModel(availableModel);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    available.push(candidate);
  }

  const piDeepSeek = piDeepSeekToolsCandidate(ctx, available, current);
  if (piDeepSeek) available.push(piDeepSeek);

  const preferences = readProviderPreferences();
  for (const provider of configuredDedicatedProviders(preferences.apis)) {
    available.push(dedicatedCandidate(provider));
  }
  const cache = readCache();
  const fingerprint = fingerprintAvailableModels(ctx, models, [
    ...dedicatedFingerprintEntries(preferences.apis),
    ...(piDeepSeek ? [`pi-tools:deepseek@${piDeepSeek.model.baseUrl}`] : []),
  ]);
  return {
    ctx,
    ...(conversationModel ? { currentProvider: conversationModel.provider } : {}),
    ...(current ? { current } : {}),
    available,
    cache,
    preferences,
    fingerprint,
    fresh: isFreshDiscovery(cache, fingerprint),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Inference-backed routes require lightweight models; newest version wins. */
export function rankFamilyCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter(isLightweightCandidate).sort((left, right) => {
    const standaloneOrder = Number(!!right.adapter.standalone) - Number(!!left.adapter.standalone);
    if (standaloneOrder !== 0) return standaloneOrder;
    const leftBrand = modelBrandRank(left.model.id);
    const rightBrand = modelBrandRank(right.model.id);
    const brandOrder = leftBrand - rightBrand;
    if (brandOrder !== 0) return brandOrder;

    return compareVersionsDesc(
      versionTuple(left.model.id),
      versionTuple(right.model.id),
    )
      || compareText(candidateKey(left), candidateKey(right))
      || compareText(left.model.baseUrl ?? "", right.model.baseUrl ?? "");
  });
}

function supportsSearch(candidate: Candidate | undefined): candidate is Candidate {
  return !!candidate?.adapter.supportsSearch && isLightweightCandidate(candidate);
}

function supportsUrls(candidate: Candidate | undefined): candidate is Candidate {
  return !!candidate?.adapter.supportsUrls
    && typeof candidate.adapter.fetch === "function"
    && isLightweightCandidate(candidate);
}

/** Include a supported current model even when it is absent from the registry. */
function discoveredCandidates(resolution: ResolutionContext): Candidate[] {
  const { current, available } = resolution;
  return current && !available.some((candidate) => candidateKey(candidate) === candidateKey(current))
    ? [...available, current]
    : available;
}

function resolveRef(
  resolution: ResolutionContext,
  ref: Pick<ProviderRef, "provider"> | undefined,
  usable: (candidate: Candidate) => boolean,
): Candidate | undefined {
  if (!ref) return undefined;

  // Cache refs are provider hints only: never pin an older or non-light model.
  const sameProvider = discoveredCandidates(resolution)
    .filter((candidate) => candidate.model.provider === ref.provider)
    .filter(usable);
  return rankFamilyCandidates(sameProvider)[0];
}

function addUnique(
  selected: Candidate[],
  candidate: Candidate | undefined,
  seen: Set<string>,
  cap: number,
): boolean {
  if (!candidate || selected.length >= cap) return false;
  const key = candidateKey(candidate);
  if (seen.has(key)) return false;
  seen.add(key);
  selected.push(candidate);
  return true;
}

function usableFamilyCandidates(
  resolution: ResolutionContext,
  family: ProviderFamily,
  isUsable: (candidate: Candidate) => boolean,
): Candidate[] {
  return rankFamilyCandidates(
    discoveredCandidates(resolution).filter((candidate) => candidate.family === family && isUsable(candidate)),
  );
}

export function isParallelLocked(resolution: Pick<ResolutionContext, "preferences" | "available">): boolean {
  return isParallelActive(resolution.preferences.apis)
    || resolution.available.some(candidate => candidate.family === "parallel" && candidate.adapter.standalone);
}

function buildCandidates(
  resolution: ResolutionContext,
  isUsable: (candidate: Candidate) => boolean,
  cached: Candidate | undefined,
  cap: number,
  preferredProvider: string | undefined,
): Candidate[] {
  const selected: Candidate[] = [];
  const seen = new Set<string>();
  if (cap < 1) return selected;

  // Parallel uses a distinct two-field search schema (objective + search_queries),
  // so when active it locks routing to Parallel and disables cross-provider fallback.
  if (isParallelLocked(resolution)) {
    const parallel = resolution.available.find(candidate =>
      candidate.family === "parallel" && candidate.adapter.standalone && isUsable(candidate),
    ) ?? (isParallelActive(resolution.preferences.apis) ? dedicatedCandidate("parallel") : undefined);
    if (parallel && isUsable(parallel)) selected.push(parallel);
    return selected;
  }

  // Explicit choices outrank automatic hints, but never restrict fallback or
  // reintroduce an unavailable, unauthenticated, or unsupported candidate.
  if (preferredProvider) {
    const preferred = resolveRef(resolution, { provider: preferredProvider }, isUsable);
    if (preferred && isAuthenticatedCandidate(resolution, preferred)) {
      addUnique(selected, preferred, seen, cap);
    }
  }

  // Configured retrieval APIs precede automatic current/cache hints, but an
  // explicit provider choice above still wins. Health/caps/fallback are shared.
  for (const provider of DEDICATED_PROVIDERS) {
    const dedicated = resolution.available.find(candidate =>
      candidate.model.provider === provider && candidate.adapter.standalone && isUsable(candidate),
    );
    addUnique(selected, dedicated, seen, cap);
  }

  const currentProvider = resolution.currentProvider ?? resolution.current?.model.provider;
  if (currentProvider) {
    // The provider hint survives even if the conversation API is unsupported.
    const preferred = resolveRef(resolution, { provider: currentProvider }, isUsable);
    addUnique(selected, preferred, seen, cap);
  }

  if (!resolution.fresh && cached && isUsable(cached)) {
    // Do not promote a cached sibling ahead of other providers. Siblings from
    // the same provider remain eligible in the later fallback pass.
    const sameProviderSelected = selected.some(
      (candidate) => candidate.model.provider === cached.model.provider,
    );
    if (!sameProviderSelected) addUnique(selected, cached, seen, cap);
  }

  const representedFamilies = new Set(selected.map((candidate) => candidate.family));

  // One interface per family in the fixed adapter order. A family already
  // represented by the current model or the fresh cache hint is not repeated.
  for (const family of PROVIDER_FAMILIES) {
    if (selected.length >= cap) break;
    if (representedFamilies.has(family)) continue;

    const candidates = usableFamilyCandidates(resolution, family, isUsable);
    if (candidates[0] && addUnique(selected, candidates[0], seen, cap)) {
      representedFamilies.add(family);
    }
  }

  // Prefer an interface from each provider before trying sibling models. A
  // single provider may expose many highly ranked models in one family, but a
  // provider-wide failure would make all of them unusable at once. Keep the
  // family round-robin within each pass, then include every remaining sibling.
  const queues = new Map<ProviderFamily, Candidate[]>();
  for (const family of PROVIDER_FAMILIES) {
    const queue = usableFamilyCandidates(resolution, family, isUsable).filter(
      (candidate) => !seen.has(candidateKey(candidate)),
    );
    if (queue.length > 0) queues.set(family, queue);
  }
  const representedProviders = new Set(selected.map((candidate) => candidate.model.provider));
  for (const distinctProvidersOnly of [true, false]) {
    let progressed = true;
    while (selected.length < cap && progressed) {
      progressed = false;
      for (const family of PROVIDER_FAMILIES) {
        if (selected.length >= cap) break;
        const queue = queues.get(family);
        if (!queue) continue;
        const index = distinctProvidersOnly
          ? queue.findIndex((candidate) => !representedProviders.has(candidate.model.provider))
          : 0;
        if (index < 0 || index >= queue.length) continue;
        const [next] = queue.splice(index, 1);
        if (addUnique(selected, next, seen, cap)) {
          representedProviders.add(next.model.provider);
          progressed = true;
        }
      }
    }
  }

  return selected;
}

/** The orchestrator can request all candidates and cap actual attempts instead. */
export function getSearchCandidates(
  resolution: ResolutionContext,
  cap = SEARCH_ATTEMPT_CAP,
): Candidate[] {
  const cached = resolution.fresh
    ? undefined
    : resolveRef(resolution, resolution.cache.search, supportsSearch);
  return buildCandidates(resolution, supportsSearch, cached, cap, resolution.preferences.search);
}

export function getFetchCandidates(
  resolution: ResolutionContext,
  cap = FETCH_ATTEMPT_CAP,
): Candidate[] {
  const cached = resolution.fresh
    ? undefined
    : resolveRef(resolution, resolution.cache.fetch, supportsUrls);
  return buildCandidates(resolution, supportsUrls, cached, cap, resolution.preferences.fetch);
}

export function hasExposedCandidate(resolution: ResolutionContext): boolean {
  if (supportsSearch(resolution.current)) return true;
  return resolution.available.some((candidate) => supportsSearch(candidate));
}

function hasUsableCandidateAuth(resolution: ResolutionContext, candidate: Candidate): boolean {
  try {
    if (resolution.ctx.modelRegistry.hasConfiguredAuth(candidate.model)) return true;
  } catch {
    // A registry failure must not make an unauthenticated model look usable.
  }
  return hasEnvAuth(candidate.model.provider);
}

function isAuthenticatedCandidate(resolution: ResolutionContext, candidate: Candidate): boolean {
  return resolution.available.some((available) => candidateKey(available) === candidateKey(candidate))
    || hasUsableCandidateAuth(resolution, candidate);
}

/** All eligible authenticated providers, without attempt caps or duplicate models. */
export function getSelectableProviders(
  resolution: ResolutionContext,
  phase: "search" | "fetch",
): Candidate[] {
  const candidates = phase === "search"
    ? getSearchCandidates(resolution, Infinity)
    : getFetchCandidates(resolution, Infinity);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const provider = candidate.model.provider;
    if (seen.has(provider) || !isAuthenticatedCandidate(resolution, candidate)) return false;
    seen.add(provider);
    return true;
  });
}

export function hasUrlCandidate(resolution: ResolutionContext): boolean {
  const availableKeys = new Set(resolution.available.map((candidate) => candidateKey(candidate)));
  const seen = new Set<string>();

  const usable = (candidate: Candidate | undefined): boolean => {
    if (!candidate || !supportsUrls(candidate)) return false;
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);

    // Models returned by getAvailable() are already authenticated. A current
    // model outside that set must prove it has registry or environment auth.
    if (availableKeys.has(key)) return true;
    return hasUsableCandidateAuth(resolution, candidate);
  };

  if (usable(resolution.current)) return true;
  return resolution.available.some((candidate) => usable(candidate));
}
