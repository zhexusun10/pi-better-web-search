import type { Candidate } from "./candidates.ts";
import type { WebSearchRoute } from "./format.ts";
import { dedicatedKey } from "./dedicated-config.ts";

/** Describe the API actually invoked, not the model used to find credentials. */
export function routeFor(candidate: Candidate, phase: WebSearchRoute["phase"]): WebSearchRoute {
  const provider = candidate.model.provider;
  if (candidate.family === "parallel") return { phase, provider, endpoint: phase === "fetch" ? "/v1/extract" : "/v1/search" };
  if (candidate.family === "perplexity") return { phase, provider, endpoint: "/search" };
  if (candidate.family === "exa") return { phase, provider, endpoint: phase === "fetch" ? "/contents" : "/search" };
  if (candidate.family === "keenable") {
    return { phase, provider, endpoint: `/v1/${phase}${dedicatedKey("keenable") ? "" : "/public"}` };
  }
  if (candidate.family === "deepseek") {
    return { phase, provider, endpoint: `/v1/tools/${phase}` };
  }
  if (candidate.family === "ollama") {
    return { phase, provider, endpoint: phase === "search" ? "/api/web_search" : "/api/web_fetch" };
  }
  return { phase, provider, model: candidate.model.id };
}

export function describeRoute(route: WebSearchRoute): string {
  const operation = route.phase === "fetch" ? "Fetch" : "Search";
  const target = route.endpoint
    ? `${route.provider} API ${route.endpoint}`
    : `${route.provider}/${route.model}`;
  return `${operation}: ${target}`;
}
