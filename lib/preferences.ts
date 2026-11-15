import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { copyDedicatedSettings, type DedicatedSettings } from "./dedicated-config.ts";

/** Explicit user choices, separate from the automatically learned success cache. */
export interface ProviderPreferences {
  version: 1;
  search?: string;
  fetch?: string;
  apis?: DedicatedSettings;
}

export function getPreferencesPath(): string {
  return process.env.PI_BETTER_WEB_SEARCH_SETTINGS || join(getAgentDir(), "better-web-search-settings.json");
}

function isProvider(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Missing or invalid settings must not prevent automatic routing. */
export function readProviderPreferences(): ProviderPreferences {
  const empty: ProviderPreferences = { version: 1 };
  try {
    const value: unknown = JSON.parse(readFileSync(getPreferencesPath(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const settings = value as Record<string, unknown>;
    if (settings.version !== 1) return empty;
    if (settings.search !== undefined && !isProvider(settings.search)) return empty;
    if (settings.fetch !== undefined && !isProvider(settings.fetch)) return empty;
    const apis = copyDedicatedSettings(settings.apis);
    if (settings.apis !== undefined && !apis) return empty;
    return {
      version: 1,
      ...(isProvider(settings.search) ? { search: settings.search } : {}),
      ...(isProvider(settings.fetch) ? { fetch: settings.fetch } : {}),
      ...(apis && Object.keys(apis).length ? { apis } : {}),
    };
  } catch {
    return empty;
  }
}

/** Store only provider ids and API toggles, never credentials or cache entries. */
export function writeProviderPreferences(preferences: ProviderPreferences): boolean {
  try {
    const path = getPreferencesPath();
    const apis = copyDedicatedSettings(preferences.apis);
    if (preferences.apis !== undefined && !apis) return false;
    const persisted: ProviderPreferences = {
      version: 1,
      ...(isProvider(preferences.search) ? { search: preferences.search } : {}),
      ...(isProvider(preferences.fetch) ? { fetch: preferences.fetch } : {}),
      ...(apis && Object.keys(apis).length ? { apis } : {}),
    };
    return writeFileAtomically(path, `${JSON.stringify(persisted, null, 2)}\n`);
  } catch {
    return false;
  }
}
