import { readProviderPreferences } from "../preferences.ts";
import { dedicatedRequest } from "./dedicated-http.ts";
import { errorMessage, HttpError, isAbortError } from "./http.ts";
import type { ProviderAdapter, ProviderFetchEntry } from "./types.ts";

function endpoint(operation: "search" | "fetch", hasKey: boolean): string {
  // Discovery can precede several awaited requests. Recheck current consent so
  // key loss/logout during a call never silently downgrades to public access.
  const settings = readProviderPreferences().apis;
  if (settings?.keenable === false) throw new Error("Keenable is disabled in API settings.");
  if (!hasKey && (settings?.keenable !== true || settings.keenableKeyRequired)) {
    throw new Error("Keenable API key is unavailable and public/keyless access is not authorized. Use /pi-better-web-search login or explicitly enable public access with /web-search-api keenable.");
  }
  return `https://api.keenable.ai/v1/${operation}${hasKey ? "" : "/public"}`;
}

export const keenableAdapter: ProviderAdapter = {
  family: "keenable",
  label: "Keenable",
  standalone: true,
  supportsSearch: true,
  supportsUrls: true,
  async search(_ctx, _model, query, signal) {
    const data = await dedicatedRequest("keenable", hasKey => endpoint("search", hasKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, mode: "pro", max_results: 10 }),
    }, signal);
    if (!Array.isArray(data.results)) throw new Error("Keenable returned no results array");
    return data;
  },
  async fetch(_ctx, _model, urls, _query, signal) {
    const entries: ProviderFetchEntry[] = [];
    for (const url of urls) {
      try {
        const data = await dedicatedRequest("keenable", hasKey => {
          const target = new URL(endpoint("fetch", hasKey));
          target.searchParams.set("url", url);
          target.searchParams.set("live", "true");
          return target;
        }, { method: "GET" }, signal);
        if (typeof data.content !== "string" || typeof data.url !== "string") {
          entries.push({ url, error: "Keenable returned no URL or page content" });
        } else {
          entries.push({ url, data });
        }
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        const message = errorMessage(error);
        entries.push({ url, error: message });
        // Target failures must not cool down the API or discard earlier pages.
        const targetError = error instanceof HttpError && (
          [400, 404, 422].includes(error.status)
          || (error.status === 403 && ["target_blocked", "private_url_not_allowed"].includes(error.code ?? ""))
        );
        if (!targetError) return { entries, providerError: message };
      }
    }
    return { entries };
  },
};
