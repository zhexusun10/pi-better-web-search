import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { baseUrlFor, buildRequestHeaders, hasAuthHeader, resolveAuth, type ResolvedAuth } from "../auth.ts";
import { responseError } from "./http.ts";
import { readSseEvents } from "./sse.ts";
import type { ProviderAdapter, ProviderFetchEntry, ProviderFetchResult, ProviderSearchResult } from "./types.ts";

const GOOGLE_LABEL = "Google Gemini";
const ANTIGRAVITY_ENDPOINT =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const URL_CONTEXT_SUCCESS = "URL_RETRIEVAL_STATUS_SUCCESS";
const DEFAULT_ANTIGRAVITY_PROJECT = "aicode-consumers";

const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
  "gemini-3.7-flash": "gemini-3.7-flash-medium",
  "gemini-3.7-flash-medium": "gemini-3.7-flash-medium",
  "gemini-3.6-flash": "gemini-3.6-flash-low",
  "gemini-3.5-flash": "gemini-3.5-flash-extra-low",
};

const YOUTUBE_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

interface GoogleRequestBody {
  contents: unknown[];
  tools: unknown[];
}

interface GoogleStreamResult {
  text: string;
  groundingMetadata?: unknown;
  urlContextMetadata?: unknown;
}

interface BuiltGoogleRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  antigravity: boolean;
}

function isAntigravityModel(model: Model<Api>): boolean {
  return model.provider === "antigravity" || model.api === "antigravity";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function groundingValue(metadata: any, camelCase: string, snakeCase: string): unknown {
  return metadata?.[camelCase] ?? metadata?.[snakeCase];
}

function streamError(error: any): Error {
  const status = error?.code ?? error?.status ?? "unknown";
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : JSON.stringify(error);
  const result = new Error(`${GOOGLE_LABEL} API error (${status}): ${message}`) as Error & {
    status?: unknown;
    body?: unknown;
  };
  result.status = status;
  result.body = error;
  return result;
}

function extractAntigravityCredentials(auth: ResolvedAuth): { token?: string; project: string } {
  let token: string | undefined;
  let project = DEFAULT_ANTIGRAVITY_PROJECT;

  if (auth.ok && auth.apiKey) {
    const raw = auth.apiKey;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") {
        token =
          typeof parsed.token === "string" && parsed.token
            ? parsed.token
            : raw;
        project =
          (typeof parsed.projectId === "string" && parsed.projectId)
          || (typeof parsed.project_id === "string" && parsed.project_id)
          || (typeof parsed.project === "string" && parsed.project)
          || project;
      } else {
        token = raw;
      }
    } catch {
      token = raw;
    }
  }

  return { token, project };
}

function buildGoogleRequest(
  model: Model<Api>,
  ctx: ExtensionContext,
  auth: ResolvedAuth,
  body: GoogleRequestBody,
): BuiltGoogleRequest {
  if (isAntigravityModel(model)) {
    const credentials = extractAntigravityCredentials(auth);
    const requestAuth: ResolvedAuth =
      auth.ok && credentials.token ? { ...auth, apiKey: credentials.token } : auth;
    const runtimeModel = ANTIGRAVITY_MODEL_MAP[model.id] || model.id;
    const platform =
      process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
    const osType =
      process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const headers = buildRequestHeaders({
      model,
      ctx,
      auth: requestAuth,
      base: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": `antigravity/hub/2.8.0 ${osType}/${arch}`,
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": JSON.stringify({
          ideType: "ANTIGRAVITY",
          platform,
          pluginType: "GEMINI",
        }),
      },
      bearer: true,
    });

    return {
      url: ANTIGRAVITY_ENDPOINT,
      headers,
      body: {
        project: credentials.project,
        model: runtimeModel,
        request: {
          contents: body.contents,
          tools: body.tools,
        },
        requestType: "AGENT",
        userAgent: "antigravity",
      },
      antigravity: true,
    };
  }

  if (model.api !== "google-generative-ai") {
    throw new Error(`Unsupported Google provider API: ${model.api}`);
  }

  const baseUrl = baseUrlFor(model, auth).replace(/\/+$/, "");
  const headers = buildRequestHeaders({
    model,
    ctx,
    auth,
    base: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
  });

  if (auth.ok && auth.apiKey && !hasAuthHeader(headers)) {
    headers["x-goog-api-key"] = auth.apiKey;
  }

  return {
    url: `${baseUrl}/models/${model.id}:streamGenerateContent?alt=sse`,
    headers,
    body,
    antigravity: false,
  };
}

