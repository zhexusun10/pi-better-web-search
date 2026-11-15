import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS } from "../lib/providers/index.ts";
import { readCache } from "../lib/cache.ts";
import { renderWebSearchResult } from "../lib/render.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, googleModel, openaiResponsesModel, unsupportedLocalModel, withTempCache } from "./helpers.mjs";

const page = "https://example.com/page";
const theme = { fg: (_color, text) => text, bold: text => text };

async function withProviders(patches, fn) {
  const originals = patches.map(([family, key]) => [family, key, ADAPTERS[family][key]]);
  try {
    for (const [family, key, value] of patches) ADAPTERS[family][key] = value;
    return await withTempCache(fn);
  } finally {
    for (const [family, key, value] of originals.reverse()) ADAPTERS[family][key] = value;
  }
}

function partialOutput(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.details.error, undefined);
  assert.deepEqual(result.content.map(part => part.type), ["text"]);
  return JSON.parse(result.content[0].text);
}

test("search data survives all fetch providers failing, including raw unknown fields", async () => {
  const current = openaiResponsesModel();
  const raw = { results: [{ title: "search succeeded", extra: { untouched: [1, 2] } }], answer: "raw answer" };
  await withProviders([
    ["openai", "search", async () => raw],
    ["deepseek", "fetch", async () => { throw new Error("DeepSeek API error (503): fetch unavailable"); }],
  ], async () => {
    const ctx = createMockCtx({ model: current, availableModels: [current, deepseekModel()] });
    const result = await runWebSearch({ query: "query", urls: [page] }, ctx);
    const output = partialOutput(result);
    assert.deepEqual(output.search, raw);
    assert.equal(output.fetched[0].url, page);
    assert.match(output.fetched[0].error, /503.*fetch unavailable/);
    assert.equal(result.details.fetchFailedCount, 1);
    assert.equal(result.details.fetchedCount, 0);
    assert.equal(result.details.attempts[0].phase, "fetch");
    assert.equal(readCache().search.model, current.id);
    assert.equal(readCache().fetch, undefined);
  });
});

test("failed search does not prevent successful URL fetch or discard its raw data", async () => {
  const model = deepseekModel();
  const raw = { title: "fetched", content: "raw page", extra: { preserve: true } };
  const calls = [];
  await withProviders([
    ["deepseek", "search", async () => { calls.push("search"); throw new Error("HTTP 503 search service unavailable"); }],
    ["deepseek", "fetch", async () => { calls.push("fetch"); return { entries: [{ url: page, data: raw }] }; }],
  ], async () => {
    const result = await runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model, availableModels: [model] }));
    const output = partialOutput(result);
    assert.deepEqual(calls, ["search", "fetch"]);
    assert.match(output.search.error, /503 search service unavailable/);
    assert.deepEqual(output.fetched, [{ url: page, data: raw }]);
    assert.equal(result.details.searchError, output.search.error);
    assert.equal(result.details.fetchedCount, 1);
    assert.equal(result.details.fetchFailedCount, 0);
    assert.deepEqual(result.details.routes, [{ phase: "fetch", provider: "deepseek", endpoint: "/v1/tools/fetch" }]);
    assert.equal(readCache().fetch.model, model.id);
    assert.equal(readCache().search, undefined);
    const collapsed = renderWebSearchResult(result, { expanded: false, isPartial: false }, theme).render(200).join("\n");
    assert.match(collapsed, /Search failed: HTTP 503/);
    assert.match(collapsed, /Fetched 1 URL/);
  });
});

test("native HTTP search failure still returns a successful DeepSeek Fetch response", async (t) => {
  await withTempCache(async () => {
    const model = deepseekModel();
    const requests = [];
    const raw = { title: "page", content: "raw content", extra: ["unchanged"] };
    t.mock.method(globalThis, "fetch", async (url, init) => {
      requests.push(String(url));
      if (String(url).endsWith("/search")) {
        return new Response(JSON.stringify({ error: { message: "search outage" } }), { status: 503 });
      }
      assert.deepEqual(JSON.parse(init.body), { url: page });
      return new Response(JSON.stringify(raw));
    });
    const result = await runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model, availableModels: [model] }));
    const output = partialOutput(result);
    assert.deepEqual(requests, ["https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch"]);
    assert.match(output.search.error, /503.*search outage/);
    assert.deepEqual(output.fetched, [{ url: page, data: raw }]);
    assert.equal(result.details.attempts[0].phase, "search");
  });
});

