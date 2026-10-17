import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { hasEnvAuth } from "./auth.ts";
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
}

export interface ResolutionContext {
  ctx: ExtensionContext;
  current?: Candidate;
  available: Candidate[];
  cache: PreferenceCache;
  fingerprint: string;
  fresh: boolean;
}

/** Search is capped so a bad set of credentials cannot cause an unbounded loop. */
export const SEARCH_ATTEMPT_CAP = 12;
/** Fetch is capped separately; the batch-oriented API needs fewer attempts. */
export const FETCH_ATTEMPT_CAP = 6;

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

const PREFERRED_MODEL_PATTERNS: Record<ProviderFamily, RegExp> = {
  deepseek: /deepseek/i,
  ollama: /gpt-oss|qwen|llama|deepseek|mistral/i,
  google: /gemini/i,
  openai: /gpt-5|gpt-4\.1|gpt-4o|o[134]/i,
  xai: /grok/i,
  anthropic: /claude/i,
};

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
  const current = candidateForModel(model ?? ctx.model);
  const available: Candidate[] = [];
  const seen = new Set<string>();

  for (const availableModel of availableModels(ctx)) {
    const candidate = candidateForModel(availableModel);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    available.push(candidate);
  }

  const cache = readCache();
  const fingerprint = fingerprintAvailableModels(ctx);
  return {
    ctx,
    ...(current ? { current } : {}),
    available,
    cache,
    fingerprint,
    fresh: isFreshDiscovery(cache, fingerprint),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function modelRank(candidate: Candidate): number {
  return PREFERRED_MODEL_PATTERNS[candidate.family].test(candidate.model.id) ? 0 : 1;
}

/** Rank candidates inside one family independently of registry order. */
export function rankFamilyCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (left, right) =>
      modelRank(left) - modelRank(right)
      || compareText(candidateKey(left), candidateKey(right))
      || compareText(left.model.baseUrl ?? "", right.model.baseUrl ?? ""),
  );
}

function supportsSearch(candidate: Candidate | undefined): candidate is Candidate {
  return !!candidate?.adapter.supportsSearch;
}

function supportsUrls(candidate: Candidate | undefined): candidate is Candidate {
  return !!candidate?.adapter.supportsUrls && typeof candidate.adapter.fetch === "function";
}

function resolveRef(
  resolution: ResolutionContext,
  ref: ProviderRef | undefined,
  usable: (candidate: Candidate) => boolean,
): Candidate | undefined {
  if (!ref) return undefined;

  const exactKey = `${ref.provider}/${ref.model}`;
  const exact = resolution.available.find((candidate) => candidateKey(candidate) === exactKey);
  if (exact && usable(exact)) return exact;

  const sameProvider = resolution.available
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

function buildCandidates(
  resolution: ResolutionContext,
  isUsable: (candidate: Candidate) => boolean,
  cached: Candidate | undefined,
  cap: number,
): Candidate[] {
  const selected: Candidate[] = [];
  const seen = new Set<string>();

  if (resolution.current && isUsable(resolution.current)) {
    addUnique(selected, resolution.current, seen, cap);
  }

  if (!resolution.fresh && cached && isUsable(cached)) {
    // Never repeat the same provider id after the current model failed. A
    // cached hint is only useful when it points at a different interface.
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

    const candidates = rankFamilyCandidates(
      resolution.available.filter((candidate) => candidate.family === family && isUsable(candidate)),
    );
    if (candidates[0] && addUnique(selected, candidates[0], seen, cap)) {
      representedFamilies.add(family);
    }
  }

  // Fill any remaining attempts with other available provider interfaces. A
  // provider id is never retried with a different model, and the fixed family
  // priority above still determines which interface comes first.
  for (const candidate of resolution.available) {
    if (selected.length >= cap) break;
    if (!isUsable(candidate)) continue;
    if (seen.has(candidateKey(candidate))) continue;
    if (selected.some((entry) => entry.model.provider === candidate.model.provider)) continue;
    addUnique(selected, candidate, seen, cap);
  }

  return selected;
}

export function getSearchCandidates(resolution: ResolutionContext): Candidate[] {
  const cached = resolution.fresh
    ? undefined
    : resolveRef(resolution, resolution.cache.search, supportsSearch);
  return buildCandidates(resolution, supportsSearch, cached, SEARCH_ATTEMPT_CAP);
}

export function getFetchCandidates(resolution: ResolutionContext): Candidate[] {
  const cached = resolution.fresh
    ? undefined
    : resolveRef(resolution, resolution.cache.fetch, supportsUrls);
  return buildCandidates(resolution, supportsUrls, cached, FETCH_ATTEMPT_CAP);
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
