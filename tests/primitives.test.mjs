import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  anthropicModel,
  createMockCtx,
  createModel,
  deepseekModel,
  googleModel,
  ollamaCloudModel,
  openaiResponsesModel,
  unsupportedLocalModel,
  withEnv,
  withTempCache,
  xaiModel,
} from "./helpers.mjs";

import {
  ADAPTERS,
  PROVIDER_FAMILIES,
  anthropicAdapter,
  deepseekAdapter,
  googleAdapter,
  ollamaAdapter,
  openaiAdapter,
  xaiAdapter,
} from "../lib/providers/index.ts";
import {
  describeModel,
  getAdapterForFamily,
  getAdapterForModel,
  getProviderFamily,
  isChatModel,
  isRestFamily,
  isSupportedSearchModel,
} from "../lib/families.ts";
import {
  fingerprintAvailableModels,
  getCachePath,
  isFreshDiscovery,
  readCache,
  writeCache,
} from "../lib/cache.ts";
import {
  baseUrlFor,
  buildRequestHeaders,
  getProviderSessionHeaders,
  hasEnvAuth,
  hasHeader,
  mergeHeaders,
  resolveAuth,
  setHeaderIfAbsent,
} from "../lib/auth.ts";
import {
  MAX_URLS,
  WEB_SEARCH_DESCRIPTION,
  buildWebSearchSchema,
  buildWebSearchToolDescription,
} from "../lib/schema.ts";
import {
  MAX_OUTPUT_CHARS,
  formatError,
  formatSuccess,
  truncateText,
} from "../lib/format.ts";
import {
  HttpError,
  responseError,
  isAbortError,
  readJson,
} from "../lib/providers/http.ts";

test("provider family detection follows the required precedence", () => {
  const cases = [
    [deepseekModel(), "deepseek"],
    [googleModel(), "google"],
    [createModel({ provider: "custom", api: "google-generative-ai" }), "google"],
    [createModel({ provider: "antigravity", api: "google-vertex" }), "google"],
    [createModel({ provider: "custom", api: "antigravity" }), "google"],
    [ollamaCloudModel(), "ollama"],
    [createModel({ provider: "custom-proxy", api: "openai-completions", baseUrl: "https://ollama.com/v1" }), "ollama"],
    [xaiModel(), "xai"],
    [openaiResponsesModel(), "openai"],
    [createModel({ provider: "azure", api: "azure-openai-responses" }), "openai"],
    [createModel({ provider: "openai-codex", api: "openai-codex-responses" }), "openai"],
    [anthropicModel(), "anthropic"],
    [unsupportedLocalModel(), undefined],
    [createModel({ provider: "xai", api: "openai-completions" }), undefined],
    [undefined, undefined],
  ];

  for (const [model, expected] of cases) {
    assert.equal(getProviderFamily(model), expected);
  }

  assert.equal(isChatModel(createModel()), true);
  assert.equal(isChatModel(createModel({ type: undefined })), true);
  assert.equal(isChatModel(createModel({ type: "image" })), false);
  assert.equal(isSupportedSearchModel(deepseekModel()), true);
  assert.equal(isSupportedSearchModel(unsupportedLocalModel()), false);
  assert.equal(isSupportedSearchModel(createModel({ provider: "deepseek", type: "image" })), false);
  assert.equal(describeModel(deepseekModel()), "deepseek-chat (deepseek/anthropic-messages)");
  assert.equal(getAdapterForModel(deepseekModel()), deepseekAdapter);
  assert.equal(getAdapterForFamily("openai"), openaiAdapter);
  assert.equal(getAdapterForFamily(undefined), undefined);
  assert.equal(isRestFamily("deepseek"), true);
  assert.equal(isRestFamily("ollama"), true);
  assert.equal(isRestFamily("google"), false);
  assert.equal(isRestFamily(undefined), false);
});

