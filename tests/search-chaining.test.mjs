import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS } from "../lib/providers/index.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, withTempCache } from "./helpers.mjs";

test("search refinement and source fetching are explicit agent calls, not an automatic fixed chain", async (t) => {
  await withTempCache(async () => {
    const model = deepseekModel();
    const ctx = createMockCtx({ model, availableModels: [model] });
    const page = "https://example.com/widget-v2";
    const calls = [];
    t.mock.method(ADAPTERS.deepseek, "search", async (_ctx, _model, query) => {
      calls.push({ operation: "search", query });
      return { results: [{ title: "Widget v2", url: page, querySeen: query }] };
    });
    t.mock.method(ADAPTERS.deepseek, "fetch", async (_ctx, _model, urls, query) => {
      calls.push({ operation: "fetch", urls, query });
      return { entries: urls.map(url => ({ url, data: { content: "source document" } })) };
    });

    const first = await runWebSearch({ query: "latest Widget release" }, ctx);
    assert.equal(first.isError, undefined);
    assert.equal(calls.length, 1, "one successful search must not automatically trigger another search or fetch");
    const source = JSON.parse(first.content[0].text).search.results[0];

    // Simulate the agent deriving a more specific query from its prior evidence.
    const refinedQuery = `${source.title} official release notes`;
    const second = await runWebSearch({ query: refinedQuery }, ctx);
    assert.equal(second.isError, undefined);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(second.content[0].text).search.results[0].querySeen, refinedQuery);

    const fetched = await runWebSearch({ urls: [source.url] }, ctx);
    assert.equal(fetched.isError, undefined);
    assert.deepEqual(calls, [
      { operation: "search", query: "latest Widget release" },
      { operation: "search", query: "Widget v2 official release notes" },
      { operation: "fetch", urls: [page], query: undefined },
    ]);
    assert.equal(JSON.parse(fetched.content[0].text).search, undefined);
  });
});
