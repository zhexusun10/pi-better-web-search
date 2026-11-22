import { savedApiKey } from "./credentials.ts";
import { redactSecrets } from "./redact.ts";

/** Standalone retrieval services, not conversation model providers. */
export const DEDICATED_PROVIDERS = ["parallel", "keenable", "exa", "perplexity", "deepseek"] as const;
export type DedicatedProvider = typeof DEDICATED_PROVIDERS[number];
export type DedicatedSettings = Partial<Record<DedicatedProvider, boolean>> & {
  /** Login did not consent to anonymous access if the saved key disappears. */
  keenableKeyRequired?: boolean;
};

export const DEDICATED_INFO = {
  parallel: { name: "Parallel Search", env: "PARALLEL_API_KEY", setup: "https://platform.parallel.ai", baseUrl: "https://api.parallel.ai", fetch: true },
  deepseek: { name: "DeepSeek Search/Fetch", env: "DEEPSEEK_API_KEY", setup: "https://platform.deepseek.com/api_keys", baseUrl: "https://api.deepseek.com", fetch: true },
  perplexity: { name: "Perplexity Search", env: "PERPLEXITY_API_KEY", setup: "https://console.perplexity.ai", baseUrl: "https://api.perplexity.ai", fetch: false },
  keenable: { name: "Keenable", env: "KEENABLE_API_KEY", setup: "https://docs.keenable.ai/api-keys", baseUrl: "https://api.keenable.ai", fetch: true },
  exa: { name: "Exa Search", env: "EXA_API_KEY", setup: "https://dashboard.exa.ai/api-keys", baseUrl: "https://api.exa.ai", fetch: true },
} as const;

export function dedicatedKey(provider: DedicatedProvider): string | undefined {
  return savedApiKey(provider) || process.env[DEDICATED_INFO[provider].env]?.trim() || undefined;
}

/** Protect agent-visible error messages, including native DeepSeek errors. */
export function redactDedicatedSecrets(message: string): string {
  return redactSecrets(message, DEDICATED_PROVIDERS.flatMap(provider => [
    savedApiKey(provider), process.env[DEDICATED_INFO[provider].env]?.trim(),
  ]));
}

export function dedicatedState(provider: DedicatedProvider, settings: DedicatedSettings = {}) {
  const saved = !!savedApiKey(provider);
  const hasKey = saved || !!process.env[DEDICATED_INFO[provider].env]?.trim();
  const keySource = saved ? "saved" : hasKey ? "environment" : undefined;
  const enabled = settings[provider] ?? hasKey;
  const keyless = provider === "keenable" && !hasKey && !settings.keenableKeyRequired;
  return { enabled, hasKey, keySource, available: enabled && (hasKey || keyless), keyless };
}

export function isParallelActive(settings: DedicatedSettings = {}): boolean {
  return dedicatedState("parallel", settings).available;
}

export function configuredDedicatedProviders(settings: DedicatedSettings = {}): DedicatedProvider[] {
  return DEDICATED_PROVIDERS.filter(provider => dedicatedState(provider, settings).available);
}

/** Identity/auth mode only; no credentials or credential hashes are persisted. */
export function dedicatedFingerprintEntries(settings: DedicatedSettings = {}): string[] {
  return configuredDedicatedProviders(settings).map(provider =>
    `retrieval:${provider}:${dedicatedState(provider, settings).keyless ? "public" : dedicatedState(provider, settings).keySource}`,
  );
}

export function copyDedicatedSettings(value: unknown): DedicatedSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: DedicatedSettings = {};
  for (const provider of DEDICATED_PROVIDERS) {
    if (source[provider] !== undefined && typeof source[provider] !== "boolean") return undefined;
    if (typeof source[provider] === "boolean") result[provider] = source[provider];
  }
  if (source.keenableKeyRequired !== undefined && typeof source.keenableKeyRequired !== "boolean") return undefined;
  if (typeof source.keenableKeyRequired === "boolean") result.keenableKeyRequired = source.keenableKeyRequired;
  return result;
}
