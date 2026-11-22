import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export const PROVIDER_FAMILIES = ["deepseek", "ollama", "google", "openai", "xai", "anthropic", "perplexity", "keenable", "exa", "parallel"] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

/** A request validation error that the model can fix and retry. */
export class QueryLengthError extends Error {
  readonly provider: string;
  readonly actualLength: number;
  readonly maxLength: number;

  constructor(provider: string, actualLength: number, maxLength: number) {
    super(
      `Search query is too long (${actualLength} Unicode characters). `
      + `The maximum is ${maxLength} Unicode characters. Shorten the query and retry.`,
    );
    this.name = "QueryLengthError";
    this.provider = provider;
    this.actualLength = actualLength;
    this.maxLength = maxLength;
  }
}

export interface ProviderSearchResult {
  /** Preserve result content and unknown fields, omitting known API bookkeeping. */
  [key: string]: unknown;
  answer?: string;
  results?: unknown;
  citations?: unknown;
  searchQueries?: string[];
  groundingMetadata?: unknown;
  urlContextMetadata?: unknown;
}

export interface ProviderFetchEntry {
  url: string;
  data?: unknown;
  error?: string;
}

export interface ProviderFetchResult {
  entries: ProviderFetchEntry[];
  /** A global HTTP/transport failure at the provider, not a target URL failure. */
  providerError?: string;
}

export interface ProviderAdapter {
  family: ProviderFamily;
  label: string;
  /** Uses saved/environment API credentials, without a chat model or tier. */
  standalone?: boolean;
  supportsSearch: boolean;
  supportsUrls: boolean;
  search(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    signal: AbortSignal | undefined,
    onUpdate?: AgentToolUpdateCallback,
    searchQueries?: string[],
  ): Promise<ProviderSearchResult>;
  fetch?(
    ctx: ExtensionContext,
    model: Model<Api>,
    urls: string[],
    query: string | undefined,
    signal: AbortSignal | undefined,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<ProviderFetchResult>;
}
