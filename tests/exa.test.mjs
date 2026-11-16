import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import piBetterWebSearch, { createWebSearchToolManager } from "../extensions/index.ts";
import { API_COMMAND_NAME } from "../lib/api-command.ts";
import { fingerprintAvailableModels, getCachePath, readCache } from "../lib/cache.ts";
import { getFetchCandidates, getSearchCandidates, getSelectableProviders, resolveResolutionContext } from "../lib/candidates.ts";
import { dedicatedState } from "../lib/dedicated-config.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { ADAPTERS, exaAdapter } from "../lib/providers/index.ts";
import { HttpError } from "../lib/providers/http.ts";
import { WEB_SEARCH_DESCRIPTION } from "../lib/schema.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, createMockPi, deepseekModel, withEnv, withTempCache } from "./helpers.mjs";

const key = "unit-test-exa-secret";
const page = "https://example.com/page";
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const ctx = () => createMockCtx({ availableModels: [] });
const providers = candidates => candidates.map(candidate => candidate.model.provider);
const withExa = fn => withTempCache(() => withEnv({ EXA_API_KEY: key }, fn));

test("Exa search omits API bookkeeping while preserving highlights, notices and unknown content", async (t) => {
  await withExa(async () => {
    const search = {
      results: [{ id: page, title: "Page", url: page, publishedDate: "2026-01-01", author: "Author", score: 0.98, highlights: ["raw excerpt"], extra: { requestId: "source-id", costDollars: "page content" } }],
      notices: [{ tag: "RESULTS_FROM_CACHE", message: "Some results were served from the index." }],
      unknown: { preserved: true },
    };
    const raw = {
      ...search, requestId: "request-1", costDollars: { total: 0.01 }, searchTime: 0.12,
      warnings: [{ tag: "IGNORED_FIELD", message: "A deprecated request field was ignored." }], resolvedSearchType: "",
    };
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.exa.ai/search");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.get("x-api-key"), key);
      assert.equal(init.headers.has("Authorization"), false);
      assert.equal(init.headers.get("Content-Type"), "application/json");
      assert.equal(init.headers.get("Accept"), "application/json");
      // Only the user-approved count and extraction mode; no objective or filters.
      assert.deepEqual(JSON.parse(init.body), {
        query: "natural language query", numResults: 10, contents: { highlights: true },
      });
      assert.ok(init.signal instanceof AbortSignal);
      return json(raw);
    });
    const context = ctx();
    t.mock.method(context.modelRegistry, "getApiKeyAndHeaders", () => assert.fail("Exa must not need a chat-model credential"));
    const result = await runWebSearch({ query: " natural language query " }, context);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { query: "natural language query", search });
    assert.deepEqual(result.details.routes, [{ phase: "search", provider: "exa", endpoint: "/search" }]);
    assert.equal(result.details.resultCount, 1);
    assert.equal(readCache().search.provider, "exa");
    assert.doesNotMatch(readFileSync(getCachePath(), "utf8"), /unit-test-exa-secret/);
  });
});

test("Exa alone exposes search and fetch with only the existing query/urls parameters", async () => {
  await withExa(async () => {
    const pi = createMockPi();
    const manager = createWebSearchToolManager(pi);
    assert.deepEqual(manager.sync(ctx()), { expose: true, allowUrls: true });
    const tool = pi.tools.get("web_search");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["query", "urls"]);
    assert.equal(tool.parameters.required, undefined);
    assert.equal(tool.description, WEB_SEARCH_DESCRIPTION);
    assert.equal(tool.promptGuidelines, undefined);
    assert.equal(exaAdapter.supportsUrls, true);
    assert.equal(typeof exaAdapter.fetch, "function");
    assert.deepEqual(providers(getFetchCandidates(resolveResolutionContext(ctx()))), ["exa"]);
    assert.deepEqual(providers(getSelectableProviders(resolveResolutionContext(ctx()), "search")), ["exa"]);
    assert.deepEqual(providers(getSelectableProviders(resolveResolutionContext(ctx()), "fetch")), ["exa"]);
    await withEnv({ KEENABLE_API_KEY: "unit-test-keenable-secret" }, () => {
      assert.deepEqual(manager.sync(ctx()), { expose: true, allowUrls: true });
      assert.deepEqual(Object.keys(pi.tools.get("web_search").parameters.properties), ["query", "urls"]);
      assert.deepEqual(providers(getSelectableProviders(resolveResolutionContext(ctx()), "fetch")), ["keenable", "exa"]);
    });
  });
});

