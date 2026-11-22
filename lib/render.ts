import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WebSearchDetails } from "./format.ts";
import { describeRoute } from "./routes.ts";

/** A URL-only web_search call is a fetch, not a search. */
export function renderWebSearchCall(args: unknown, theme: Theme): Text {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const urlCount = Array.isArray(input.urls) ? input.urls.length : 0;
  const searchQueries = Array.isArray(input.search_queries)
    ? input.search_queries.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim())
    : [];
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  const parallelSearch = searchQueries.length > 0 || (objective.length > 0 && urlCount === 0);
  const query = typeof input.query === "string"
    ? input.query.trim()
    : parallelSearch
      ? (objective || searchQueries.join(", "))
      : "";
  const title = query ? (urlCount > 0 ? "Web Search + Fetch" : "Web Search") : urlCount > 0 ? "Web Fetch" : "Web Search / Fetch";
  const urls = urlCount > 0 ? `${urlCount} URL${urlCount === 1 ? "" : "s"}` : "";
  const summary = [query, urls].filter(Boolean).join(" + ");
  return new Text(`${theme.fg("toolTitle", theme.bold(title))}${summary ? ` ${theme.fg("accent", summary)}` : ""}`, 0, 0);
}

/** UI-only summary: raw provider content is unchanged and available expanded. */
export function renderWebSearchResult(
  result: AgentToolResult<WebSearchDetails>,
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  const output = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const details = result.details;
  const isError = result.isError || !!details?.error;
  if (isError || isPartial) {
    return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
  }
  const lines = (details?.routes ?? []).map(describeRoute);
  if (details?.searchError) lines.push(`Search failed: ${details.searchError}`);
  if (details?.fetchedCount !== undefined) {
    lines.push(`Fetched ${details.fetchedCount} URL${details.fetchedCount === 1 ? "" : "s"}`);
  }
  if (details?.fetchFailedCount) {
    lines.push(`${details.fetchFailedCount} URL${details.fetchFailedCount === 1 ? "" : "s"} failed`);
  }
  if (details?.truncated) lines.push("Output truncated");
  const summary = lines.join("\n");
  const text = expanded && summary ? `${summary}\n${output}` : summary || output;
  return new Text(theme.fg("toolOutput", text), 0, 0);
}
