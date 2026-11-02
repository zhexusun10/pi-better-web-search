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
 * first matching tier wins and ids that match no tier rank last. Tiers are a
 * tiebreaker only after version comparison, so a newer model is not skipped
 * just because its tier name is new or unknown. Only families whose provider
 * uses tier names need an entry; everywhere else every model shares tier 0.
 */
function tierMatcher(name: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])${name}(?:$|[^a-z0-9])`, "i");
}

const MODEL_TIERS: Partial<Record<ProviderFamily, readonly RegExp[]>> = {
  openai: ["luna", "terra", "sol", "astra"].map(tierMatcher),
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
 * Brand order among models that already support an adapter in the same family.
 * A custom Responses gateway may expose several brands; OpenAI and Claude keep
 * their named-tier ordering while other brands use flash / base / pro ordering.
 * This ranking does not make an unsupported model API search-capable.
 */
function modelBrandRank(id: string): number {
  const normalized = id.toLowerCase();
  if (/^deepseek(?:[-_.:]|$)/.test(normalized)) return 0;
  if (/^(?:gpt|chatgpt|codex)(?:[-_.:]|$)/.test(normalized) || /^o\d/.test(normalized)) return 1;
  if (/^claude(?:[-_.:]|$)/.test(normalized)) return 2;
  if (/^(?:gemini|gemma)(?:[-_.:]|$)/.test(normalized)) return 3;
  return 4;
}

function modelVariantRank(id: string): number {
  const normalized = id.toLowerCase();
  if (/(?:^|[-_.])flash(?:$|[-_.])/.test(normalized)) return 0;
  if (/(?:^|[-_.])pro(?:$|[-_.])/.test(normalized)) return 2;
  return 1;
}

function usesVariantOrdering(brand: number): boolean {
  return brand !== 1 && brand !== 2;
}

/**
 * Parse the model version, not a date suffix or parameter count. The version
 * prefix depends on the family: `gpt-6.1-terra` -> [6, 1], `o3-mini` -> [3],
 * `claude-opus-4-5-20251101` -> [4, 5], `gemini-3.8-flash` -> [3, 8].
 * Ids without a recognizable version return an empty tuple and rank below
 * versioned models.
 */
function versionTuple(id: string, family: ProviderFamily): number[] {
  const normalized = id.toLowerCase();
  let match: RegExpMatchArray | null = null;

  if (family === "openai") {
    match = normalized.match(/^(?:gpt|o)[-_ ]?(\d+(?:\.\d+)*)/);
  } else if (family === "anthropic") {
    // A date can immediately follow a major version, e.g.
    // claude-sonnet-4-20250514. Do not interpret it as a minor version.
    match = normalized.match(/^claude-(?:haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?/)
      ?? normalized.match(/^claude-(\d+)(?:-(\d+))?/);
    if (match) {
      const minor = match[2];
      return [Number(match[1]), minor && minor.length < 8 ? Number(minor) : 0];
    }
  } else if (family === "google") {
    match = normalized.match(/^(?:gemini|gemma)[-_]?(\d+(?:\.\d+)*)/);
    if (!match) return [];
  } else if (family === "xai") {
    match = normalized.match(/^grok[-_]?(\d+(?:\.\d+)*)/);
  } else if (family === "deepseek") {
    match = normalized.match(/^deepseek[-_]?v?(\d+(?:\.\d+)*)/);
  }

  if (match) return match[1].split(".").map((part) => Number.parseInt(part, 10));

  // Generic fallback for custom models. Only dot-separated numbers count so
  // date suffixes such as `...-10-2025` do not look like a newer version.
  const generic = normalized.match(/\d+(?:\.\d+)*/);
  return generic ? generic[0].split(".").map((part) => Number.parseInt(part, 10)) : [];
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

/**
 * Rank candidates inside one family independently of registry order. Brand
 * order comes first (DeepSeek before OpenAI inside a gateway), then the
 * flash / base / pro variant order for non-tiered brands, then the version
 * number. Capability tier is a final tiebreaker for GPT and Claude models.
 */
export function rankFamilyCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    const leftBrand = modelBrandRank(left.model.id);
    const rightBrand = modelBrandRank(right.model.id);
    const brandOrder = leftBrand - rightBrand;
    if (brandOrder !== 0) return brandOrder;

    if (usesVariantOrdering(leftBrand)) {
      const variantOrder = modelVariantRank(left.model.id) - modelVariantRank(right.model.id);
      if (variantOrder !== 0) return variantOrder;
    }

    return compareVersionsDesc(
      versionTuple(left.model.id, left.family),
      versionTuple(right.model.id, right.family),
    )
      || modelTier(left) - modelTier(right)
      || compareText(candidateKey(left), candidateKey(right))
      || compareText(left.model.baseUrl ?? "", right.model.baseUrl ?? "");
  });
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
  return buildCandidates(resolution, supportsSearch, cached, cap);
}

export function getFetchCandidates(
  resolution: ResolutionContext,
  cap = FETCH_ATTEMPT_CAP,
): Candidate[] {
  const cached = resolution.fresh
    ? undefined
    : resolveRef(resolution, resolution.cache.fetch, supportsUrls);
  return buildCandidates(resolution, supportsUrls, cached, cap);
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
