import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS } from "../lib/providers/index.ts";
import { allowExplicitAttempt, dedicatedRequest } from "../lib/providers/dedicated-http.ts";
import { isProviderCoolingDown, recordProviderFailure } from "../lib/health.ts";
import { writeProviderPreferences } from "../lib/preferences.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, withEnv, withTempCache } from "./helpers.mjs";

const keys = { KEENABLE_API_KEY: "key-k", EXA_API_KEY: "key-e", PERPLEXITY_API_KEY: "key-p", DEEPSEEK_API_KEY: "key-d" };
const page = "https://example.com/page";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test("all configured APIs precede the current model even after prior failures, including same-provider DeepSeek", async t => {
  await withTempCache(() => withEnv(keys, async () => {
    const model = deepseekModel();
    const ctx = createMockCtx({ model, availableModels: [model] });
    const calls = [];
    t.mock.method(globalThis, "fetch", async url => {
      calls.push(new URL(url).hostname);
      return json({ message: "unavailable" }, 503);
    });
    t.mock.method(ADAPTERS.deepseek, "search", async (_ctx, candidate) => {
      calls.push(candidate.api === "dedicated-web-search" ? "dedicated deepseek" : "native deepseek");
      if (candidate.api === "dedicated-web-search") throw new Error("HTTP 503 unavailable");
      return { results: [] };
    });
    t.mock.method(ADAPTERS.deepseek, "fetch", async (_ctx, candidate, urls) => {
      calls.push(candidate.api === "dedicated-web-search" ? "dedicated deepseek fetch" : "native deepseek fetch");
      if (candidate.api === "dedicated-web-search") throw new Error("HTTP 503 unavailable");
      return { entries: urls.map(url => ({ url, data: {} })) };
    });
    for (let i = 0; i < 2; i++) {
      calls.length = 0;
      const result = await runWebSearch({ query: "query", urls: [page] }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls, ["api.keenable.ai", "api.exa.ai", "api.perplexity.ai", "dedicated deepseek", "native deepseek", "api.keenable.ai", "api.exa.ai", "dedicated deepseek fetch", "native deepseek fetch"]);
    }
  }));
});

test("standalone DeepSeek health cannot cool or clear native DeepSeek health", async t => {
  await withTempCache(() => withEnv({ ...keys, KEENABLE_API_KEY: undefined, EXA_API_KEY: undefined, PERPLEXITY_API_KEY: undefined }, async () => {
    const model = deepseekModel();
    const ctx = createMockCtx({ model, availableModels: [model] });
    let standaloneFails = true;
    t.mock.method(ADAPTERS.deepseek, "search", async (_ctx, candidate) => {
      if (candidate.api === "dedicated-web-search" && standaloneFails) throw new Error("HTTP 503 unavailable");
      return { results: [] };
    });
    await runWebSearch({ query: "query" }, ctx);
    assert.equal(isProviderCoolingDown("search", "deepseek"), false);
    recordProviderFailure("search", "deepseek", "HTTP 503");
    standaloneFails = false;
    await runWebSearch({ query: "query" }, ctx);
    assert.equal(isProviderCoolingDown("search", "deepseek"), true);
  }));
});

test("one explicit probe does not remove the server backoff for automatic requests", async t => {
  await withTempCache(() => withEnv({ EXA_API_KEY: keys.EXA_API_KEY }, async () => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return calls === 1 ? json({ message: "limited" }, 429, { "Retry-After": "3600" }) : json({ results: [] });
    });
    const request = signal => dedicatedRequest("exa", "https://api.exa.ai/search", { method: "POST" }, signal);
    await assert.rejects(request(), /429/);
    const signal = AbortSignal.timeout(10_000);
    allowExplicitAttempt(signal);
    await request(signal);
    await assert.rejects(request(), /Retry-After is active/);
    assert.equal(calls, 2);
  }));
});

test("an in-flight explicit probe cannot clear or shorten a concurrent Retry-After", async t => {
  await withTempCache(() => withEnv({ EXA_API_KEY: keys.EXA_API_KEY }, async () => {
    let calls = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) return json({ message: "limited" }, 429, { "Retry-After": "3600" });
      await pending;
      return json({ message: "still limited" }, 429, { "Retry-After": "1" });
    });
    const request = signal => dedicatedRequest("exa", "https://api.exa.ai/search", { method: "POST" }, signal);
    await assert.rejects(request(), /429/);
    const signal = AbortSignal.timeout(10_000);
    allowExplicitAttempt(signal);
    const forced = request(signal);
    await assert.rejects(request(), /Retry-After is active/);
    release();
    await assert.rejects(forced, /429/);
    await assert.rejects(request(), /Retry in 3[5-6]\d\d seconds/);
    assert.equal(calls, 2);
  }));
});

test("explicit standalone preference retries first despite health cooldown and Retry-After in both phases", async t => {
  await withTempCache(() => withEnv(keys, async () => {
    writeProviderPreferences({ version: 1, search: "perplexity", fetch: "exa" });
    const calls = [];
    const counts = new Map();
    t.mock.method(globalThis, "fetch", async url => {
      const host = new URL(url).hostname;
      calls.push(host);
      counts.set(host, (counts.get(host) ?? 0) + 1);
      if (host === "api.perplexity.ai" || host === "api.exa.ai") {
        if (counts.get(host) === 1) return json({ message: "limited" }, 429, { "Retry-After": "3600" });
        return json(host === "api.exa.ai" ? { results: [{ id: page, url: page, text: "ok" }] } : { results: [] });
      }
      return json({ results: [], url: page, content: "ok" });
    });
    const ctx = createMockCtx({ model: undefined, availableModels: [] });
    await runWebSearch({ query: "query", urls: [page] }, ctx);
    calls.length = 0;
    const result = await runWebSearch({ query: "query", urls: [page] }, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ["api.perplexity.ai", "api.exa.ai"]);
  }));
});
