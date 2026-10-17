import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export const PROVIDER_FAMILIES = ["deepseek", "ollama", "google", "openai", "xai", "anthropic"] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

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
