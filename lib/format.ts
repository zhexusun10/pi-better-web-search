import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatJsonWithinLimit } from "./truncate-json.ts";

const configuredOutputLimit = Math.floor(Number(process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS));
export const MAX_OUTPUT_CHARS =
  Number.isFinite(configuredOutputLimit) && configuredOutputLimit >= 1
    ? configuredOutputLimit
    : 96_000;

export interface WebSearchOutput {
  query?: string;
  search?: {
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

export interface WebSearchDetails {
  provider?: string;
  model?: string;
  fetchProviders?: string[];
  attempts: WebSearchAttempt[];
  resultCount?: number;
  fetchedCount?: number;
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
): AgentToolResult<WebSearchDetails> {
  return {
    content: [{ type: "text", text: `Failed: ${message}` }],
    details,
    isError: true,
  };
}