test("missing search capability is reported without suppressing an independent fetch", async () => {
  const model = googleModel();
  await withProviders([
    ["google", "supportsSearch", false],
    ["google", "search", async () => assert.fail("no search interface should be invoked")],
    ["google", "fetch", async () => ({ entries: [{ url: page, data: { content: "page" } }] })],
  ], async () => {
    const result = await runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model, availableModels: [model] }));
    const output = partialOutput(result);
    assert.match(output.search.error, /No eligible search interface/);
    assert.deepEqual(output.fetched[0].data, { content: "page" });
    assert.deepEqual(result.details.attempts, []);
  });
});

test("one successful URL is preserved alongside a failed search and invalid or failed URLs", async () => {
  const model = deepseekModel();
  const missing = "https://example.com/missing";
  await withProviders([
    ["deepseek", "search", async () => { throw new Error("HTTP 503 search failed"); }],
    ["deepseek", "fetch", async () => ({ entries: [{ url: page, data: null }, { url: missing, error: "page blocked" }] })],
  ], async () => {
    const result = await runWebSearch({ query: "query", urls: [page, missing, "ftp://example.com/file"] }, createMockCtx({ model, availableModels: [model] }));
    const output = partialOutput(result);
    assert.match(output.search.error, /search failed/);
    assert.deepEqual(output.fetched[0], { url: page, data: null });
    assert.equal(output.fetched[1].error, "page blocked");
    assert.match(output.fetched[2].error, /http or https/);
    assert.equal(result.details.fetchedCount, 1);
    assert.equal(result.details.fetchFailedCount, 2);
  });
});

test("only complete failure becomes a tool error and reports both failed operations", async () => {
  const model = deepseekModel();
  await withProviders([
    ["deepseek", "search", async () => { throw new Error("HTTP 503 search offline"); }],
    ["deepseek", "fetch", async () => ({ entries: [{ url: page, error: "fetch blocked" }] })],
  ], async () => {
    const result = await runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model, availableModels: [model] }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Failed: Search failed\./);
    assert.match(result.content[0].text, /search offline/);
    assert.match(result.content[0].text, /URL fetch failed/);
    assert.match(result.content[0].text, /fetch blocked/);
    assert.equal(readCache().search, undefined);
    assert.equal(readCache().fetch, undefined);
  });
});

test("missing interfaces still error when no requested operation can succeed", async () => {
  await withTempCache(async () => {
    const queryAndUrls = await runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model: unsupportedLocalModel() }));
    assert.equal(queryAndUrls.isError, true);
    assert.match(queryAndUrls.content[0].text, /No eligible search interface/);
    assert.match(queryAndUrls.content[0].text, /URL fetch is not available/);
    const urlOnly = await runWebSearch({ urls: [page] }, createMockCtx({ model: openaiResponsesModel() }));
    assert.equal(urlOnly.isError, true);
    assert.equal(urlOnly.content[0].text, "Failed: URL fetch is not available in this conversation.");
  });
});

test("large search failure messages are bounded without crowding out successful page content", async () => {
  const model = deepseekModel();
  await withProviders([
    ["deepseek", "search", async () => { throw new Error(`HTTP 503 ${"x".repeat(200_000)}`); }],
    ["deepseek", "fetch", async () => ({ entries: [{ url: page, data: { content: "successful page" } }] })],
  ], async () => {
    const result = await runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model, availableModels: [model] }));
    const output = partialOutput(result);
    assert.ok(Array.from(output.search.error).length <= 8192);
    assert.match(output.search.error, /\[truncated\]$/);
    assert.equal(output.fetched[0].data.content, "successful page");
  });
});

test("explicit cancellation still stops a combined call instead of returning misleading partial success", async () => {
  const model = deepseekModel();
  const controller = new AbortController();
  let searched = false;
  await withProviders([
    ["deepseek", "search", async () => { searched = true; return { results: [] }; }],
    ["deepseek", "fetch", async () => { controller.abort(new DOMException("cancelled", "AbortError")); throw controller.signal.reason; }],
  ], async () => {
    await assert.rejects(
      () => runWebSearch({ query: "query", urls: [page] }, createMockCtx({ model, availableModels: [model] }), controller.signal),
      { name: "AbortError" },
    );
    assert.equal(searched, true);
  });
});
