import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import piBetterWebSearch, { createWebSearchToolManager } from "../extensions/index.ts";
import { API_COMMAND_NAME } from "../lib/api-command.ts";
import { getFetchCandidates, getSearchCandidates, resolveResolutionContext } from "../lib/candidates.ts";
import { fingerprintAvailableModels, readCache, getCachePath } from "../lib/cache.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { dedicatedState } from "../lib/dedicated-config.ts";
import { ADAPTERS, keenableAdapter, perplexityAdapter } from "../lib/providers/index.ts";
import { HttpError } from "../lib/providers/http.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, createMockPi, deepseekModel, withEnv, withTempCache } from "./helpers.mjs";

const page = "https://example.com/page?x=one&y=two";
const fakePerplexity = "unit-test-perplexity-secret";
const fakeKeenable = "unit-test-keenable-secret";
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const providers = candidates => candidates.map(candidate => candidate.model.provider);

function apiContext() { return createMockCtx({ model: undefined, availableModels: [] }); }

async function withKeys(keys, fn) {
  return withTempCache(() => withEnv({ PERPLEXITY_API_KEY: undefined, KEENABLE_API_KEY: undefined, ...keys }, fn));
}

test("Perplexity standard Search API preserves server_time and source dates while omitting request id", async (t) => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, async () => {
    const search = {
      results: [{ title: "raw", url: page, snippet: "text", date: "2026-01-01", last_updated: "2026-01-02", extra: { id: "source-id", server_time: "page content" } }],
      server_time: "2026-01-02T03:04:05Z",
      unknown: [1],
    };
    const raw = { ...search, id: "search-id" };
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.perplexity.ai/search");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.get("Authorization"), `Bearer ${fakePerplexity}`);
      assert.deepEqual(JSON.parse(init.body), { query: "query", search_type: "web", max_results: 10 });
      return json(raw);
    });
    const ctx = apiContext();
    t.mock.method(ctx.modelRegistry, "getApiKeyAndHeaders", () => assert.fail("no model credentials should be used"));
    const result = await runWebSearch({ query: "query" }, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { search });
    assert.deepEqual(result.details.routes, [{ phase: "search", provider: "perplexity", endpoint: "/search" }]);
    assert.equal(perplexityAdapter.fetch, undefined);
    assert.equal(perplexityAdapter.supportsUrls, false);
    assert.doesNotMatch(readFileSync(getCachePath(), "utf8"), /unit-test.*secret/);
  });
});

test("Perplexity alone exposes only query, independent of the conversation model", async () => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, () => {
    const pi = createMockPi();
    const result = createWebSearchToolManager(pi).sync(apiContext());
    assert.deepEqual(result, { expose: true, allowUrls: false });
    const schema = pi.tools.get("web_search").parameters;
    assert.equal(schema.properties.urls, undefined);
    assert.deepEqual(schema.required, ["query"]);
    assert.doesNotMatch(schema.properties.query.description, /fetch|\burls?\b/i);
  });
});

