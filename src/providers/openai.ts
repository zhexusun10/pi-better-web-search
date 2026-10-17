import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildRequestHeaders,
  getHeader,
  hasHeader,
  resolveAuth,
  setHeaderIfAbsent,
  type ResolvedAuth,
} from "../auth.ts";
import { responseError } from "./http.ts";
import { readSseEvents } from "./sse.ts";
import type { ProviderAdapter, ProviderFamily, ProviderSearchResult } from "./types.ts";

type SearchDialect = "grok" | "openai";
type AuthSuccess = Extract<ResolvedAuth, { ok: true }>;
type RawItem = Record<string, any>;

function isOpenAICodexModel(model: Model<Api>): boolean {
  return model.api === "openai-codex-responses";
}

function resolveGitHubCopilotBaseUrl(model: Model<Api>, auth: AuthSuccess): string {
  if (model.provider !== "github-copilot") return model.baseUrl;

  // Modern pi versions expose the credential-specific Copilot endpoint
  // resolved by the provider. Prefer it so GitHub Enterprise Server and any
  // future provider-owned routing continue to work without token parsing here.
  if (typeof auth.baseUrl === "string" && auth.baseUrl.trim()) {
    return auth.baseUrl;
  }

  // Compatibility fallback for older pi versions whose extension auth API
  // returned the Copilot token but not its resolved base URL.
  if (!auth.apiKey) return model.baseUrl;
  const proxyEndpoints = auth.apiKey
    .split(";")
    .filter((field) => field.startsWith("proxy-ep="))
    .map((field) => field.slice("proxy-ep=".length));
  if (proxyEndpoints.length !== 1) return model.baseUrl;

  const proxyHost = proxyEndpoints[0].toLowerCase();
  const labels = proxyHost.split(".");
  const isValidLabel = (label: string) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  const isCopilotProxyHost = proxyHost.length <= 253
    && labels.length >= 4
    && labels[0] === "proxy"
    && labels.at(-2) === "githubcopilot"
    && labels.at(-1) === "com"
    && labels.every(isValidLabel);
  if (!isCopilotProxyHost) return model.baseUrl;

  return `https://api.${labels.slice(1).join(".")}`;
}

function resolveOpenAIResponsesUrl(model: Model<Api>, baseUrl = model.baseUrl): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!isOpenAICodexModel(model)) return `${base}/responses`;
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

function extractOpenAICodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("Missing account ID");
    return accountId;
  } catch {
    throw new Error("Failed to extract ChatGPT account ID from openai-codex credentials");
  }
}

export function getSearchDialect(model: Model<Api>, family?: ProviderFamily): SearchDialect {
  const override = (model.compat as { webSearchDialect?: unknown } | undefined)?.webSearchDialect;
  if (override === "grok" || override === "openai") return override;
  if (family === "xai" || (model.provider === "xai" && model.api === "openai-responses")) return "grok";
  if (/^grok([.-]|$)/i.test(model.id)) return "grok";
  return "openai";
}

function streamErrorMessage(event: any): string {
  const message = event?.message || event?.error?.message || event?.response?.error?.message;
  if (typeof message === "string" && message) return message;
  try {
    return JSON.stringify(event?.error || event?.response?.error || event);
  } catch {
    return "OpenAI stream error";
  }
}

function annotationItems(value: unknown): RawItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RawItem => !!item && typeof item === "object" && item.type === "url_citation");
}

