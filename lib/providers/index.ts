import { anthropicAdapter } from "./anthropic.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { googleAdapter } from "./google.ts";
import { ollamaAdapter } from "./ollama.ts";
import { openaiAdapter, xaiAdapter } from "./openai.ts";
import type { ProviderAdapter, ProviderFamily } from "./types.ts";

export { anthropicAdapter } from "./anthropic.ts";
export { deepseekAdapter } from "./deepseek.ts";
export { googleAdapter } from "./google.ts";
export { ollamaAdapter } from "./ollama.ts";
export { openaiAdapter, xaiAdapter } from "./openai.ts";
export {
  PROVIDER_FAMILIES,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderFetchEntry,
  type ProviderFetchResult,
  type ProviderSearchResult,
} from "./types.ts";

/**
 * Stable registry keyed by provider family. Object insertion order is the
 * deterministic candidate order used by the orchestrator.
 */
export const ADAPTERS: Record<ProviderFamily, ProviderAdapter> = {
  deepseek: deepseekAdapter,
  ollama: ollamaAdapter,
  google: googleAdapter,
  openai: openaiAdapter,
  xai: xaiAdapter,
  anthropic: anthropicAdapter,
};
