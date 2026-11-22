import { anthropicAdapter } from "./anthropic.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { googleAdapter } from "./google.ts";
import { ollamaAdapter } from "./ollama.ts";
import { openaiAdapter, xaiAdapter } from "./openai.ts";
import type { ProviderAdapter, ProviderFamily } from "./types.ts";
import { perplexityAdapter } from "./perplexity.ts";
import { keenableAdapter } from "./keenable.ts";
import { exaAdapter } from "./exa.ts";
import { parallelAdapter } from "./parallel.ts";

export { exaAdapter } from "./exa.ts";
export { parallelAdapter } from "./parallel.ts";
export { perplexityAdapter } from "./perplexity.ts";
export { keenableAdapter } from "./keenable.ts";
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
  perplexity: perplexityAdapter,
  keenable: keenableAdapter,
  exa: exaAdapter,
  parallel: parallelAdapter,
};
