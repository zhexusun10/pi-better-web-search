import { dedicatedKey } from "../dedicated-config.ts";
import { redactSecrets } from "../redact.ts";
import { dedicatedRequest } from "./dedicated-http.ts";
import { omitResponseMetadata } from "./response-metadata.ts";
import type { ProviderAdapter } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripTrailingRootSlash(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.pathname === "/" && !parsed.search && !parsed.hash && value.endsWith("/")
      ? value.slice(0, -1)
      : value;
  } catch {
    return value;
  }
}

function findByUrl(items: Record<string, unknown>[], url: string): Record<string, unknown> | undefined {
  return items.find(item => item.url === url)
    ?? items.find(item => typeof item.url === "string" && stripTrailingRootSlash(item.url) === stripTrailingRootSlash(url));
}

function extractError(error: Record<string, unknown>, key: string | undefined): string {
  const type = typeof error.error_type === "string" && error.error_type.length > 0
    ? error.error_type
    : "extract_error";
  const status = typeof error.http_status_code === "number" ? `, HTTP ${error.http_status_code}` : "";
  const content = typeof error.content === "string" && error.content.trim().length > 0
    ? `: ${error.content.trim()}`
    : "";
  return redactSecrets(`Parallel Extract failed (${type}${status})${content}`, [key]);
}

/**
 * Parallel Web Systems Search (/v1/search) and Extract (/v1/extract).
 * Search mode is fixed to "advanced" and requires both objective and
 * search_queries. While Parallel is active, the tool schema uses Parallel's
 * official descriptions, routing is locked to Parallel, and cross-provider
 * fallback is disabled.
 */
export const parallelAdapter: ProviderAdapter = {
  family: "parallel",
  label: "Parallel Search",
  standalone: true,
  supportsSearch: true,
  supportsUrls: true,
  async search(_ctx, _model, query, signal, _onUpdate, searchQueries) {
    const objective = query.trim();
    const queries = (searchQueries ?? (objective ? [objective] : []))
      .map(item => item.trim())
      .filter(Boolean);
    if (!objective || queries.length === 0) {
      throw new Error('Parallel Search requires both "objective" and "search_queries"');
    }
    const data = await dedicatedRequest("parallel", "https://api.parallel.ai/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "advanced",
        objective,
        search_queries: queries,
      }),
    }, signal);
    if (!Array.isArray(data.results)) throw new Error("Parallel Search returned no results array");
    return omitResponseMetadata(data, ["search_id", "usage", "warnings", "session_id", "metadata"]);
  },
  async fetch(_ctx, _model, urls, query, signal) {
    // Capture the credential before awaiting HTTP; login may rotate it while
    // the response is in flight, including HTTP-200 per-URL error messages.
    const key = dedicatedKey("parallel");
    const objective = typeof query === "string" && query.trim().length > 0 ? query.trim() : undefined;
    const data = await dedicatedRequest("parallel", "https://api.parallel.ai/v1/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls,
        ...(objective ? { objective } : {}),
      }),
    }, signal);
    if (!Array.isArray(data.results)) throw new Error("Parallel Extract returned no results array");
    if (data.errors !== undefined && !Array.isArray(data.errors)) {
      throw new Error("Parallel Extract returned an invalid errors array");
    }
    const results = data.results.filter(isRecord);
    const errors = Array.isArray(data.errors) ? data.errors.filter(isRecord) : [];
    return {
      entries: urls.map(url => {
        const failure = findByUrl(errors, url);
        if (failure) return { url, error: extractError(failure, key) };
        const result = findByUrl(results, url);
        if (!result || (!Array.isArray(result.excerpts) && typeof result.full_content !== "string")) {
          return { url, error: "Parallel Extract returned no page content for this URL" };
        }
        return { url, data: result };
      }),
    };
  },
};
