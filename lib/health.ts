import type { Candidate } from "./candidates.ts";

const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;
const MAX_FAILURE_COOLDOWN_MS = 10 * 60_000;

export type ProviderPhase = "search" | "fetch";

/** Separate standalone API health from same-named model-provider health. */
export function candidateHealthProvider(candidate: Candidate): string {
  return candidate.model.api === "dedicated-web-search"
    ? `${candidate.model.provider}\0dedicated`
    : candidate.model.provider;
}

interface ProviderFailure {
  provider: string;
  phase: ProviderPhase;
  message: string;
  consecutiveFailures: number;
  retryAt: number;
}

const failures = new Map<string, ProviderFailure>();

function providerFailureKey(phase: ProviderPhase, provider: string): string {
  return `${phase}:provider:${provider}`;
}

function modelFailureKey(phase: ProviderPhase, provider: string, model: string): string {
  return `${phase}:model:${provider}/${model}`;
}

function failureCooldownMs(): number {
  const configured = Math.floor(Number(process.env.PI_BETTER_WEB_SEARCH_FAILURE_COOLDOWN_MS));
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_FAILURE_COOLDOWN_MS;
}

/**
 * Remember a provider-wide or model-specific failure so later calls do not
 * immediately repeat it. Search and fetch are tracked separately because their
 * endpoints can fail independently. The cooldown grows on consecutive failures
 * and only applies while another candidate is available; see
 * prioritizeCandidates.
 */
function recordFailure(
  key: string,
  phase: ProviderPhase,
  provider: string,
  message: string,
  now: number,
  attemptStartedAt: number,
): void {
  const previous = failures.get(key);
  const base = failureCooldownMs();
  if (base === 0) {
    failures.delete(key);
    return;
  }
  // In-flight calls, or last-resort attempts started before expiry, are not a
  // new probe even when they finish after the previous cooldown has expired.
  if (previous && (previous.retryAt > now || attemptStartedAt < previous.retryAt)) return;
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const exponent = Math.min(consecutiveFailures - 1, 10);
  const cooldown = Math.min(base * 2 ** exponent, MAX_FAILURE_COOLDOWN_MS);
  failures.set(key, {
    provider,
    phase,
    message,
    consecutiveFailures,
    retryAt: now + cooldown,
  });
}

export function recordProviderFailure(
  phase: ProviderPhase,
  provider: string,
  message: string,
  now = Date.now(),
  attemptStartedAt = now,
): void {
  recordFailure(providerFailureKey(phase, provider), phase, provider, message, now, attemptStartedAt);
}

/** Remember a single model failure without cooling down its whole provider. */
export function recordModelFailure(
  phase: ProviderPhase,
  provider: string,
  model: string,
  message: string,
  now = Date.now(),
  attemptStartedAt = now,
): void {
  recordFailure(modelFailureKey(phase, provider, model), phase, provider, message, now, attemptStartedAt);
}

export function clearProviderFailure(phase: ProviderPhase, provider: string): void {
  failures.delete(providerFailureKey(phase, provider));
}

export function clearModelFailure(phase: ProviderPhase, provider: string, model: string): void {
  failures.delete(modelFailureKey(phase, provider, model));
}

export function isProviderCoolingDown(
  phase: ProviderPhase,
  provider: string,
  now = Date.now(),
): boolean {
  if (failureCooldownMs() === 0) return false;
  const failure = failures.get(providerFailureKey(phase, provider));
  return !!failure && failure.retryAt > now;
}

export function isModelCoolingDown(
  phase: ProviderPhase,
  provider: string,
  model: string,
  now = Date.now(),
): boolean {
  if (failureCooldownMs() === 0) return false;
  const failure = failures.get(modelFailureKey(phase, provider, model));
  return !!failure && failure.retryAt > now;
}

export function getProviderFailure(
  phase: ProviderPhase,
  provider: string,
): ProviderFailure | undefined {
  const failure = failures.get(providerFailureKey(phase, provider));
  return failure ? { ...failure } : undefined;
}

/**
 * Keep the explicit preference and standalone APIs ahead of model routes.
 * Among the remaining model routes, move recent failures behind healthy ones;
 * cooled candidates remain available as a last resort.
 */
export function prioritizeCandidates(
  phase: ProviderPhase,
  candidates: Candidate[],
  now = Date.now(),
  preferredProvider?: string,
): Candidate[] {
  // An explicit preference and configured standalone APIs are strict routing
  // priorities; health reordering only applies to the remaining model routes.
  const first = candidates[0]?.model.provider === preferredProvider ? candidates[0] : undefined;
  const dedicated = candidates.filter(candidate => candidate !== first && candidate.model.api === "dedicated-web-search");
  const healthy: Candidate[] = [];
  const cooling: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate === first || dedicated.includes(candidate)) continue;
    const provider = candidate.model.provider;
    const model = candidate.model.id;
    if (
      isProviderCoolingDown(phase, provider, now)
      || isModelCoolingDown(phase, provider, model, now)
    ) {
      cooling.push(candidate);
    } else {
      healthy.push(candidate);
    }
  }
  return [...(first ? [first] : []), ...dedicated, ...healthy, ...cooling];
}

/** A newly logged-in credential should not inherit the previous key's failures. */
export function clearProviderHealth(provider: string): void {
  for (const [key, failure] of failures) {
    if (failure.provider === provider || failure.provider === `${provider}\0dedicated`) failures.delete(key);
  }
}

/** Test helper: health state is process-local and must not leak across tests. */
export function resetProviderFailures(): void {
  failures.clear();
}