test("keyed Keenable omits search mode and search/fetch billing while preserving source content and truncation metadata", async (t) => {
  await withKeys({ KEENABLE_API_KEY: fakeKeenable }, async () => {
    const search = {
      query: "query",
      results: [{ title: "Page", url: page, snippet: "Usage documentation", published_at: "2026-01-01", acquired_at: "2026-01-02", extra: { usage: "page content", mode: "page content" } }],
      unknown: true,
    };
    const document = {
      url: page, content: 'Raw markdown describing "usage": { "credits": 1 }', title: "page", author: "author",
      published_at: "2026-01-01", truncated: true, total_chars: 60000, unknown: ["raw"], extra: { usage: "page content" },
    };
    const usage = { sku: "search.pro", amount: 1, credits: 1, paid: false, credits_remaining: 99989 };
    const rawSearch = { ...search, mode: "pro", usage };
    const rawPage = { ...document, usage: { ...usage, sku: "fetch.live" } };
    const methods = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const target = new URL(url);
      methods.push(init.method);
      assert.equal(init.headers.get("X-API-Key"), fakeKeenable);
      assert.equal(init.headers.has("Authorization"), false);
      if (target.pathname === "/v1/search") {
        assert.deepEqual(JSON.parse(init.body), { query: "query", mode: "pro", max_results: 10 });
        return json(rawSearch);
      }
      assert.equal(target.pathname, "/v1/fetch");
      assert.equal(target.searchParams.get("url"), page);
      assert.equal(target.searchParams.get("live"), "true");
      assert.equal(target.searchParams.has("prompt"), false);
      assert.equal(init.body, undefined);
      return json(rawPage);
    });
    const result = await runWebSearch({ query: "query", urls: [page] }, apiContext());
    assert.equal(result.isError, undefined);
    assert.deepEqual(methods, ["POST", "GET"]);
    assert.deepEqual(JSON.parse(result.content[0].text), { search, fetched: [{ url: page, data: document }] });
  });
});

test("Keenable public access is opt-in and uses documented public paths and application header", async (t) => {
  await withKeys({}, async () => {
    assert.deepEqual(getSearchCandidates(resolveResolutionContext(apiContext())), []);
    writeProviderPreferences({ version: 1, apis: { keenable: true } });
    const paths = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const target = new URL(url);
      paths.push(target.pathname);
      assert.equal(init.headers.get("X-Keenable-Title"), "pi-better-web-search");
      assert.equal(init.headers.has("X-API-Key"), false);
      return json(target.pathname.includes("/search") ? { results: [] } : { url: page, content: "public page" });
    });
    const result = await runWebSearch({ query: "query", urls: [page] }, apiContext());
    assert.equal(result.isError, undefined);
    assert.deepEqual(paths, ["/v1/search/public", "/v1/fetch/public"]);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      search: { results: [] }, fetched: [{ url: page, data: { url: page, content: "public page" } }],
    });
    const pi = createMockPi();
    assert.deepEqual(createWebSearchToolManager(pi).sync(apiContext()), { expose: true, allowUrls: true });
  });
});

test("explicit preferences outrank configured APIs, which outrank native current/cache hints", async () => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity, KEENABLE_API_KEY: fakeKeenable }, () => {
    const current = deepseekModel();
    const ctx = createMockCtx({ model: current, availableModels: [current] });
    let resolution = resolveResolutionContext(ctx);
    assert.deepEqual(providers(getSearchCandidates(resolution)), ["keenable", "perplexity", "deepseek"]);
    assert.deepEqual(providers(getFetchCandidates(resolution)), ["keenable", "deepseek"]);
    writeProviderPreferences({ version: 1, search: "deepseek", fetch: "deepseek" });
    resolution = resolveResolutionContext(ctx);
    assert.deepEqual(providers(getSearchCandidates(resolution)), ["deepseek", "keenable", "perplexity"]);
    assert.deepEqual(providers(getFetchCandidates(resolution)), ["deepseek", "keenable"]);
    writeProviderPreferences({ version: 1, fetch: "perplexity", apis: { perplexity: false } });
    resolution = resolveResolutionContext(ctx);
    assert.deepEqual(providers(getSearchCandidates(resolution)), ["keenable", "deepseek"]);
    assert.deepEqual(providers(getFetchCandidates(resolution)), ["keenable", "deepseek"]);
  });
});

test("failed APIs fall back to each other and native providers without replacing user preferences", async (t) => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity, KEENABLE_API_KEY: fakeKeenable }, async () => {
    writeProviderPreferences({ version: 1, search: "perplexity" });
    const model = deepseekModel();
    const calls = [];
    t.mock.method(globalThis, "fetch", async url => {
      calls.push(new URL(url).hostname);
      return json({ error: "service unavailable" }, 503);
    });
    t.mock.method(ADAPTERS.deepseek, "search", async () => { calls.push("native"); return { results: [] }; });
    const result = await runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model] }));
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ["api.perplexity.ai", "api.keenable.ai", "native"]);
    assert.equal(result.details.attempts.length, 2);
    assert.equal(readCache().search.provider, "deepseek");
    assert.equal(readProviderPreferences().search, "perplexity");
  });
});

