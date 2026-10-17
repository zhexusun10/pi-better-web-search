import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { baseUrlFor, buildRequestHeaders, resolveAuth, setHeaderIfAbsent } from "../auth.ts";
import { responseError } from "./http.ts";
import { readSseEvents } from "./sse.ts";
import type { ProviderAdapter, ProviderSearchResult } from "./types.ts";

const ANTHROPIC_LABEL = "Anthropic";
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.280";
const OAUTH_BETA_HEADERS = "claude-code-20250219,oauth-2025-04-20";

const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 10,
  allowed_callers: ["direct"],
} as const;

interface ServerToolState {
  block: any;
  partialInput: string;
  queriesCaptured: boolean;
}

function resolveMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

/** Match pi-web-search's Anthropic token clamp. */
function clampMaxTokens(model: Model<Api>): number {
  return Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192);
}

function addOAuthBetaHeader(headers: Record<string, string>): void {
  const existingName = Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta");
  if (!existingName) {
    headers["anthropic-beta"] = OAUTH_BETA_HEADERS;
    return;
  }

  const existingValue = headers[existingName];
  headers[existingName] = existingValue
    ? `${existingValue},${OAUTH_BETA_HEADERS}`
    : OAUTH_BETA_HEADERS;
}

function extractQueries(input: any): string[] {
  if (!input || typeof input !== "object") return [];

  const queries: string[] = [];
  if (typeof input.query === "string") queries.push(input.query);
  if (Array.isArray(input.queries)) {
    for (const query of input.queries) {
      if (typeof query === "string") queries.push(query);
    }
  }
  return queries;
}

function webSearchError(content: any): any | undefined {
  if (!content) return undefined;
  if (Array.isArray(content)) {
    return content.find((item) => item?.type === "web_search_tool_result_error");
  }
  return content.type === "web_search_tool_result_error" ? content : undefined;
}

function streamError(event: any): Error {
  const error = event?.error ?? event;
  if (typeof error === "string") return new Error(error);
  if (typeof error?.message === "string" && error.message.trim()) return new Error(error.message);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function emitUpdate(
  onUpdate: AgentToolUpdateCallback | undefined,
  text: string,
  details: Record<string, unknown> = {},
): void {
  onUpdate?.({
    content: [{ type: "text", text }],
    details: { streaming: true, ...details },
  });
}

async function callAnthropicSearch(
  ctx: ExtensionContext,
  model: Model<Api>,
  query: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
): Promise<ProviderSearchResult> {
  const auth = await resolveAuth(ctx, model);
  if (!auth.ok) {
    throw new Error(auth.error || "Failed to get API key and headers");
  }

  const isOAuth = !!auth.apiKey?.includes("sk-ant-oat");
  const headers = buildRequestHeaders({
    model,
    ctx,
    auth,
    base: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
    },
    bearer: isOAuth,
    apiKeyHeader: isOAuth ? undefined : "x-api-key",
  });

  if (isOAuth) {
    addOAuthBetaHeader(headers);
    setHeaderIfAbsent(headers, "user-agent", CLAUDE_CODE_USER_AGENT);
    setHeaderIfAbsent(headers, "x-app", "cli");
  }

  const requestBody = {
    model: model.id,
    max_tokens: clampMaxTokens(model),
    ...(isOAuth ? { system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }] } : {}),
    messages: [{ role: "user", content: query }],
    tools: [WEB_SEARCH_TOOL],
    stream: true,
  };

  const response = await fetch(resolveMessagesUrl(baseUrlFor(model, auth)), {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    throw await responseError(response, ANTHROPIC_LABEL);
  }

  let answer = "";
  let sawServerToolUse = false;
  let sawSearchResult = false;
  let sawCitation = false;
  const results: unknown[] = [];
  const citations: unknown[] = [];
  const searchQueries: string[] = [];
  const serverToolsByIndex = new Map<number, ServerToolState>();
  let lastServerTool: ServerToolState | undefined;

  const serverToolForIndex = (index: unknown): ServerToolState | undefined => {
    if (typeof index === "number") return serverToolsByIndex.get(index) ?? lastServerTool;
    return lastServerTool;
  };

  const captureServerToolQueries = (state: ServerToolState, input: any): void => {
    const queries = extractQueries(input);
    if (queries.length === 0) return;
    searchQueries.push(...queries);
    state.queriesCaptured = true;
  };

  await readSseEvents(response, signal, ({ data: event }) => {
    if (event.type === "error" || (event.error && !event.type)) {
      throw streamError(event);
    }

    if (event.type === "content_block_start") {
      const block = event.content_block;

      if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        answer += block.text;
        emitUpdate(onUpdate, answer);
        return;
      }

      if (block?.type === "server_tool_use") {
        sawServerToolUse = true;
        if (block.name === "web_search") {
          const state: ServerToolState = {
            block,
            partialInput: "",
            queriesCaptured: false,
          };
          if (typeof event.index === "number") serverToolsByIndex.set(event.index, state);
          lastServerTool = state;
          captureServerToolQueries(state, block.input);
          emitUpdate(onUpdate, answer || `Searching the web with ${ANTHROPIC_LABEL}...`, { searching: true });
        }
        return;
      }

      if (block?.type === "web_search_tool_result" || block?.type === "web_search_tool_result_error") {
        sawSearchResult = true;
        const error = block.type === "web_search_tool_result_error"
          ? block
          : webSearchError(block.content);
        if (error) {
          const code = error.error_code ?? error.errorCode;
          throw new Error(
            `${ANTHROPIC_LABEL} web search failed: ${code || "unknown error"} (web_search_tool_result_error)`,
          );
        }
        results.push(block);
      }
      return;
    }

    if (event.type === "content_block_stop") {
      const state = serverToolForIndex(event.index);
      if (!state || state.queriesCaptured || !state.partialInput) return;

      try {
        captureServerToolQueries(state, JSON.parse(state.partialInput));
      } catch {
        // Ignore malformed partial input; later search evidence still decides.
      }
      return;
    }

    if (event.type !== "content_block_delta") return;

    const delta = event.delta;
    if (delta?.type === "text_delta") {
      if (typeof delta.text === "string") {
        answer += delta.text;
        emitUpdate(onUpdate, answer);
      }
      return;
    }

    if (delta?.type === "citations_delta") {
      if (delta.citation !== undefined && delta.citation !== null) {
        citations.push(delta.citation);
        sawCitation = true;
      }
      return;
    }

    if (delta?.type === "input_json_delta") {
      const state = serverToolForIndex(event.index);
      if (!state || state.queriesCaptured) return;

      state.partialInput += typeof delta.partial_json === "string" ? delta.partial_json : "";
      try {
        captureServerToolQueries(state, JSON.parse(state.partialInput));
      } catch {
        // The input is completed by later deltas (or content_block_stop).
      }
      return;
    }
  });

  if (!sawServerToolUse && !sawSearchResult && !sawCitation) {
    throw new Error(`${ANTHROPIC_LABEL} did not perform a web search`);
  }

  return {
    answer,
    results,
    citations,
    searchQueries,
  };
}

export const anthropicAdapter: ProviderAdapter = {
  family: "anthropic",
  label: ANTHROPIC_LABEL,
  supportsSearch: true,
  supportsUrls: false,

  async search(ctx, model, query, signal, onUpdate): Promise<ProviderSearchResult> {
    return callAnthropicSearch(ctx, model, query, signal, onUpdate);
  },
};