test("missing Exa credentials block HTTP even after explicit enable; settings can disable an existing key", async (t) => {
  await withTempCache(async () => {
    t.mock.method(globalThis, "fetch", () => assert.fail("must not send an unauthenticated request"));
    writeProviderPreferences({ version: 1, apis: { exa: true } });
    assert.equal(dedicatedState("exa", readProviderPreferences().apis).available, false);
    assert.deepEqual(getSearchCandidates(resolveResolutionContext(ctx())), []);
    await assert.rejects(() => exaAdapter.search(ctx(), null, "query"), /EXA_API_KEY.*dashboard.exa.ai/);
    await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page]), /EXA_API_KEY.*dashboard.exa.ai/);
    await withEnv({ EXA_API_KEY: key }, () => {
      assert.equal(dedicatedState("exa").available, true);
      writeProviderPreferences({ version: 1, apis: { exa: false } });
      assert.deepEqual(getSearchCandidates(resolveResolutionContext(ctx())), []);
    });
  });
});

test("dedicated APIs follow configured priority; explicit choices still win", async () => {
  await withExa(() => withEnv({ PERPLEXITY_API_KEY: "test-perplexity", KEENABLE_API_KEY: "test-keenable" }, () => {
    const model = deepseekModel();
    const context = createMockCtx({ model, availableModels: [model] });
    let resolution = resolveResolutionContext(context);
    assert.deepEqual(providers(getSearchCandidates(resolution)), ["keenable", "exa", "perplexity", "deepseek"]);
    assert.deepEqual(providers(getFetchCandidates(resolution)), ["keenable", "exa", "deepseek"]);
    writeProviderPreferences({ version: 1, search: "exa" });
    resolution = resolveResolutionContext(context);
    assert.deepEqual(providers(getSearchCandidates(resolution)), ["exa", "keenable", "perplexity", "deepseek"]);
  }));
});

test("Exa errors fall back to native providers without changing explicit preferences or leaking credentials", async (t) => {
  await withExa(async () => {
    const model = deepseekModel();
    writeProviderPreferences({ version: 1, search: "exa" });
    t.mock.method(globalThis, "fetch", async () => json({ message: `rejected ${key}` }, 401));
    t.mock.method(ADAPTERS.deepseek, "search", async () => ({ results: [{ url: page }] }));
    const result = await runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model] }));
    assert.equal(result.isError, undefined);
    assert.equal(result.details.provider, "deepseek");
    assert.equal(result.details.attempts.length, 1);
    assert.equal(result.details.attempts[0].provider, "exa");
    assert.match(result.details.attempts[0].message, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(result), /unit-test-exa-secret/);
    assert.equal(readProviderPreferences().search, "exa");
  });
});

test("Exa search survives missing page content and an empty search is successful", async (t) => {
  await withExa(async () => {
    t.mock.method(globalThis, "fetch", async () => json({ requestId: "empty", results: [] }));
    const result = await runWebSearch({ query: "query", urls: [page] }, ctx());
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.deepEqual(output.search, { results: [] });
    assert.match(output.fetched[0].error, /no page text/);
  });
});

test("Exa rejects malformed responses and reports auth/billing errors with redaction", async (t) => {
  await withExa(async () => {
    let response;
    t.mock.method(globalThis, "fetch", async () => response);
    for (const raw of [{}, { results: {} }, [], null]) {
      response = json(raw);
      await assert.rejects(() => exaAdapter.search(ctx(), null, "query"), /no results array|invalid response object/);
    }
    for (const status of [401, 402, 403]) {
      response = json({ error: `invalid ${key}` }, status);
      await assert.rejects(() => exaAdapter.search(ctx(), null, "query"), error => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, status);
        assert.equal(error.body, undefined);
        assert.doesNotMatch(error.message, /unit-test-exa-secret/);
        assert.match(error.message, /\{"error":"invalid \[REDACTED\]"\}/);
        return true;
      });
    }
  });
});