test("explicit native selection is used without issuing unnecessary dedicated API calls", async (t) => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, async () => {
    writeProviderPreferences({ version: 1, search: "deepseek" });
    const model = deepseekModel();
    t.mock.method(globalThis, "fetch", () => assert.fail("selected native provider succeeds first"));
    t.mock.method(ADAPTERS.deepseek, "search", async () => ({ results: [] }));
    const result = await runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model] }));
    assert.equal(result.details.provider, "deepseek");
  });
});

test("Perplexity search is retained when fetch is unavailable or fails", async (t) => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, async () => {
    t.mock.method(globalThis, "fetch", async () => json({ results: [{ title: "preserved" }], id: "id" }));
    const result = await runWebSearch({ query: "query", urls: [page] }, apiContext());
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.search.results[0].title, "preserved");
    assert.match(output.fetched[0].error, /URL fetch is not available/);
  });
});

test("Keenable target failures are per-URL; later global failures preserve successful pages", async (t) => {
  await withKeys({ KEENABLE_API_KEY: fakeKeenable }, async () => {
    const urls = [page, "https://example.com/blocked", "https://example.com/missing", "https://example.com/outage", "https://example.com/unrequested"];
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) return json({ url: page, content: "preserved" });
      if (calls === 2) return json({ error: "Upstream forbidden", message: "target blocked", code: "target_blocked" }, 403);
      if (calls === 3) return json({ error: "Not found", message: "page missing" }, 404);
      return json({ error: "Unavailable", message: "provider outage" }, 503);
    });
    const result = await keenableAdapter.fetch(apiContext(), null, urls);
    assert.equal(calls, 4);
    assert.equal(result.entries[0].data.content, "preserved");
    assert.match(result.entries[1].error, /target blocked/);
    assert.match(result.entries[2].error, /page missing/);
    assert.match(result.providerError, /provider outage/);
  });
});

test("Keenable billing and credential failures stop the batch without anonymous downgrade", async (t) => {
  await withKeys({ KEENABLE_API_KEY: fakeKeenable }, async () => {
    for (const status of [401, 402, 403]) {
      const mock = t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(new URL(url).pathname, "/v1/fetch");
        assert.equal(init.headers.get("X-API-Key"), fakeKeenable);
        return json({ error: "Rejected", message: "account rejected", code: "credentials_forbidden" }, status);
      });
      const result = await keenableAdapter.fetch(apiContext(), null, [page, "https://example.com/other"]);
      assert.equal(mock.mock.callCount(), 1);
      assert.match(result.providerError, /account rejected/);
      if (status === 402) assert.match(result.providerError, /"error":"Rejected"/);
      mock.mock.restore();
    }
  });
});

test("Retry-After is honored across calls and search/fetch, including HTTP-date values", async (t) => {
  for (const dateHeader of [false, true]) {
    await withKeys({ KEENABLE_API_KEY: fakeKeenable }, async () => {
      let now = Date.now();
      const clock = t.mock.method(Date, "now", () => now);
      let calls = 0;
      const mock = t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return calls === 1 ? json({ message: "rate limited" }, 429, { "Retry-After": dateHeader ? new Date(now + 60000).toUTCString() : "60" }) : json({ results: [] });
      });
      await assert.rejects(() => keenableAdapter.search(apiContext(), null, "query"), { status: 429 });
      await assert.rejects(() => keenableAdapter.search(apiContext(), null, "query"), /Retry-After is active/);
      const fetched = await keenableAdapter.fetch(apiContext(), null, [page]);
      assert.match(fetched.providerError, /Retry-After is active/);
      assert.equal(calls, 1);
      now += 61000;
      assert.deepEqual(await keenableAdapter.search(apiContext(), null, "query"), { results: [] });
      assert.equal(calls, 2);
      mock.mock.restore(); clock.mock.restore();
    });
  }
});