test("adapter registry exposes all six families with final capabilities", () => {
  assert.deepEqual(Object.keys(ADAPTERS), [...PROVIDER_FAMILIES]);
  assert.deepEqual(
    PROVIDER_FAMILIES.map((family) => ADAPTERS[family].family),
    [...PROVIDER_FAMILIES],
  );

  const expected = {
    deepseek: { label: "DeepSeek", search: true, urls: true, fetch: true },
    ollama: { label: "Ollama", search: true, urls: true, fetch: true },
    google: { label: "Google", search: true, urls: true, fetch: true },
    openai: { label: "OpenAI", search: true, urls: false, fetch: false },
    xai: { label: "xAI", search: true, urls: false, fetch: false },
    anthropic: { label: "Anthropic", search: true, urls: false, fetch: false },
  };

  for (const [family, config] of Object.entries(expected)) {
    const adapter = ADAPTERS[family];
    assert.equal(adapter.label, config.label);
    assert.equal(adapter.supportsSearch, config.search);
    assert.equal(adapter.supportsUrls, config.urls);
    assert.equal(typeof adapter.fetch, config.fetch ? "function" : "undefined");
  }

  assert.equal(deepseekAdapter.supportsUrls, true);
  assert.equal(ollamaAdapter.supportsUrls, true);
  assert.equal(googleAdapter.supportsUrls, true);
  assert.equal(anthropicAdapter.supportsUrls, false);
});

test("all six adapters expose concrete search implementations", () => {
  for (const [family, adapter] of Object.entries(ADAPTERS)) {
    assert.equal(typeof adapter.search, "function", family);
    assert.equal(adapter.search.constructor.name, "AsyncFunction", family);
    if (adapter.supportsUrls) {
      assert.equal(typeof adapter.fetch, "function", family);
      assert.equal(adapter.fetch.constructor.name, "AsyncFunction", family);
    } else {
      assert.equal(adapter.fetch, undefined, family);
    }
  }
});

test("schema is query-only or query+urls without a top-level anyOf", () => {
  const queryOnly = buildWebSearchSchema({ allowUrls: false });
  assert.deepEqual(queryOnly.required, ["query"]);
  assert.equal(queryOnly.properties.urls, undefined);
  assert.equal(queryOnly.anyOf, undefined);
  assert.equal(queryOnly.properties.query.minLength, 1);

  const withUrls = buildWebSearchSchema({ allowUrls: true });
  assert.equal(withUrls.required, undefined);
  assert.equal(withUrls.anyOf, undefined);
  assert.equal(withUrls.properties.query.minLength, 1);
  assert.equal(withUrls.properties.urls.minItems, 1);
  assert.equal(withUrls.properties.urls.maxItems, 20);
  assert.equal(withUrls.properties.urls.maxItems, MAX_URLS);
  assert.match(withUrls.properties.urls.description, /alone/);
  assert.match(withUrls.properties.urls.description, /together with query/);
  assert.match(withUrls.properties.query.description, /urls/);

  assert.equal(buildWebSearchToolDescription({ allowUrls: false }), WEB_SEARCH_DESCRIPTION);
  assert.equal(buildWebSearchToolDescription({ allowUrls: true }), WEB_SEARCH_DESCRIPTION);
  assert.ok(WEB_SEARCH_DESCRIPTION.startsWith("Search the web or analyze specified URLs."));
});

test("truncateText is Unicode-safe and format helpers only wrap JSON", () => {
  assert.deepEqual(truncateText("hello", 10), { text: "hello", truncated: false });
  assert.deepEqual(truncateText("hello", 3), { text: "hel", truncated: true });
  assert.deepEqual(truncateText("a😀b", 2), { text: "a😀", truncated: true });
  assert.deepEqual(truncateText("anything", 0), { text: "", truncated: true });

  const output = { query: "q", search: { provider: "deepseek", model: "deepseek-chat", results: [{ raw: true }] } };
  const details = { attempts: [], provider: "deepseek", model: "deepseek-chat" };
  const result = formatSuccess(output, details);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), output);
  assert.equal(result.details, details);

  const huge = formatSuccess({ query: "x".repeat(MAX_OUTPUT_CHARS + 100) }, { attempts: [] });
  assert.equal(huge.details.truncated, true);
  assert.ok(huge.content[0].text.length <= MAX_OUTPUT_CHARS);
  assert.ok(huge.content[0].text.endsWith("[Truncated]"));

  const error = formatError("all providers failed", { attempts: [], error: "all providers failed" });
  assert.deepEqual(error.content, [{ type: "text", text: "Failed: all providers failed" }]);
  assert.equal(error.isError, true);
});

