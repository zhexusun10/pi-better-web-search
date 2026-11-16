import { dedicatedRequest } from "./dedicated-http.ts";
import { omitResponseMetadata } from "./response-metadata.ts";
import type { ProviderAdapter } from "./types.ts";

/** Raw Search API only. No Agent API, inference model, fetch, or effort setting. */
export const perplexityAdapter: ProviderAdapter = {
  family: "perplexity",
  label: "Perplexity Search",
  standalone: true,
  supportsSearch: true,
  supportsUrls: false,
  async search(_ctx, _model, query, signal) {
    const data = await dedicatedRequest("perplexity", "https://api.perplexity.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, search_type: "web", max_results: 10 }),
    }, signal);
    if (!Array.isArray(data.results)) throw new Error("Perplexity Search returned no results array");
    return omitResponseMetadata(data, ["id"]);
  },
};
