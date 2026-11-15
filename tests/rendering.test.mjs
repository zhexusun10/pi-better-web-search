import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchToolManager } from "../extensions/index.ts";
import { createMockCtx, createMockPi, deepseekModel, withTempCache } from "./helpers.mjs";

const theme = { fg: (_color, text) => text, bold: text => text };
const render = component => component.render(200).map(line => line.trimEnd()).join("\n");
function toolFor(ctx) {
  const pi = createMockPi();
  createWebSearchToolManager(pi).sync(ctx);
  return pi.tools.get("web_search");
}

test("terminal titles distinguish search, fetch, and combined calls", () => {
  const tool = toolFor(createMockCtx());
  assert.equal(render(tool.renderCall({ query: "query" }, theme)), "Web Search query");
  assert.equal(render(tool.renderCall({ urls: ["https://example.com"] }, theme)), "Web Fetch 1 URL");
  assert.equal(render(tool.renderCall({ query: "query", urls: ["a", "b"] }, theme)), "Web Search + Fetch query + 2 URLs");
  assert.equal(render(tool.renderCall({}, theme)), "Web Search / Fetch");
});

test("URL-only DeepSeek execution displays the Fetch API, not a pro model or search", async (t) => {
  await withTempCache(async () => {
    const current = deepseekModel({ id: "deepseek-v9-pro" });
    const ctx = createMockCtx({ model: current, availableModels: [current, deepseekModel()] });
    const tool = toolFor(ctx);
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ title: "raw page", content: "raw content" }));
    });
    const updates = [];
    const result = await tool.execute("fetch-test", { urls: ["https://example.com"] }, undefined, update => updates.push(update), ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ url: "https://api.deepseek.com/v1/tools/fetch", body: { url: "https://example.com" } }]);
    assert.deepEqual(result.details.routes, [{ phase: "fetch", provider: "deepseek", endpoint: "/v1/tools/fetch" }]);
    assert.equal(result.details.model, undefined);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].details.activeRoute, result.details.routes[0]);
    assert.match(updates[0].content[0].text, /Fetch: deepseek API \/v1\/tools\/fetch/);
    assert.doesNotMatch(updates[0].content[0].text, /pro|flash|Search/);
    const collapsed = render(tool.renderResult(result, { expanded: false, isPartial: false }, theme));
    assert.equal(collapsed, "Fetch: deepseek API /v1/tools/fetch\nFetched 1 URL");
    const expanded = render(tool.renderResult(result, { expanded: true, isPartial: false }, theme));
    assert.ok(expanded.endsWith(result.content[0].text));
    assert.doesNotMatch(collapsed, /pro|flash|Search/);
  });
});

test("combined DeepSeek calls display both actual API operations without a model label", async (t) => {
  await withTempCache(async () => {
    const model = deepseekModel();
    const ctx = createMockCtx({ model, availableModels: [model] });
    const tool = toolFor(ctx);
    const endpoints = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      endpoints.push(String(url));
      assert.equal("model" in JSON.parse(init.body), false);
      return new Response(JSON.stringify(String(url).endsWith("search") ? { results: [] } : { content: "page" }));
    });
    const result = await tool.execute("combined", { query: "query", urls: ["https://example.com"] }, undefined, undefined, ctx);
    assert.deepEqual(endpoints, ["https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch"]);
    const text = render(tool.renderResult(result, { expanded: false, isPartial: false }, theme));
    assert.equal(text, "Search: deepseek API /v1/tools/search\nFetch: deepseek API /v1/tools/fetch\nFetched 1 URL");
  });
});

test("model-backed search displays the model actually requested", () => {
  const tool = toolFor(createMockCtx());
  const result = {
    content: [{ type: "text", text: '{"search":{"results":[]}}' }],
    details: { attempts: [], routes: [{ phase: "search", provider: "openai", model: "gpt-6.1-luna" }] },
  };
  assert.equal(render(tool.renderResult(result, { expanded: false, isPartial: false }, theme)), "Search: openai/gpt-6.1-luna");
});

test("partial progress and errors remain visible when collapsed", () => {
  const tool = toolFor(createMockCtx());
  const progress = { content: [{ type: "text", text: "Fetch: deepseek API /v1/tools/fetch..." }], details: { attempts: [] } };
  assert.equal(render(tool.renderResult(progress, { expanded: false, isPartial: true }, theme)), progress.content[0].text);
  const error = { content: [{ type: "text", text: "Failed: unavailable" }], details: { attempts: [], error: "unavailable" }, isError: true };
  assert.equal(render(tool.renderResult(error, { expanded: false, isPartial: false }, theme)), "Failed: unavailable");
});
