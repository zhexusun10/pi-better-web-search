import assert from "node:assert/strict";
import test from "node:test";
import { saveApiKey, removeApiKey } from "../lib/credentials.ts";
import { writeProviderPreferences } from "../lib/preferences.ts";
import { keenableAdapter, deepseekAdapter, ollamaAdapter } from "../lib/providers/index.ts";
import { dedicatedRequest } from "../lib/providers/dedicated-http.ts";
import { HttpError, isAbortError } from "../lib/providers/http.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, ollamaCloudModel, withEnv, withTempCache } from "./helpers.mjs";

const first = "https://example.com/first";
const second = "https://example.com/second";
const third = "https://example.com/third";
const key = "unit-test-runtime-auth-secret";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test("Keenable cannot downgrade to public fetch when its key disappears after successful search", async t => {
  await withTempCache(async () => {
    await saveApiKey("keenable", key);
    writeProviderPreferences({ version: 1, apis: { keenable: true, keenableKeyRequired: true } });
    const paths = [];
    t.mock.method(globalThis, "fetch", async url => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/v1/search") {
        await removeApiKey("keenable");
        return json({ results: [{ title: "search survives" }] });
      }
      return json({ url: first, content: "must not fetch anonymously" });
    });
    const result = await runWebSearch({ query: "test", urls: [first] }, createMockCtx());
    assert.deepEqual(paths, ["/v1/search"]);
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.search.results[0].title, "search survives");
    assert.match(output.fetched[0].error, /key|credential|public/i);
    assert.equal(result.details.fetchedCount, 0);
  });
});

test("Keenable preserves earlier URLs without anonymous downgrade after a mid-batch key loss", async t => {
  await withTempCache(async () => {
    await saveApiKey("keenable", key);
    writeProviderPreferences({ version: 1, apis: { keenable: true, keenableKeyRequired: true } });
    const paths = [];
    t.mock.method(globalThis, "fetch", async url => {
      const target = new URL(url);
      paths.push(target.pathname);
      await removeApiKey("keenable");
      return json({ url: target.searchParams.get("url"), content: "preserved page" });
    });
    const result = await keenableAdapter.fetch(createMockCtx(), null, [first, second, third]);
    assert.deepEqual(paths, ["/v1/fetch"]);
    assert.equal(result.entries[0].data.content, "preserved page");
    assert.match(result.providerError, /key|credential|public/i);
  });
});

test("Keenable rechecks public consent before subsequent batch requests", async t => {
  await withTempCache(async () => {
    writeProviderPreferences({ version: 1, apis: { keenable: true } });
    const paths = [];
    t.mock.method(globalThis, "fetch", async url => {
      const target = new URL(url);
      paths.push(target.pathname);
      writeProviderPreferences({ version: 1, apis: { keenable: false } });
      return json({ url: first, content: "preserved public page" });
    });
    const result = await keenableAdapter.fetch(createMockCtx(), null, [first, second]);
    assert.deepEqual(paths, ["/v1/fetch/public"]);
    assert.equal(result.entries[0].data.content, "preserved public page");
    assert.match(result.providerError, /public|disabled|consent/i);
  });
});

test("an unconfigured direct Keenable adapter call cannot opt itself into public access", async t => {
  await withTempCache(async () => {
    const network = t.mock.method(globalThis, "fetch", async () => json({ results: [] }));
    await assert.rejects(() => keenableAdapter.search(createMockCtx(), null, "private query"), /public|consent/i);
    assert.equal(network.mock.callCount(), 0);
  });
});

test("explicit Keenable public consent remains usable and newly supplied keys use keyed endpoints", async t => {
  await withTempCache(() => withEnv({ KEENABLE_API_KEY: undefined }, async () => {
    writeProviderPreferences({ version: 1, apis: { keenable: true } });
    const paths = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      paths.push(new URL(url).pathname);
      if (paths.length === 1) {
        assert.equal(init.headers.get("X-Keenable-Title"), "pi-better-web-search");
        assert.equal(init.headers.has("X-API-Key"), false);
        process.env.KEENABLE_API_KEY = key;
      } else {
        assert.equal(init.headers.get("X-API-Key"), key);
        assert.equal(init.headers.has("X-Keenable-Title"), false);
      }
      return json({ url: paths.length === 1 ? first : second, content: "page" });
    });
    const result = await keenableAdapter.fetch(createMockCtx(), null, [first, second]);
    assert.deepEqual(paths, ["/v1/fetch/public", "/v1/fetch"]);
    assert.equal(result.entries.filter(entry => entry.data).length, 2);
  }));
});

test("abort classification does not match provider errors or URLs merely containing abort", () => {
  for (const message of ["upstream aborted while fetching a page", "AbortController is not defined", "https://example.com/abort", "abortion policy page missing"]) {
    assert.equal(isAbortError(new Error(message)), false, message);
  }
  assert.equal(isAbortError(new HttpError(404, "Provider API error (404): target request aborted")), false);
  assert.equal(isAbortError(new DOMException("cancelled", "AbortError")), true);
  assert.equal(isAbortError({ code: "ABORT_ERR", message: "cancelled" }), true);
  assert.equal(isAbortError(new Error("The operation was aborted.")), true);
  assert.equal(isAbortError(new Error("Request was aborted")), true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(isAbortError(new Error("network error"), controller.signal), true);
});

for (const [label, adapter, model] of [["DeepSeek", deepseekAdapter, deepseekModel()], ["Ollama", ollamaAdapter, ollamaCloudModel()]]) {
  test(`${label} malformed target responses containing abort do not discard earlier URLs or stop later fetches`, async t => {
    await withTempCache(async () => {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => ++calls === 2
        ? new Response("abort: malformed upstream JSON")
        : json({ content: `page ${calls}` }));
      const result = await adapter.fetch(createMockCtx({ model }), model, [first, second, third]);
      assert.equal(calls, 3);
      assert.equal(result.entries[0].data.content, "page 1");
      assert.match(result.entries[1].error, /Invalid JSON/);
      assert.equal(result.entries[2].data.content, "page 3");
      assert.equal(result.providerError, undefined);
    });
  });
}

test("typed transport AbortErrors are still redacted without changing external cancellation reasons", async t => {
  await withTempCache(() => withEnv({ EXA_API_KEY: key }, async () => {
    t.mock.method(globalThis, "fetch", async () => {
      process.env.EXA_API_KEY = "replacement-key";
      throw new DOMException(`aborted transport using ${key}`, "AbortError");
    });
    await assert.rejects(() => dedicatedRequest("exa", "https://api.exa.ai/search", { method: "POST" }), error => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.message.includes(key), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
    const controller = new AbortController();
    const reason = new Error("explicit cancellation");
    controller.abort(reason);
    await assert.rejects(() => dedicatedRequest("exa", "https://api.exa.ai/search", {}, controller.signal), error => error === reason);
  }));
});

test("dedicated transport failures mentioning abort are redacted using the sent key after rotation", async t => {
  await withTempCache(() => withEnv({ EXA_API_KEY: key }, async () => {
    t.mock.method(globalThis, "fetch", async () => {
      process.env.EXA_API_KEY = "replacement-key";
      throw new Error(`upstream aborted after sending ${key}`);
    });
    await assert.rejects(() => dedicatedRequest("exa", "https://api.exa.ai/search", { method: "POST" }), error => {
      assert.equal(error.message.includes(key), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
  }));
});
