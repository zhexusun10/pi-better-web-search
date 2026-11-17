import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatJsonWithinLimit } from "./truncate-json.ts";

const configuredOutputLimit = Math.floor(Number(process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS));
export const MAX_OUTPUT_CHARS =
  Number.isFinite(configuredOutputLimit) && configuredOutputLimit >= 1
    ? configuredOutputLimit
    : 96_000;

export interface WebSearchOutput {
  search?: {
    /** Search failed while another requested operation succeeded. */
    error?: string;
    answer?: string;
    results?: unknown;
    citations?: unknown;
    searchQueries?: string[];
    groundingMetadata?: unknown;
    urlContextMetadata?: unknown;
  };
  fetched?: Array<{
    url: string;
    data?: unknown;
    error?: string;
  }>;
}

export interface WebSearchAttempt {
  phase: "search" | "fetch";
  provider: string;
  model: string;
  message: string;
}

/** The actual operation; model is omitted for standalone Search/Fetch APIs. */
export interface WebSearchRoute {
  phase: "search" | "fetch";
  provider: string;
  model?: string;
  endpoint?: string;
}

export interface WebSearchDetails {
  routes?: WebSearchRoute[];
  activeRoute?: WebSearchRoute;
  provider?: string;
  model?: string;
  fetchProviders?: string[];
  attempts: WebSearchAttempt[];
  resultCount?: number;
  fetchedCount?: number;
  fetchFailedCount?: number;
  searchError?: string;
  truncated?: boolean;
  error?: string;
}

/**
 * Truncate by Unicode code point so a surrogate pair is never split. The
 * returned `text` is at most `maxChars` code points.
 */
export function truncateText(
  text: string,
  maxChars: number = MAX_OUTPUT_CHARS,
): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : MAX_OUTPUT_CHARS;
  const characters = Array.from(text);
  if (characters.length <= limit) return { text, truncated: false };
  return { text: characters.slice(0, limit).join(""), truncated: true };
}

export function formatSuccess(
  output: WebSearchOutput,
  details: WebSearchDetails,
): AgentToolResult<WebSearchDetails> {
  const { text, truncated } = formatJsonWithinLimit(output, MAX_OUTPUT_CHARS);
  return {
    content: [{ type: "text", text }],
    details: truncated ? { ...details, truncated: true } : details,
  };
}

export function formatError(
  message: string,
  details: WebSearchDetails,
  prefix = "Failed: ",
): AgentToolResult<WebSearchDetails> {
  const full = `${prefix}${message}`;
  const limited = truncateText(full, MAX_OUTPUT_CHARS);
  const marker = "[truncated]";
  const text = limited.truncated && MAX_OUTPUT_CHARS >= marker.length
    ? `${truncateText(full, MAX_OUTPUT_CHARS - marker.length).text}${marker}`
    : limited.text;
  return {
    content: [{ type: "text", text }],
    details: limited.truncated ? { ...details, truncated: true } : details,
    isError: true,
  };
}