test("API keys are redacted from provider errors; malformed successful responses trigger fallback", async (t) => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, async () => {
    let mode = "secret";
    t.mock.method(globalThis, "fetch", async () => mode === "secret" ? json({ message: `echo ${fakePerplexity}` }, 401) : json({ wrong: [] }));
    await assert.rejects(() => perplexityAdapter.search(apiContext(), null, "query"), error => {
      assert.ok(error instanceof HttpError);
      assert.doesNotMatch(error.message, /unit-test-perplexity-secret/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.equal(error.body, undefined);
      return true;
    });
    mode = "malformed";
    await assert.rejects(() => perplexityAdapter.search(apiContext(), null, "query"), /no results array/);
  });
});

test("missing Perplexity credentials fail before HTTP, with safe console instructions", async (t) => {
  await withKeys({}, async () => {
    const mock = t.mock.method(globalThis, "fetch", () => assert.fail("no key must not make a request"));
    await assert.rejects(() => perplexityAdapter.search(apiContext(), null, "query"), /PERPLEXITY_API_KEY.*console.perplexity.ai/);
    assert.equal(mock.mock.callCount(), 0);
    assert.equal(dedicatedState("perplexity", { perplexity: true }).available, false);
  });
});

test("dedicated API configuration/auth-mode changes invalidate fingerprints without persisting secrets", async () => {
  await withKeys({}, async () => {
    const ctx = apiContext();
    const initial = fingerprintAvailableModels(ctx);
    writeProviderPreferences({ version: 1, search: "deepseek", apis: { keenable: true, apiKey: "must-not-persist" } });
    const keyless = fingerprintAvailableModels(ctx);
    assert.notEqual(initial, keyless);
    await withEnv({ KEENABLE_API_KEY: fakeKeenable }, () => {
      assert.notEqual(fingerprintAvailableModels(ctx), keyless);
      assert.equal(resolveResolutionContext(ctx).fingerprint, fingerprintAvailableModels(ctx));
    });
    const settings = readFileSync(getPreferencesPath(), "utf8");
    assert.doesNotMatch(settings, /must-not-persist|unit-test|apiKey/);
    assert.equal(readProviderPreferences().search, "deepseek");
    writeProviderPreferences({ version: 1, apis: { keenable: false } });
    assert.equal(fingerprintAvailableModels(ctx), initial);
  });
});

test("terminal API configuration requires keyless consent, persists toggles only and resyncs schema", async () => {
  await withKeys({}, async () => {
    const pi = createMockPi(); piBetterWebSearch(pi);
    const ctx = apiContext(); ctx.hasUI = true;
    const notifications = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    ctx.ui.select = async (_title, options) => options.find(option => option.startsWith("Enable"));
    ctx.ui.confirm = async () => false;
    const command = pi.commands.get(API_COMMAND_NAME);
    await command.handler("keenable", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1 });
    ctx.ui.confirm = async () => true;
    await command.handler("keenable", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1, apis: { keenable: true } });
    assert.ok(pi.getActiveTools().includes("web_search"));
    assert.ok(pi.tools.get("web_search").parameters.properties.urls);
    ctx.ui.select = async (_title, options) => options.find(option => option.startsWith("Disable"));
    await command.handler("keenable", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1, apis: { keenable: false } });
    assert.equal(pi.getActiveTools().includes("web_search"), false);
    assert.doesNotMatch(JSON.stringify(notifications), /unit-test/);
  });
});

