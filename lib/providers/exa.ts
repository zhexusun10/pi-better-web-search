import { dedicatedKey } from "../dedicated-config.ts";
import { redactSecrets } from "../redact.ts";
import { dedicatedRequest } from "./dedicated-http.ts";
import { omitResponseMetadata } from "./response-metadata.ts";
import type { ProviderAdapter } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function statusError(status: Record<string, unknown>, key: string | undefined): string {
  const error = isRecord(status.error) ? status.error : undefined;
  const detail = [status.tag, typeof status.error === "string" ? status.error : undefined, error?.tag, error?.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0).join(": ");
  const message = `Exa contents failed (${String(status.status)})${detail ? `: ${detail}` : ""}`;
  return redactSecrets(message, [key]);
}

/** User-approved search highlights/count and full-text URL extraction, without
 * changing query/urls. Other Exa options remain off. Do not fabricate objective:
 * the official skill expects a model-written value, not a copy of query. */
export const exaAdapter: ProviderAdapter = {
  family: "exa",
  label: "Exa Search",
  standalone: true,
  supportsSearch: true,
  supportsUrls: true,
  async search(_ctx, _model, query, signal) {
    const data = await dedicatedRequest("exa", "https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, numResults: 10, contents: { highlights: true } }),
    }, signal);
    if (!Array.isArray(data.results)) throw new Error("Exa Search returned no results array");
    return omitResponseMetadata(data, ["requestId", "costDollars", "searchTime", "warnings", "resolvedSearchType"]);
  },
  async fetch(_ctx, _model, urls, _query, signal) {
    // Capture the credential before awaiting HTTP; login may rotate it while
    // the response is in flight, including HTTP-200 per-URL error messages.
    const key = dedicatedKey("exa");
    const data = await dedicatedRequest("exa", "https://api.exa.ai/contents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, text: true }),
    }, signal);
    if (!Array.isArray(data.results)) throw new Error("Exa contents returned no results array");
    if (data.statuses !== undefined && !Array.isArray(data.statuses)) {
      throw new Error("Exa contents returned an invalid statuses array");
    }
    const results = data.results.filter(isRecord);
    const statuses = Array.isArray(data.statuses) ? data.statuses.filter(isRecord) : [];
    return {
      entries: urls.map(url => {
        // Prefer the requested identity over a canonical/redirected result URL.
        // Do not pair by array index: failed URLs can be omitted or reordered.
        const result = results.find(item => item.id === url) ?? results.find(item => item.url === url);
        const matchesIdentity = (item: Record<string, unknown>, identity: unknown) =>
          typeof identity === "string" && (item.id === identity || item.url === identity);
        const status = statuses.find(item => matchesIdentity(item, url))
          ?? (result && statuses.find(item => matchesIdentity(item, result.id) || matchesIdentity(item, result.url)));
        if (status && status.status !== "success") return { url, error: statusError(status, key) };
        if (!result || typeof result.text !== "string") return { url, error: "Exa returned no page text for this URL" };
        return { url, data: result };
      }),
    };
  },
};
