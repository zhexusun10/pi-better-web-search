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

/**
 * Cheapest-first capability tiers per family, ordered small to large. The
 * first matching tier wins and ids that match no tier rank last, so fallback
 * does not burn a large model when a small one is available. Version numbers
 * are compared separately, newest first. Only families whose provider uses
 * tier names need an entry; everywhere else every model shares tier 0.
 */
function tierMatcher(name: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])${name}(?:$|[^a-z0-9])`, "i");
}

const MODEL_TIERS: Partial<Record<ProviderFamily, readonly RegExp[]>> = {
  openai: ["luna", "sol", "astra"].map(tierMatcher),
  anthropic: ["haiku", "sonnet", "opus", "fable"].map(tierMatcher),
};

function modelTier(candidate: Candidate): number {
  const patterns = MODEL_TIERS[candidate.family];
  if (!patterns) return 0;
  for (let index = 0; index < patterns.length; index += 1) {
    if (patterns[index].test(candidate.model.id)) return index;
  }
  return patterns.length;
}

/**
 * Parse the first version-like run in a model id into a numeric tuple.
 * `gpt-6.1` -> [6, 1], `claude-opus-4-5` -> [4, 5], `gpt-oss:120b` -> [120].
 * Ids without a number return an empty tuple and rank below versioned ones.
 */
function versionTuple(id: string): number[] {
  const match = id.match(/\d+(?:[.-]\d+)*/);
  if (!match) return [];
  return match[0].split(/[.-]/).map((part) => Number.parseInt(part, 10));
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

/** Rank candidates inside one family independently of registry order. */
export function rankFamilyCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (left, right) =>
      modelTier(left) - modelTier(right)
      || compareVersionsDesc(versionTuple(left.model.id), versionTuple(right.model.id))
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

function usableFamilyCandidates(
  resolution: ResolutionContext,
  family: ProviderFamily,
  isUsable: (candidate: Candidate) => boolean,
): Candidate[] {
  return rankFamilyCandidates(
    resolution.available.filter((candidate) => candidate.family === family && isUsable(candidate)),
  );
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

    const candidates = usableFamilyCandidates(resolution, family, isUsable);
    if (candidates[0] && addUnique(selected, candidates[0], seen, cap)) {
      representedFamilies.add(family);
    }
  }

  // Deeper fallback: alternate models from providers other than the current
  // model's provider. Providers frequently reject one specific model (legacy
  // IDs, account tiers, regional availability) while serving a sibling, so a
  // single interface per family is too fragile. Round-robin across families so
  // every family gets a second chance before any family gets a third, keeping
  // the broad cross-provider coverage that the one-per-family pass provides.
  //
  // Only the current model's provider id is excluded: a different provider id
  // in the same family (for example `openai` vs `openai-codex`, or `anthropic`
  // vs `opencode-go`) has its own credentials and endpoint and is still worth
  // trying. This mirrors the original "never repeat a provider id" rule while
  // still allowing sibling models of a fallback provider.
  const currentProvider = resolution.current?.model.provider;
  const queues = new Map<ProviderFamily, Candidate[]>();
  for (const family of PROVIDER_FAMILIES) {
    const queue = usableFamilyCandidates(resolution, family, isUsable).filter(
      (candidate) =>
        candidate.model.provider !== currentProvider
        && !seen.has(candidateKey(candidate)),
    );
    if (queue.length > 0) queues.set(family, queue);
  }

  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (const family of PROVIDER_FAMILIES) {
      if (selected.length >= cap) break;
      const queue = queues.get(family);
      const next = queue?.shift();
      if (next && addUnique(selected, next, seen, cap)) progressed = true;
    }
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
