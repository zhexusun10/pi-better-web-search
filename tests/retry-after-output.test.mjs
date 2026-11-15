import assert from "node:assert/strict";
import test from "node:test";
import { responseError, retryAfterMs } from "../lib/providers/http.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, withEnv, withTempCache } from "./helpers.mjs";

const cleanKeys = { KEENABLE_API_KEY: undefined, EXA_API_KEY: undefined, PERPLEXITY_API_KEY: undefined, DEEPSEEK_API_KEY: undefined };
const limited = (header = "60") => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "Retry-After": header } });

test("native provider returns the original error body and Retry-After header without generated advice", async t => {
  await withTempCache(() => withEnv(cleanKeys, async () => {
    const model = deepseekModel();
    const ctx = createMockCtx({ model, availableModels: [model] });
    t.mock.method(globalThis, "fetch", async () => limited());
    const result = await runWebSearch({ query: "query" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Retry-After: 60/);
    assert.match(result.content[0].text, /\{"error":\{"message":"rate limited"\}\}/);
    assert.doesNotMatch(result.content[0].text, /Wait at least/);
  }));
});

test("standalone provider returns remaining wait to agent both initially and during backoff", async t => {
  await withTempCache(() => withEnv({ ...cleanKeys, PERPLEXITY_API_KEY: "test-key" }, async () => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return limited(); });
    const ctx = createMockCtx({ model: undefined, availableModels: [] });
    const first = await runWebSearch({ query: "query" }, ctx);
    assert.match(first.content[0].text, /Retry-After: 60/);
    now += 10_000;
    const second = await runWebSearch({ query: "query" }, ctx);
    assert.match(second.content[0].text, /Retry in 50 seconds/);
    assert.match(second.content[0].text, /Retry-After: 60/);
    assert.match(second.content[0].text, /rate limited/);
    assert.equal(calls, 1);
  }));
});

test("a healthy fallback returns results instead of asking the agent to wait", async t => {
  await withTempCache(() => withEnv({ ...cleanKeys, KEENABLE_API_KEY: "test-key" }, async () => {
    const model = deepseekModel();
    const ctx = createMockCtx({ model, availableModels: [model] });
    t.mock.method(globalThis, "fetch", async url => String(url).includes("keenable")
      ? limited()
      : new Response(JSON.stringify({ results: [{ title: "native result" }] }), { status: 200 }));
    const result = await runWebSearch({ query: "query" }, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).search.results[0].title, "native result");
    assert.doesNotMatch(result.content[0].text, /Wait at least/);
  }));
});

test("HTTP error retains provider fields and original header while redacting sent secrets", async () => {
  const secret = 'test"secret';
  const raw = { error: { message: "rate limited", code: "RATE_LIMIT", details: { request_id: "abc", echoed_key: secret } }, retryable: true };
  const response = new Response(JSON.stringify(raw), { status: 429, headers: { "Retry-After": "60" } });
  const error = await responseError(response, "Native", { Authorization: `Bearer ${secret}` });
  assert.equal(error.code, "RATE_LIMIT");
  assert.match(error.message, /Retry-After: 60/);
  assert.match(error.message, /"request_id":"abc"/);
  assert.match(error.message, /"retryable":true/);
  assert.match(error.message, /"echoed_key":"\[REDACTED\]"/);
  assert.doesNotMatch(error.message, /test\\?"secret/);
  assert.doesNotMatch(error.body, /test\\?"secret/);
});

test("Retry-After supports HTTP dates and ignores invalid, expired, or zero values", async () => {
  const now = Date.now();
  const date = new Date(Math.ceil(now / 1000) * 1000 + 60_000).toUTCString();
  const error = await responseError(limited(date), "Native");
  assert.ok(error.message.includes(`Retry-After: ${date}`));
  for (const value of [null, "", "0", "not-a-date", "Infinity", "-1", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
    assert.equal(retryAfterMs(value, now), 0, String(value));
  }
});
