#!/usr/bin/env node
/** Opt-in smoke test. Prints HTTP status/response shape only; never credentials.
 * npm run test:live:search-apis -- [perplexity|keenable|exa|parallel|all]
 * Keenable uses public endpoints without a key. Only public example queries/URLs.
 */
import { dedicatedKey } from "../lib/dedicated-config.ts";
import { dedicatedRequest } from "../lib/providers/dedicated-http.ts";
import { HttpError } from "../lib/providers/http.ts";

const selection = process.argv[2] || "all";
if (!["all", "perplexity", "keenable", "exa", "parallel"].includes(selection)) {
  console.error("Usage: npm run test:live:search-apis -- [perplexity|keenable|exa|parallel|all]");
  process.exit(1);
}

let status;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  status = response.status;
  return response;
};

async function probe(provider, operation, url, body) {
  status = undefined;
  try {
    const data = await dedicatedRequest(provider, url, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : { method: "GET" }, AbortSignal.timeout(30000));
    const exaFetch = provider === "exa" && operation === "fetch";
    const parallelFetch = provider === "parallel" && operation === "fetch";
    const results = Array.isArray(data.results) ? data.results : [];
    const failedUrls = exaFetch
      ? (Array.isArray(data.statuses) ? data.statuses.filter(item => item?.status !== "success").length : 0)
      : parallelFetch
        ? (Array.isArray(data.errors) ? data.errors.length : 0)
        : 0;
    const valid = exaFetch ? results.some(item => typeof item?.text === "string") && failedUrls === 0
      : parallelFetch ? results.some(item => Array.isArray(item?.excerpts)) && failedUrls === 0
      : operation === "search" ? Array.isArray(data.results)
      : typeof data.url === "string" && typeof data.content === "string";
    console.log(JSON.stringify({ provider, operation, status, shape: operation === "search" || exaFetch || parallelFetch
      ? { results: Array.isArray(data.results) ? "array" : typeof data.results, count: results.length,
          ...(exaFetch ? { textPages: results.filter(item => typeof item?.text === "string").length, failedUrls } : {}),
          ...(parallelFetch ? { excerptPages: results.filter(item => Array.isArray(item?.excerpts)).length, failedUrls } : {}) }
      : { url: typeof data.url, content: typeof data.content } }));
    if (status !== 200 || !valid) process.exitCode = 1;
    return status === 200 && valid;
  } catch (error) {
    // Never dump request options, headers, bodies or arbitrary server messages.
    console.log(JSON.stringify({ provider, operation, status: error instanceof HttpError ? error.status : status ?? "network-error" }));
    process.exitCode = 1;
    return false;
  }
}

try {
  if (selection === "all" || selection === "perplexity") {
    if (!dedicatedKey("perplexity")) {
      console.log("SKIP Perplexity: no saved key or PERPLEXITY_API_KEY. Create a key at https://console.perplexity.ai and use /pi-better-web-search login in pi's terminal; never paste it into chat.");
      if (selection === "perplexity") process.exitCode = 1;
    } else {
      await probe("perplexity", "search", "https://api.perplexity.ai/search", { query: "TypeScript documentation", search_type: "web", max_results: 1 });
    }
  }
  if (selection === "all" || selection === "exa") {
    if (!dedicatedKey("exa")) {
      console.log("SKIP Exa: no saved key or EXA_API_KEY. Create a key at https://dashboard.exa.ai/api-keys and use /pi-better-web-search login in pi's terminal; never paste it into chat.");
      if (selection === "exa") process.exitCode = 1;
    } else {
      const ok = await probe("exa", "search", "https://api.exa.ai/search", {
        query: "TypeScript documentation", numResults: 10, contents: { highlights: true },
      });
      if (ok) await probe("exa", "fetch", "https://api.exa.ai/contents", { urls: ["https://example.com"], text: true });
    }
  }
  if (selection === "all" || selection === "keenable") {
    const suffix = dedicatedKey("keenable") ? "" : "/public";
    const ok = await probe("keenable", "search", `https://api.keenable.ai/v1/search${suffix}`, { query: "TypeScript documentation", mode: "pro", max_results: 3 });
    // On 429/402/etc. stop this provider; do not retry or spend another request.
    if (ok) {
      const target = new URL(`https://api.keenable.ai/v1/fetch${suffix}`);
      target.searchParams.set("url", "https://example.com");
      target.searchParams.set("live", "true");
      await probe("keenable", "fetch", target);
    }
  }
  if (selection === "all" || selection === "parallel") {
    if (!dedicatedKey("parallel")) {
      console.log("SKIP Parallel: no saved key or PARALLEL_API_KEY. Create a key at https://platform.parallel.ai and use /pi-better-web-search login in pi's terminal; never paste it into chat.");
      if (selection === "parallel") process.exitCode = 1;
    } else {
      const ok = await probe("parallel", "search", "https://api.parallel.ai/v1/search", {
        mode: "advanced",
        objective: "Find official TypeScript documentation.",
        search_queries: ["TypeScript official documentation"],
      });
      if (ok) await probe("parallel", "fetch", "https://api.parallel.ai/v1/extract", {
        urls: ["https://example.com"],
        objective: "Summarize the page.",
      });
    }
  }
} finally { globalThis.fetch = originalFetch; }
