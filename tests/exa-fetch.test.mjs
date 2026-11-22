import assert from "node:assert/strict";
import test from "node:test";
import { readCache } from "../lib/cache.ts";
import { writeProviderPreferences } from "../lib/preferences.ts";
import { ADAPTERS, exaAdapter } from "../lib/providers/index.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, withEnv, withTempCache } from "./helpers.mjs";

const key = "unit-test-exa-fetch-secret";
const page = "https://example.com/page";
const other = "https://example.com/other";
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const ctx = () => createMockCtx({ availableModels: [] });
const withExa = fn => withTempCache(() => withEnv({ EXA_API_KEY: key }, fn));

test("Exa URL-only fetch batches /contents with top-level text, raw documents and the actual fetch route", async (t) => {
  await withExa(async () => {
    const pages = [
      { id: page, url: page, title: "Raw page", text: "full page body", unknown: { kept: true } },
      { id: other, url: other, title: "Empty page", text: "" },
    ];
    const mock = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.exa.ai/contents");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.get("X-API-Key"), key);
      assert.equal(init.headers.get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(init.body), { urls: [page, other], text: true });
      assert.ok(init.signal instanceof AbortSignal);
      return json({ requestId: "fetch-1", costDollars: { total: 0.01 }, searchTime: 0.12, results: pages, statuses: [other, page].map(id => ({ id, status: "success" })) });
    });
    const result = await runWebSearch({ urls: [page, other] }, ctx());
    assert.equal(result.isError, undefined);
    assert.equal(mock.mock.callCount(), 1);
    const parsed = JSON.parse(result.content[0].text);
    assert.match(parsed.current_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(parsed, { current_time: parsed.current_time, fetched: pages.map((data, i) => ({ url: [page, other][i], data })) });
    assert.deepEqual(result.details.routes, [{ phase: "fetch", provider: "exa", endpoint: "/contents" }]);
    assert.equal(result.details.fetchedCount, 2);
    assert.deepEqual(readCache().fetch, { provider: "exa", model: "search-fetch" });
  });
});

test("Exa combined calls keep search highlights separate from full-text fetch", async (t) => {
  await withExa(async () => {
    const calls = [];
    const search = { results: [{ url: page, highlights: ["excerpt"], extra: true }] };
    const document = { id: page, url: page, text: "full page", extra: [1, 2] };
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/search") {
        assert.deepEqual(JSON.parse(init.body), { query: "query", numResults: 10, contents: { highlights: true } });
        return json({ ...search, requestId: "search-1" });
      }
      assert.deepEqual(JSON.parse(init.body), { urls: [page], text: true });
      return json({ results: [document], statuses: [{ id: page, status: "success" }] });
    });
    const result = await runWebSearch({ query: "query", urls: [page] }, ctx());
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ["/search", "/contents"]);
    const parsed = JSON.parse(result.content[0].text);
    assert.match(parsed.current_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(parsed, { current_time: parsed.current_time, search, fetched: [{ url: page, data: document }] });
    assert.deepEqual(result.details.routes, [
      { phase: "search", provider: "exa", endpoint: "/search" },
      { phase: "fetch", provider: "exa", endpoint: "/contents" },
    ]);
  });
});

test("Exa contents matches requested identities, not order; redirects and duplicate URLs retain raw data", async (t) => {
  await withExa(async () => {
    const missing = "https://example.com/missing";
    const noText = "https://example.com/no-text";
    const redirected = { id: page, url: "https://example.com/canonical", text: "redirected", extra: true };
    const second = { url: other, text: "second" };
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).urls, [page, other, missing, noText, page]);
      return json({
        results: [second, { url: "https://example.com/unrequested", text: "do not assign by index" }, redirected, { url: noText }],
        statuses: [{ id: missing, status: "error", error: { tag: "NOT_FOUND" } }, { id: page, status: "success" }, { id: other, status: "success" }],
      });
    });
    const result = await exaAdapter.fetch(ctx(), null, [page, other, missing, noText, page]);
    assert.deepEqual(result.entries[0], { url: page, data: redirected });
    assert.deepEqual(result.entries[1], { url: other, data: second });
    assert.match(result.entries[2].error, /NOT_FOUND/);
    assert.match(result.entries[3].error, /no page text/);
    assert.deepEqual(result.entries[4], { url: page, data: redirected });
    assert.equal(result.providerError, undefined);
  });
});

test("Exa HTTP-200 error statuses override page data and do not poison successful URLs", async (t) => {
  await withExa(async () => {
    const tags = ["CRAWL_TIMEOUT", "UNSUPPORTED_URL", "SOURCE_UNAVAILABLE", "NOT_FOUND"];
    const urls = tags.map(tag => `https://example.com/${tag}`);
    t.mock.method(globalThis, "fetch", async () => json({
      results: [{ url: page, text: "valid" }, ...urls.map(url => ({ url, text: "must not count as success" }))],
      statuses: [
        { id: page, status: "success" },
        ...urls.map((id, i) => ({ id, status: "error", error: { tag: tags[i], message: `failed ${key}` } })),
      ],
    }));
    const result = await runWebSearch({ urls: [page, ...urls] }, ctx());
    assert.equal(result.isError, undefined);
    assert.equal(result.details.fetchedCount, 1);
    assert.equal(result.details.fetchFailedCount, 4);
    assert.deepEqual(result.details.attempts, []);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.fetched[0].data.text, "valid");
    for (let i = 0; i < urls.length; i++) {
      assert.ok(output.fetched[i + 1].error.includes(tags[i]));
      assert.equal(output.fetched[i + 1].data, undefined);
    }
    assert.doesNotMatch(JSON.stringify(result), /unit-test-exa-fetch-secret/);
  });
});