test("Exa Retry-After is credential-specific and does not retry HTTP calls", async (t) => {
  await withExa(async () => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return calls === 1 ? json({ error: "rate limited" }, 429, { "Retry-After": "60" }) : json({ results: [] });
    });
    await assert.rejects(() => exaAdapter.search(ctx(), null, "query"), { status: 429 });
    await assert.rejects(() => exaAdapter.search(ctx(), null, "query"), /Retry-After is active/);
    await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page]), /Retry-After is active/);
    assert.equal(calls, 1);
    await withEnv({ EXA_API_KEY: "different-exa-key" }, async () => {
      assert.deepEqual(await exaAdapter.search(ctx(), null, "query"), { results: [] });
    });
    assert.equal(calls, 2);
  });
});

test("Exa respects cancellation before HTTP and forwards in-flight cancellation", async (t) => {
  await withExa(async () => {
    const controller = new AbortController();
    const mock = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw controller.signal.reason;
    });
    await assert.rejects(() => exaAdapter.search(ctx(), null, "query", controller.signal), { name: "AbortError" });
    await assert.rejects(() => exaAdapter.search(ctx(), null, "query", controller.signal), { name: "AbortError" });
    assert.equal(mock.mock.callCount(), 1);
  });
});

test("Exa availability invalidates discovery fingerprints while settings persist toggles only", async () => {
  await withTempCache(async () => {
    const initial = fingerprintAvailableModels(ctx());
    await withEnv({ EXA_API_KEY: key }, () => {
      assert.notEqual(fingerprintAvailableModels(ctx()), initial);
      writeProviderPreferences({ version: 1, search: "exa", apis: { exa: false, apiKey: key } });
      assert.equal(fingerprintAvailableModels(ctx()), initial);
      const saved = readFileSync(getPreferencesPath(), "utf8");
      assert.doesNotMatch(saved, /unit-test-exa-secret|apiKey/);
      assert.deepEqual(readProviderPreferences(), { version: 1, search: "exa", apis: { exa: false } });
    });
  });
});

test("Exa terminal menu has safe setup, key-required enable, disable and automatic reset", async () => {
  await withTempCache(async () => {
    const pi = createMockPi();
    piBetterWebSearch(pi);
    const context = ctx(); context.hasUI = true;
    const notifications = [];
    context.ui.notify = message => notifications.push(message);
    let action = "Show setup";
    context.ui.select = async (_title, options) => options.find(option => option.startsWith(action));
    context.ui.confirm = () => assert.fail("Exa must never offer keyless access");
    const command = pi.commands.get(API_COMMAND_NAME);
    await command.handler("exa", context);
    assert.match(notifications.at(-1), /dashboard.exa.ai.*EXA_API_KEY/);
    action = "Enable";
    await command.handler("exa", context);
    assert.match(notifications.at(-1), /EXA_API_KEY is missing/);
    assert.equal(pi.getActiveTools().includes("web_search"), false);
    await withEnv({ EXA_API_KEY: key }, async () => {
      await command.handler("exa", context);
      assert.equal(pi.getActiveTools().includes("web_search"), true);
      assert.deepEqual(Object.keys(pi.tools.get("web_search").parameters.properties), ["query", "urls"]);
      action = "Disable";
      await command.handler("exa", context);
      assert.equal(pi.getActiveTools().includes("web_search"), false);
      action = "Automatic";
      await command.handler("exa", context);
      assert.deepEqual(readProviderPreferences(), { version: 1 });
      assert.equal(pi.getActiveTools().includes("web_search"), true);
    });
    assert.doesNotMatch(JSON.stringify(notifications), /unit-test-exa-secret/);
  });
});
