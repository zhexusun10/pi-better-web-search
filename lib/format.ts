import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ProviderFamily } from "./providers/types.ts";

const configuredOutputLimit = Number(process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS);
export const MAX_OUTPUT_CHARS =
  Number.isFinite(configuredOutputLimit) && configuredOutputLimit > 0
    ? Math.floor(configuredOutputLimit)
    : 64_000;

export interface WebSearchOutput {
  query?: string;
  search?: {
    provider: ProviderFamily;
    model: string;
    answer?: string;
    results?: unknown;
    citations?: unknown;
    searchQueries?: string[];
    groundingMetadata?: unknown;
    urlContextMetadata?: unknown;
  };
  fetched?: Array<{
    url: string;
    provider?: ProviderFamily;
    model?: string;
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

const TRUNCATION_MARKER = "\n\n[Truncated]";

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
  const json = JSON.stringify(output, null, 2);
  const marker = TRUNCATION_MARKER.slice(0, Math.max(0, MAX_OUTPUT_CHARS));
  const { text, truncated } = truncateText(json, Math.max(0, MAX_OUTPUT_CHARS - marker.length));
  return {
    content: [{ type: "text", text: truncated ? text + marker : text }],
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
