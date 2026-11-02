import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export const PROVIDER_FAMILIES = ["deepseek", "ollama", "google", "openai", "xai", "anthropic"] as const;
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
  /** A transport failure reaching the provider, not a failure of a target URL. */
  providerError?: string;
}

export interface ProviderAdapter {
  family: ProviderFamily;
  label: string;
  supportsSearch: boolean;
  supportsUrls: boolean;
  search(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    signal: AbortSignal | undefined,
    onUpdate?: AgentToolUpdateCallback,
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