test("API identity wins over a same-named model provider without registering a new model", async () => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, () => {
    const registryModel = { ...deepseekModel(), provider: "perplexity", id: "gpt-9-luna", api: "openai-responses" };
    const ctx = createMockCtx({ model: registryModel, availableModels: [registryModel] });
    const first = getSearchCandidates(resolveResolutionContext(ctx))[0];
    assert.equal(first.adapter, perplexityAdapter);
    assert.equal(first.model.id, "search");
    assert.deepEqual(ctx.modelRegistry.getAvailable(), [registryModel]);
  });
});

test("key rotation does not inherit Retry-After and malformed header keys never appear in errors", async (t) => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, async () => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? json({ message: "limited" }, 429, { "Retry-After": "600" }) : json({ results: [] }));
    await assert.rejects(() => perplexityAdapter.search(apiContext(), null, "query"), { status: 429 });
    await withEnv({ PERPLEXITY_API_KEY: "unit-test-new-credential" }, async () => {
      assert.deepEqual(await perplexityAdapter.search(apiContext(), null, "query"), { results: [] });
    });
    await withEnv({ PERPLEXITY_API_KEY: "unit-test-invalid\ncredential" }, async () => {
      await assert.rejects(() => perplexityAdapter.search(apiContext(), null, "query"), error => {
        assert.match(error.message, /invalid header characters/);
        assert.doesNotMatch(error.message, /unit-test-invalid/);
        return true;
      });
    });
    assert.equal(calls, 2);
  });
});

test("API configuration picker preserves phase preferences, avoids key entry and reports save failures", async () => {
  await withKeys({ PERPLEXITY_API_KEY: fakePerplexity }, async () => {
    const pi = createMockPi(); piBetterWebSearch(pi);
    const ctx = apiContext(); ctx.hasUI = true;
    const notifications = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    const dialogs = [];
    ctx.ui.select = async (title, options) => {
      dialogs.push({ title, options });
      return options.find(option => option.startsWith("Perplexity Search —")) ?? options.find(option => option.startsWith("Disable"));
    };
    ctx.ui.input = () => assert.fail("never ask for a secret");
    writeProviderPreferences({ version: 1, search: "deepseek", fetch: "google" });
    const command = pi.commands.get(API_COMMAND_NAME);
    await command.handler("", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1, search: "deepseek", fetch: "google", apis: { perplexity: false } });
    assert.doesNotMatch(JSON.stringify(dialogs), /unit-test-perplexity-secret/);
    // A directory cannot be overwritten as a settings file.
    await withEnv({ PI_BETTER_WEB_SEARCH_SETTINGS: dirname(getPreferencesPath()) }, () => command.handler("perplexity", ctx));
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /Could not save/);
  });
});

test("API menus support setup, missing keys, Auto reset, cancellation and invalid/noninteractive calls", async () => {
  await withKeys({}, async () => {
    const pi = createMockPi(); piBetterWebSearch(pi);
    const ctx = apiContext(); ctx.hasUI = true;
    const notifications = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    let pick = (_title, options) => options.find(option => option.startsWith("Show setup"));
    ctx.ui.select = (...args) => pick(...args);
    const command = pi.commands.get(API_COMMAND_NAME);
    await command.handler("perplexity", ctx);
    assert.match(notifications.at(-1).message, /console.perplexity.ai.*PERPLEXITY_API_KEY/);
    pick = (_title, options) => options.find(option => option.startsWith("Enable"));
    await command.handler("perplexity", ctx);
    assert.equal(notifications.at(-1).level, "warning");
    assert.equal(dedicatedState("perplexity", readProviderPreferences().apis).available, false);
    pick = (_title, options) => options[0];
    await command.handler("perplexity", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1 });
    pick = () => undefined;
    await command.handler("", ctx);
    await command.handler("perplexity", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1 });
    await command.handler("bad", ctx);
    assert.match(notifications.at(-1).message, /Usage:/);
    ctx.hasUI = false;
    await command.handler("perplexity", ctx);
    assert.match(notifications.at(-1).message, /interactive UI/);
  });
});