async function searchResponses(
  family: ProviderFamily,
  ctx: ExtensionContext,
  model: Model<Api>,
  query: string,
  signal: AbortSignal | undefined,
  onUpdate?: Parameters<ProviderAdapter["search"]>[4],
): Promise<ProviderSearchResult> {
  const label = family === "xai" ? "xAI" : "OpenAI";

  const auth = await resolveAuth(ctx, model);
  if (!auth.ok) throw new Error(auth.error || "Failed to get API key and headers");

  const headers = buildRequestHeaders({ model, ctx, auth, bearer: true });
  setHeaderIfAbsent(headers, "Content-Type", "application/json");
  setHeaderIfAbsent(headers, "Accept", "text/event-stream");

  const isCodex = isOpenAICodexModel(model);
  if (isCodex) {
    const authorization = getHeader(headers, "Authorization");
    const hasBearerAuth = typeof authorization === "string" && /^Bearer\s+\S+/i.test(authorization);
    if (!auth.apiKey && !hasBearerAuth) {
      throw new Error("No OAuth credential configured for openai-codex model");
    }
    if (!hasHeader(headers, "chatgpt-account-id")) {
      if (!auth.apiKey) {
        throw new Error("No ChatGPT account ID configured for openai-codex model");
      }
      headers["chatgpt-account-id"] = extractOpenAICodexAccountId(auth.apiKey);
    }
    setHeaderIfAbsent(headers, "originator", "codex_cli_rs");
  }

  const requestHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) requestHeaders[name.toLowerCase()] = value;

  const dialect = getSearchDialect(model, family);
  const isGrok = dialect === "grok";
  const body: Record<string, any> = {
    model: model.id,
    input: isCodex || !isGrok
      ? [{ role: "user", content: [{ type: "input_text", text: query }] }]
      : [{ role: "user", content: query }],
    tools: [{ type: "web_search" }],
    include: isCodex || isGrok
      ? ["web_search_call.action.sources"]
      : ["web_search_call.action.sources", "web_search_call.results"],
    stream: true,
    store: false,
  };
  if (isCodex) {
    body.instructions = "Answer the user's request using web search when needed.";
    body.text = { verbosity: "low" };
    body.tool_choice = "required";
    body.parallel_tool_calls = true;
  }

  const baseUrl = resolveGitHubCopilotBaseUrl(model, auth);
  const response = await fetch(resolveOpenAIResponsesUrl(model, baseUrl), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await responseError(response, label);

  let answer = "";
  const results: RawItem[] = [];
  const resultIndexes = new Map<string, number>();
  const citations: RawItem[] = [];

  const replaceResult = (item: RawItem) => {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (id) {
      const existing = resultIndexes.get(id);
      if (existing !== undefined) {
        results[existing] = item;
        return;
      }
      resultIndexes.set(id, results.length);
    }
    results.push(item);
  };

  const collectWebSearchCall = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const raw = item as RawItem;
    if (raw.type !== "web_search_call") return;
    replaceResult(raw);
  };

  const collectWebSearchEvent = (event: RawItem) => {
    const status = event.type.slice("response.web_search_call.".length);
    const id = typeof event.item_id === "string" ? event.item_id : undefined;
    const existing = id ? resultIndexes.get(id) : undefined;
    if (existing !== undefined) {
      replaceResult({ ...results[existing], status });
      return;
    }
    replaceResult({ ...event, type: "web_search_call", ...(id ? { id } : {}), status });
  };

  const collectAnnotations = (annotations: unknown) => {
    for (const annotation of annotationItems(annotations)) citations.push(annotation);
  };

  const collectFromResponse = (responseValue: any) => {
    for (const item of responseValue?.output || []) {
      if (item?.type === "web_search_call") {
        collectWebSearchCall(item);
        continue;
      }
      if (item?.type !== "message") continue;
      for (const content of item.content || []) {
        collectAnnotations(content?.annotations);
      }
    }
  };

  await readSseEvents(response, signal, ({ data: event }) => {
    if (signal?.aborted) throw new Error("Request was aborted");
    const type = event?.type;

    if (type === "error" || type === "response.failed") {
      throw new Error(streamErrorMessage(event));
    }

    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string") answer += event.delta;
      onUpdate?.({
        content: [{ type: "text", text: answer }],
        details: { streaming: true },
      });
      return;
    }

    if (type === "response.output_text.annotation.added") {
      collectAnnotations([event.annotation]);
      return;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      collectWebSearchCall(event.item);
      return;
    }

    if (typeof type === "string" && type.startsWith("response.web_search_call.")) {
      collectWebSearchEvent(event);
      return;
    }

    if (type === "response.incomplete" || event?.response?.status === "incomplete") {
      collectFromResponse(event.response);
      if (isCodex) return true;
      return;
    }

    if (type === "response.completed" || type === "response.done") {
      collectFromResponse(event.response);
      if (isCodex) return true;
    }
  });

  if (results.length === 0 && citations.length === 0) {
    throw new Error(`${label} did not perform a web search`);
  }
  if (results.length > 0 && results.every((result) => result?.status === "failed")) {
    throw new Error(`${label} web search failed`);
  }

  const searchQueries: string[] = [];
  for (const result of results) {
    const action = result?.action;
    if (!action || typeof action !== "object") continue;
    if (Array.isArray(action.queries)) {
      for (const item of action.queries) {
        if (typeof item === "string") searchQueries.push(item);
      }
    } else if (typeof action.query === "string") {
      searchQueries.push(action.query);
    }
  }

  return {
    answer,
    results,
    citations,
    searchQueries,
  };
}

export const openaiAdapter: ProviderAdapter = {
  family: "openai",
  label: "OpenAI",
  supportsSearch: true,
  supportsUrls: false,
  async search(ctx, model, query, signal, onUpdate) {
    return searchResponses("openai", ctx, model, query, signal, onUpdate);
  },
};

export const xaiAdapter: ProviderAdapter = {
  family: "xai",
  label: "xAI",
  supportsSearch: true,
  supportsUrls: false,
  async search(ctx, model, query, signal, onUpdate) {
    return searchResponses("xai", ctx, model, query, signal, onUpdate);
  },
};