async function callGoogleStream(
  ctx: ExtensionContext,
  model: Model<Api>,
  body: GoogleRequestBody,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
): Promise<GoogleStreamResult> {
  const auth = await resolveAuth(ctx, model);
  if (!auth.ok) {
    throw new Error(auth.error || "Failed to resolve Google credentials");
  }

  const request = buildGoogleRequest(model, ctx, auth, body);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });

  if (!response.ok) {
    throw await responseError(response, request.antigravity ? "Google Antigravity" : GOOGLE_LABEL);
  }

  let text = "";
  let groundingMetadata: unknown;
  let urlContextMetadata: unknown;

  await readSseEvents(response, signal, ({ data: chunk }) => {
    const data = chunk?.response ?? chunk;
    const streamFailure = chunk?.error ?? data?.error;
    if (streamFailure) {
      throw streamError(streamFailure);
    }

    const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === "string") {
          text += part.text;
          if (part.text) {
            onUpdate?.({
              content: [{ type: "text", text }],
              details: { streaming: true },
            });
          }
        }
      }
    }

    const nextGroundingMetadata =
      candidate?.groundingMetadata
      ?? candidate?.grounding_metadata
      ?? data?.groundingMetadata
      ?? data?.grounding_metadata;
    if (nextGroundingMetadata !== undefined) {
      groundingMetadata = nextGroundingMetadata;
    }

    const nextUrlContextMetadata =
      candidate?.urlContextMetadata
      ?? candidate?.url_context_metadata
      ?? data?.urlContextMetadata
      ?? data?.url_context_metadata;
    if (nextUrlContextMetadata !== undefined) {
      urlContextMetadata = nextUrlContextMetadata;
    }
  });

  return { text, groundingMetadata, urlContextMetadata };
}

function buildFetchPrompt(query: string | undefined, urls: string[]): string {
  if (query && query.length > 0) {
    return `${query}\n\nURLs:\n${urls.join("\n")}`;
  }
  return `Analyze the following URLs.\n\nURLs:\n${urls.join("\n")}`;
}

function buildFetchBody(
  model: Model<Api>,
  urls: string[],
  query: string | undefined,
): GoogleRequestBody {
  const tools = [{ url_context: {} }];

  if (model.api === "google-generative-ai") {
    const youtubeUrls = urls.filter((url) => YOUTUBE_REGEX.test(url));
    const otherUrls = urls.filter((url) => !YOUTUBE_REGEX.test(url));

    if (youtubeUrls.length > 0) {
      const parts: unknown[] = youtubeUrls.map((url) => ({
        file_data: { file_uri: url, mime_type: "video/mp4" },
      }));

      let prompt = query && query.length > 0 ? query : "Analyze the following URLs.";
      if (otherUrls.length > 0) {
        prompt += `\n\nURLs:\n${otherUrls.join("\n")}`;
      }
      parts.push({ text: prompt });

      return {
        contents: [{ role: "user", parts }],
        tools,
      };
    }
  }

  return {
    contents: [{ role: "user", parts: [{ text: buildFetchPrompt(query, urls) }] }],
    tools,
  };
}

function fetchEntryData(answer: string, groundingMetadata: unknown, urlContextMetadata: unknown): unknown {
  return {
    answer,
    groundingMetadata,
    urlContextMetadata,
  };
}

function buildFetchEntries(
  urls: string[],
  result: GoogleStreamResult,
): ProviderFetchEntry[] {
  const urlMetadata = asArray(
    groundingValue(result.urlContextMetadata, "urlMetadata", "url_metadata"),
  );

  return urls.map((url): ProviderFetchEntry => {
    const metadata = urlMetadata.find((item: any) => {
      const metadataUrl = item?.retrievedUrl ?? item?.retrieved_url ?? item?.url;
      return metadataUrl === url;
    }) as any;

    if (!metadata) {
      return {
        url,
        data: fetchEntryData(result.text, result.groundingMetadata, result.urlContextMetadata),
      };
    }

    const status = metadata.urlRetrievalStatus ?? metadata.url_retrieval_status ?? metadata.status;
    if (status === URL_CONTEXT_SUCCESS) {
      return {
        url,
        data: fetchEntryData(result.text, result.groundingMetadata, result.urlContextMetadata),
      };
    }

    return {
      url,
      error: typeof status === "string" && status ? status : "URL_RETRIEVAL_STATUS_UNSPECIFIED",
    };
  });
}

export const googleAdapter: ProviderAdapter = {
  family: "google",
  label: "Google",
  supportsSearch: true,
  supportsUrls: true,

  async search(ctx, model, query, signal, onUpdate): Promise<ProviderSearchResult> {
    const result = await callGoogleStream(
      ctx,
      model,
      {
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      },
      signal,
      onUpdate,
    );

    const results = asArray(
      groundingValue(result.groundingMetadata, "groundingChunks", "grounding_chunks"),
    );
    const citations = asArray(
      groundingValue(result.groundingMetadata, "groundingSupports", "grounding_supports"),
    );
    const searchQueries = asArray(
      groundingValue(result.groundingMetadata, "webSearchQueries", "web_search_queries"),
    );

    if (results.length === 0 && searchQueries.length === 0) {
      throw new Error(`${GOOGLE_LABEL} did not perform a web search`);
    }

    return {
      answer: result.text,
      results,
      citations,
      searchQueries: searchQueries as string[],
      groundingMetadata: result.groundingMetadata,
    };
  },

  async fetch(ctx, model, urls, query, signal, onUpdate): Promise<ProviderFetchResult> {
    const result = await callGoogleStream(
      ctx,
      model,
      buildFetchBody(model, urls, query),
      signal,
      onUpdate,
    );

    if (!result.text && result.groundingMetadata === undefined && result.urlContextMetadata === undefined) {
      throw new Error(`${GOOGLE_LABEL} returned no answer or URL context metadata`);
    }

    return {
      entries: buildFetchEntries(urls, result),
    };
  },
};
