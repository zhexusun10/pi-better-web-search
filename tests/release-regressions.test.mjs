import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { saveApiKey } from "../lib/credentials.ts";
import { deepseekAdapter, exaAdapter } from "../lib/providers/index.ts";
import { MAX_ERROR_BODY_BYTES, responseError } from "../lib/providers/http.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, withEnv, withTempCache } from "./helpers.mjs";

const page = "https://example.com/page";
const oldKey = "unit-test-old-release-key";
const newKey = "unit-test-new-release-key";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const standaloneDeepSeek = { provider: "deepseek", id: "search-fetch", api: "dedicated-web-search", baseUrl: "https://api.deepseek.com" };

for (const retryAfter of ["60", "date"]) {
  test(`standalone DeepSeek honors Retry-After ${retryAfter} across search/fetch and key rotation`, async (t) => {
    await withTempCache(() => withEnv({ DEEPSEEK_API_KEY: oldKey }, async () => {
      const now = Date.now();
      t.mock.method(Date, "now", () => now);
      const network = t.mock.method(globalThis, "fetch", async () => json({ error: { message: "rate limited" } }, 429, {
        "Retry-After": retryAfter === "date" ? new Date(now + 60000).toUTCString() : retryAfter,
      }));
      await assert.rejects(() => deepseekAdapter.search(createMockCtx(), standaloneDeepSeek, "query"), { status: 429 });
      await assert.rejects(() => deepseekAdapter.fetch(createMockCtx(), standaloneDeepSeek, [page]), /Retry-After is active/);
      assert.equal(network.mock.callCount(), 1, "fetch must not issue another HTTP request during search backoff");
      network.mock.mockImplementation(async (_url, init) => {
        assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${newKey}`);
        return json({ results: [] });
      });
      process.env.DEEPSEEK_API_KEY = newKey;
      assert.deepEqual(await deepseekAdapter.search(createMockCtx(), standaloneDeepSeek, "query"), { results: [] });
      assert.equal(network.mock.callCount(), 2);
    }));
  });
}

test("standalone DeepSeek rejects malformed environment keys before HTTP without exposing them", async (t) => {
  await withTempCache(() => withEnv({ DEEPSEEK_API_KEY: "unit-test-bad-key\nsecret" }, async () => {
    const network = t.mock.method(globalThis, "fetch", async () => json({ results: [] }));
    const result = await runWebSearch({ query: "query" }, createMockCtx());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid header characters/);
    assert.doesNotMatch(JSON.stringify(result), /unit-test-bad-key|secret/);
    assert.equal(network.mock.callCount(), 0);
  }));
});

test("standalone DeepSeek preserves completed URLs when a later request is rate-limited", async (t) => {
  await withTempCache(() => withEnv({ DEEPSEEK_API_KEY: oldKey }, async () => {
    const second = "https://example.com/second";
    const third = "https://example.com/third";
    const raw = { title: "original", content: "useful page", unknown: { kept: true } };
    let calls = 0;
    const network = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${oldKey}`);
      assert.deepEqual(JSON.parse(init.body), { url: ++calls === 1 ? page : second });
      return calls === 1 ? json(raw) : json({ error: { message: "limited" } }, 429, { "Retry-After": "60" });
    });
    const result = await runWebSearch({ urls: [page, second, third] }, createMockCtx());
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.deepEqual(output.fetched[0], { url: page, data: raw });
    assert.match(output.fetched[1].error, /429/);
    assert.match(output.fetched[2].error, /429/);
    assert.equal(result.details.fetchedCount, 1);
    assert.equal(result.details.fetchFailedCount, 2);
    assert.equal(network.mock.callCount(), 2);
  }));
});

test("standalone DeepSeek cancellation still stops a batch before sending later URLs", async (t) => {
  await withTempCache(() => withEnv({ DEEPSEEK_API_KEY: oldKey }, async () => {
    const controller = new AbortController();
    const network = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      controller.abort(new DOMException("cancelled", "AbortError"));
      return json({ content: "do not return a cancelled result" });
    });
    await assert.rejects(() => deepseekAdapter.fetch(createMockCtx(), standaloneDeepSeek, [page, `${page}/next`], undefined, controller.signal), { name: "AbortError" });
    assert.equal(network.mock.callCount(), 1);
  }));
});

test("Exa per-URL error redaction uses the credential sent even after an in-flight rotation", async (t) => {
  await withTempCache(async () => {
    assert.equal(await saveApiKey("exa", oldKey), true);
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("X-API-Key"), oldKey);
      assert.equal(await saveApiKey("exa", newKey), true);
      return json({ results: [], statuses: [{ id: page, status: "error", error: { message: `failed credential ${oldKey}` } }] });
    });
    const result = await exaAdapter.fetch(createMockCtx(), null, [page]);
    assert.match(result.entries[0].error, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(result), /unit-test-old-release-key/);
  });
});

test("Exa canonical URL error statuses override redirected page text even without status ids", async (t) => {
  await withTempCache(() => withEnv({ EXA_API_KEY: oldKey }, async () => {
    t.mock.method(globalThis, "fetch", async () => json({
      results: [{ id: page, url: "https://example.com/canonical", text: "must not count as a success" }],
      statuses: [{ url: "https://example.com/canonical", status: "error", error: { tag: "CRAWL_TIMEOUT" } }],
    }));
    const result = await exaAdapter.fetch(createMockCtx(), null, [page]);
    assert.match(result.entries[0].error, /CRAWL_TIMEOUT/);
    assert.equal(result.entries[0].data, undefined);
  }));
});

test("the live DeepSeek smoke script cannot spend usage on unrelated configured search APIs", async () => {
  await withTempCache(() => {
    const script = new URL("../scripts/live-deepseek.mjs", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const unexpected = [];
      globalThis.fetch = async (url) => {
        if (new URL(url).hostname !== "api.deepseek.com") {
          unexpected.push(new URL(url).hostname);
          throw new Error("unrelated API called");
        }
        return new Response(JSON.stringify(String(url).endsWith("/search")
          ? { results: [{ title: "Example", url: "https://example.com", summary: "Summary" }] }
          : { title: "Example", content: "Page" }));
      };
      await import(${JSON.stringify(script)});
      assert.deepEqual(unexpected, [], "DeepSeek-only smoke test must not call other APIs");
    `], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, DEEPSEEK_API_KEY: oldKey, EXA_API_KEY: oldKey, PERPLEXITY_API_KEY: oldKey, KEENABLE_API_KEY: oldKey },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /PASS: live DeepSeek/);
  });
});

test("bounded HTTP errors do not wait for a non-settling stream cancellation", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_ERROR_BODY_BYTES).fill(120)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { status: 503 });
  let timer;
  try {
    const error = await Promise.race([
      responseError(response, "Provider"),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("HTTP error cleanup hung")), 500); }),
    ]);
    assert.equal(cancelled, true);
    assert.equal(error.status, 503);
    assert.match(error.body, /\[truncated\]$/);
    assert.equal(response.body.locked, false);
  } finally { clearTimeout(timer); }
});