test("cache round-trips, tolerates corruption, and creates parent directories", async () => {
  await withTempCache(async (temp) => {
    assert.equal(getCachePath(), temp.path);
    assert.deepEqual(readCache(), { version: 1 });

    const cache = {
      version: 1,
      fingerprint: "abc123",
      search: { provider: "deepseek", model: "deepseek-chat" },
      fetch: { provider: "ollama-cloud", model: "gpt-oss:120b" },
    };
    assert.equal(writeCache(cache), true);
    assert.deepEqual(readCache(), cache);
    assert.deepEqual(JSON.parse(readFileSync(temp.path, "utf8")), cache);

    assert.equal(
      writeCache({
        ...cache,
        apiKey: "top-level-secret",
        search: { ...cache.search, apiKey: "nested-secret" },
      }),
      true,
    );
    const persistedText = readFileSync(temp.path, "utf8");
    assert.doesNotMatch(persistedText, /secret|apiKey/);
    assert.deepEqual(readCache(), cache);

    writeFileSync(temp.path, "{not json", "utf8");
    assert.deepEqual(readCache(), { version: 1 });

    writeFileSync(temp.path, JSON.stringify({ version: 2, search: cache.search }), "utf8");
    assert.deepEqual(readCache(), { version: 1 });

    writeFileSync(
      temp.path,
      JSON.stringify({ version: 1, fingerprint: 42, search: { provider: "", model: 1 }, fetch: cache.fetch }),
      "utf8",
    );
    assert.deepEqual(readCache(), { version: 1 });

    const nested = join(temp.directory, "nested", "deeper", "cache.json");
    await withEnv({ PI_BETTER_WEB_SEARCH_CACHE: nested }, () => {
      assert.equal(writeCache(cache), true);
      assert.deepEqual(readCache(), cache);
    });

    await withEnv(
      { PI_BETTER_WEB_SEARCH_CACHE: undefined, PI_CODING_AGENT_DIR: temp.directory },
      () => {
        assert.equal(getCachePath(), join(temp.directory, "better-web-search.json"));
      },
    );
  });
});

test("model fingerprint is stable, sorted, and invalidated by availability changes", () => {
  const deepseek = deepseekModel();
  const google = googleModel();
  const image = createModel({ id: "image-model", provider: "openai", type: "image" });

  const first = fingerprintAvailableModels(createMockCtx({
    availableModels: [google, deepseek, image],
  }));
  const reordered = fingerprintAvailableModels(createMockCtx({
    availableModels: [image, deepseek, google],
  }));
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(first, reordered);

  const changed = fingerprintAvailableModels(createMockCtx({
    availableModels: [google, deepseekModel({ baseUrl: "https://proxy.example.com" }), image],
  }));
  assert.notEqual(first, changed);

  const added = fingerprintAvailableModels(createMockCtx({
    availableModels: [google, deepseek, anthropicModel()],
  }));
  assert.notEqual(first, added);

  assert.equal(isFreshDiscovery({ version: 1, fingerprint: first }, first), false);
  assert.equal(isFreshDiscovery({ version: 1, fingerprint: first }, changed), true);
  assert.equal(isFreshDiscovery({ version: 1 }, first), true);
});