test("Exa contents also honors flat tags, canonical statuses, missing documents and non-success statuses", async (t) => {
  await withExa(async () => {
    const cases = [
      { result: { url: page, text: "not valid" }, status: { id: page, status: "error", tag: "CRAWL_TIMEOUT" }, error: /CRAWL_TIMEOUT/ },
      { result: { id: page, url: other, text: "not valid" }, status: { id: other, status: "error", error: "source unavailable" }, error: /source unavailable/ },
      { result: { url: page, text: "not ready" }, status: { id: page, status: "pending" }, error: /pending/ },
      { status: { id: page, status: "success" }, error: /no page text/ },
    ];
    for (const entry of cases) {
      const mock = t.mock.method(globalThis, "fetch", async () => json({ results: entry.result ? [entry.result] : [], statuses: [entry.status] }));
      const result = await exaAdapter.fetch(ctx(), null, [page]);
      assert.match(result.entries[0].error, entry.error);
      assert.equal(result.entries[0].data, undefined);
      mock.mock.restore();
    }
  });
});

test("Exa contents permits missing statuses but never assigns unrequested results to requested URLs", async (t) => {
  await withExa(async () => {
    t.mock.method(globalThis, "fetch", async () => json({ results: [{ url: other, text: "raw text" }] }));
    const result = await exaAdapter.fetch(ctx(), null, [page, other]);
    assert.match(result.entries[0].error, /no page text/);
    assert.deepEqual(result.entries[1], { url: other, data: { url: other, text: "raw text" } });
  });
});

test("Exa fetch fallback retries only failed URLs and preserves successful raw documents", async (t) => {
  await withExa(async () => {
    writeProviderPreferences({ version: 1, fetch: "exa" });
    const model = deepseekModel();
    const raw = { id: page, url: page, text: "preserved", nested: { unknown: [1] } };
    t.mock.method(globalThis, "fetch", async () => json({ results: [raw], statuses: [
      { id: page, status: "success" }, { id: other, status: "error", error: { tag: "NOT_FOUND" } },
    ] }));
    const fallback = t.mock.method(ADAPTERS.deepseek, "fetch", async (_ctx, _model, urls) => {
      assert.deepEqual(urls, [other]);
      return { entries: [{ url: other, data: { content: "fallback" } }] };
    });
    const result = await runWebSearch({ urls: [page, other] }, createMockCtx({ model, availableModels: [model] }));
    assert.equal(result.isError, undefined);
    assert.equal(fallback.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(result.content[0].text).fetched, [
      { url: page, data: raw }, { url: other, data: { content: "fallback" } },
    ]);
    assert.deepEqual(result.details.routes, [
      { phase: "fetch", provider: "exa", endpoint: "/contents" },
      { phase: "fetch", provider: "deepseek", endpoint: "/v1/tools/fetch" },
    ]);
  });
});

test("Exa still fetches requested pages after its search fails", async (t) => {
  await withExa(async () => {
    t.mock.method(globalThis, "fetch", async url => new URL(url).pathname === "/search"
      ? json({ error: "search unavailable" }, 503)
      : json({ results: [{ url: page, text: "useful page" }], statuses: [{ id: page, status: "success" }] }));
    const result = await runWebSearch({ query: "query", urls: [page] }, ctx());
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.match(output.search.error, /search unavailable/);
    assert.equal(output.fetched[0].data.text, "useful page");
  });
});

test("Exa contents rejects malformed response containers and global HTTP failures without hidden retries", async (t) => {
  await withExa(async () => {
    for (const data of [{}, { results: {} }, { results: [], statuses: {} }]) {
      const mock = t.mock.method(globalThis, "fetch", async () => json(data));
      await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page]), /no results array|invalid statuses array/);
      mock.mock.restore();
    }
    for (const status of [401, 402, 403, 429, 503]) {
      const mock = t.mock.method(globalThis, "fetch", async () => json({ message: `rejected ${key}` }, status));
      await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page, other]), error => {
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /unit-test-exa-fetch-secret/);
        return true;
      });
      assert.equal(mock.mock.callCount(), 1);
      mock.mock.restore();
    }
  });
});

test("Exa contents propagates cancellation and shares Retry-After with search", async (t) => {
  await withExa(async () => {
    const controller = new AbortController();
    let mock = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw controller.signal.reason;
    });
    await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page], undefined, controller.signal), { name: "AbortError" });
    await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page], undefined, controller.signal), { name: "AbortError" });
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
    mock = t.mock.method(globalThis, "fetch", async () => json({ error: "rate limited" }, 429, { "Retry-After": "60" }));
    await assert.rejects(() => exaAdapter.fetch(ctx(), null, [page]), { status: 429 });
    await assert.rejects(() => exaAdapter.search(ctx(), null, "query"), /Retry-After is active/);
    assert.equal(mock.mock.callCount(), 1);
  });
});
