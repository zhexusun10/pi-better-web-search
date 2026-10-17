import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createModel(overrides = {}) {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "test",
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    type: "chat",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

export function deepseekModel(overrides = {}) {
  return createModel({
    id: "deepseek-chat",
    provider: "deepseek",
    api: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    ...overrides,
  });
}

export function ollamaCloudModel(overrides = {}) {
  return createModel({
    id: "gpt-oss:120b",
    provider: "ollama-cloud",
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
    ...overrides,
  });
}

export function googleModel(overrides = {}) {
  return createModel({
    id: "gemini-2.5-flash",
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    ...overrides,
  });
}

export function openaiResponsesModel(overrides = {}) {
  return createModel({
    id: "gpt-5.1",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    ...overrides,
  });
}

export function anthropicModel(overrides = {}) {
  return createModel({
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  });
}

export function xaiModel(overrides = {}) {
  return createModel({
    id: "grok-4",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    ...overrides,
  });
}

export function unsupportedLocalModel(overrides = {}) {
  return createModel({
    id: "local-model",
    provider: "lmstudio",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    ...overrides,
  });
}

export function createMockCtx({
  model,
  availableModels = [],
  auth = { ok: true, apiKey: "test-api-key" },
  sessionId = "session-test",
  hasConfiguredAuth,
} = {}) {
  const allModels = model ? [model, ...availableModels] : [...availableModels];
  const authResolver = typeof auth === "function" ? auth : async () => auth;

  const modelRegistry = {
    async getApiKeyAndHeaders(target) {
      return authResolver(target);
    },
    getAvailable() {
      return [...availableModels];
    },
    find(provider, modelId) {
      return allModels.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    },
    hasConfiguredAuth(target) {
      if (typeof hasConfiguredAuth === "function") return hasConfiguredAuth(target);
      if (typeof hasConfiguredAuth === "boolean") return hasConfiguredAuth;
      return availableModels.some(
        (candidate) => candidate.provider === target.provider && candidate.id === target.id,
      );
    },
  };

  return {
    model,
    modelRegistry,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
    cwd: process.cwd(),
    signal: undefined,
    ui: {
      notify() {},
      setStatus() {},
    },
  };
}

export function createMockPi() {
  const tools = new Map();
  const handlers = new Map();
  let activeTools = [];

  return {
    tools,
    handlers,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
      };
    },
    getThinkingLevel() {
      return "off";
    },
  };
}

export function createTempCache() {
  const directory = mkdtempSync(join(tmpdir(), "pi-better-web-search-"));
  return {
    directory,
    path: join(directory, "cache.json"),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function withEnv(values, fn) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function withTempCache(fn) {
  const temp = createTempCache();
  try {
    return await withEnv({ PI_BETTER_WEB_SEARCH_CACHE: temp.path }, () => fn(temp));
  } finally {
    temp.cleanup();
  }
}