test("auth uses registry credentials, preserves headers, and falls back to env", async () => {
  await withEnv({ DEEPSEEK_API_KEY: "env-deepseek-key" }, async () => {
    const model = deepseekModel();

    const envFallback = await resolveAuth(
      createMockCtx({ model, auth: { ok: true, headers: { "x-custom": "1" }, baseUrl: "https://proxy.example.com" } }),
      model,
    );
    assert.deepEqual(envFallback, {
      ok: true,
      apiKey: "env-deepseek-key",
      headers: { "x-custom": "1" },
      baseUrl: "https://proxy.example.com",
    });

    const explicitHeader = await resolveAuth(
      createMockCtx({ model, auth: { ok: true, headers: { Authorization: "Bearer explicit" } } }),
      model,
    );
    assert.deepEqual(explicitHeader, {
      ok: true,
      headers: { Authorization: "Bearer explicit" },
    });

    const explicitKey = await resolveAuth(
      createMockCtx({ model, auth: { ok: true, apiKey: "registry-key", headers: { "x-a": "a" } } }),
      model,
    );
    assert.deepEqual(explicitKey, {
      ok: true,
      apiKey: "registry-key",
      headers: { "x-a": "a" },
    });

    const rejected = await resolveAuth(
      createMockCtx({ model, auth: { ok: false, error: "not logged in" } }),
      model,
    );
    assert.deepEqual(rejected, { ok: false, error: "not logged in" });

    const thrown = await resolveAuth(
      createMockCtx({ model, auth: async () => { throw new Error("registry exploded"); } }),
      model,
    );
    assert.deepEqual(thrown, { ok: false, error: "registry exploded" });

    assert.equal(hasEnvAuth("deepseek"), true);
    assert.equal(hasEnvAuth("not-a-provider"), false);
  });
});

test("header helpers are case-insensitive and request headers merge deterministically", async () => {
  const merged = mergeHeaders(
    { "Content-Type": "application/json", "X-First": "1" },
    { "x-first": "2", "X-Second": "3" },
    undefined,
    { "X-Second": null, "X-Third": "4" },
  );
  assert.deepEqual(merged, {
    "Content-Type": "application/json",
    "x-first": "2",
    "X-Third": "4",
  });

  const headers = { "X-A": "1" };
  assert.equal(hasHeader(headers, "x-a"), true);
  setHeaderIfAbsent(headers, "x-a", "2");
  setHeaderIfAbsent(headers, "X-B", "3");
  assert.deepEqual(headers, { "X-A": "1", "X-B": "3" });

  const model = deepseekModel();
  const ctx = createMockCtx({
    model,
    auth: { ok: true, apiKey: "key-1", headers: { "X-Auth": "yes" } },
  });
  const auth = await resolveAuth(ctx, model);
  const built = buildRequestHeaders({
    model,
    ctx,
    auth,
    base: { "Content-Type": "application/json" },
    bearer: true,
    apiKeyHeader: "x-api-key",
  });
  assert.deepEqual(built, {
    "Content-Type": "application/json",
    "X-Auth": "yes",
    Authorization: "Bearer key-1",
    "x-api-key": "key-1",
  });
  assert.equal(baseUrlFor(model, auth), "https://api.deepseek.com/anthropic");
  assert.equal(baseUrlFor(model, { ok: true, baseUrl: "https://proxy.example.com" }), "https://proxy.example.com");
  assert.equal(baseUrlFor(model, undefined), "https://api.deepseek.com/anthropic");

  const openCode = createModel({
    id: "gpt-5.6-luna",
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  assert.deepEqual(getProviderSessionHeaders(openCode, createMockCtx({ model: openCode, sessionId: "sess-42" })), {
    "x-opencode-session": "sess-42",
    "x-opencode-client": "pi",
  });
  assert.equal(getProviderSessionHeaders(deepseekModel(), createMockCtx({ model })), undefined);
});

test("HTTP helpers expose status, extract OpenAI errors, and detect aborts", async () => {
  const response = new Response(
    JSON.stringify({ error: { message: "rate limited", type: "rate_limit", param: null, code: "429" } }),
    { status: 429, statusText: "Too Many Requests" },
  );
  const error = await responseError(response, "DeepSeek");
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 429);
  assert.match(error.message, /DeepSeek API error \(429 Too Many Requests\): rate limited/);
  assert.match(error.body, /rate_limit/);

  const invalid = new Response("{", { status: 502, statusText: "Bad Gateway" });
  await assert.rejects(() => readJson(invalid), /Invalid JSON response \(HTTP 502 Bad Gateway\)/);

  assert.equal(isAbortError(new Error("Request was aborted")), true);
  assert.equal(isAbortError(new Error("boom")), false);
  const controller = new AbortController();
  controller.abort();
  assert.equal(isAbortError(new Error("boom"), controller.signal), true);
});
