import type { Api, Model } from "@earendil-works/pi-ai";
import { ADAPTERS } from "./providers/index.ts";
import type { ProviderAdapter, ProviderFamily } from "./providers/types.ts";

const OPENAI_RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

function isOllamaCloudModel(model: Model<Api>): boolean {
  if (model.provider === "ollama-cloud") return true;
  try {
    return new URL(model.baseUrl).hostname === "ollama.com";
  } catch {
    return false;
  }
}

export function getProviderFamily(model: Model<Api> | undefined): ProviderFamily | undefined {
  if (!model) return undefined;

  if (model.provider === "deepseek") return "deepseek";
  if (model.provider === "antigravity" || model.api === "antigravity") return "google";
  if (model.api === "google-generative-ai") return "google";
  if (isOllamaCloudModel(model)) return "ollama";
  if (model.provider === "xai" && model.api === "openai-responses") return "xai";
  if (OPENAI_RESPONSES_APIS.has(model.api)) return "openai";
  if (model.api === "anthropic-messages") return "anthropic";
  return undefined;
}

export function isChatModel(model: Model<Api> | undefined): model is Model<Api> {
  return !!model && (!model.type || model.type === "chat");
}

export function getAdapterForFamily(family: ProviderFamily | undefined): ProviderAdapter | undefined {
  return family ? ADAPTERS[family] : undefined;
}

export function getAdapterForModel(model: Model<Api> | undefined): ProviderAdapter | undefined {
  return getAdapterForFamily(getProviderFamily(model));
}

export function isSupportedSearchModel(model: Model<Api> | undefined): model is Model<Api> {
  if (!isChatModel(model)) return false;
  const adapter = getAdapterForModel(model);
  return !!adapter?.supportsSearch;
}

export function describeModel(model: Model<Api>): string {
  return `${model.id} (${model.provider}/${model.api})`;
}

export function isRestFamily(family: ProviderFamily | undefined): boolean {
  return family === "deepseek" || family === "ollama";
}
