import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChatModel } from "./families.ts";

export interface ProviderRef {
  provider: string;
  model: string;
}

export interface PreferenceCache {
  version: 1;
  fingerprint?: string;
  search?: ProviderRef;
  fetch?: ProviderRef;
}

export function getCachePath(): string {
  return process.env.PI_BETTER_WEB_SEARCH_CACHE || join(getAgentDir(), "better-web-search.json");
}

function isProviderRef(value: unknown): value is ProviderRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.provider === "string"
    && ref.provider.length > 0
    && typeof ref.model === "string"
    && ref.model.length > 0;
}

function copyProviderRef(value: unknown): ProviderRef | undefined {
  return isProviderRef(value)
    ? { provider: value.provider, model: value.model }
    : undefined;
}

/**
 * Read the preference cache. Missing, unreadable, corrupt, or structurally
 * invalid files all produce an empty cache instead of failing a tool call.
 */
export function readCache(): PreferenceCache {
  const fallback: PreferenceCache = { version: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getCachePath(), "utf8"));
  } catch {
    return fallback;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1) return fallback;
  if (candidate.fingerprint !== undefined && typeof candidate.fingerprint !== "string") return fallback;
  const search = copyProviderRef(candidate.search);
  const fetch = copyProviderRef(candidate.fetch);
  if (candidate.search !== undefined && !search) return fallback;
  if (candidate.fetch !== undefined && !fetch) return fallback;

  return {
    version: 1,
    ...(typeof candidate.fingerprint === "string" ? { fingerprint: candidate.fingerprint } : {}),
    ...(search ? { search } : {}),
    ...(fetch ? { fetch } : {}),
  };
}

/** Persist the preference cache. Never throws to the caller. */
export function writeCache(cache: PreferenceCache): boolean {
  try {
    const path = getCachePath();
    const search = copyProviderRef(cache.search);
    const fetch = copyProviderRef(cache.fetch);
    // Serialize only the documented fields so credentials or future non-cache
    // properties can never leak into the preference file.
    const persisted: PreferenceCache = {
      version: 1,
      ...(typeof cache.fingerprint === "string" ? { fingerprint: cache.fingerprint } : {}),
      ...(search ? { search } : {}),
      ...(fetch ? { fetch } : {}),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Fingerprint the currently authenticated chat models. Adding or removing a
 * login/API key changes the available set, which invalidates cached choices.
 */
export function fingerprintAvailableModels(ctx: ExtensionContext): string {
  let models: ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]> = [];
  try {
    const available = ctx.modelRegistry.getAvailable();
    models = Array.isArray(available) ? available : [];
  } catch {
    models = [];
  }

  const entries = models
    .filter((model) => isChatModel(model))
    .map((model) => `${model.provider}/${model.id}@${model.baseUrl}`)
    .sort();

  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 32);
}

export function isFreshDiscovery(cache: PreferenceCache, fingerprint: string): boolean {
  return cache.fingerprint !== fingerprint;
}
