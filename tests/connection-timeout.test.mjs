import assert from "node:assert/strict";
import test from "node:test";
import { SEARCH_ATTEMPT_CAP, FETCH_ATTEMPT_CAP } from "../lib/candidates.ts";
import { ADAPTERS } from "../lib/providers/index.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, openaiResponsesModel, withEnv, withTempCache } from "./helpers.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const clean = { KEENABLE_API_KEY: "test-key", EXA_API_KEY: undefined, PERPLEXITY_API_KEY: undefined, DEEPSEEK_API_KEY: undefined };

test("search and fetch allow one initial attempt plus six fallbacks", () => {
  assert.equal(SEARCH_ATTEMPT_CAP, 7);
  assert.equal(FETCH_ATTEMPT_CAP, 7);
});

test("response headers and received body bytes renew separate inactivity deadlines", async t => {
  await withTempCache(() => withEnv(clean, async () => {
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", ms => {
      assert.equal(ms, 60_000);
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    let body;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) { body = controller; } }), { status: 200 }));
    const task = runWebSearch({ query: "query" }, createMockCtx({ model: undefined, availableModels: [] }));
    await tick();
    assert.equal(deadlines.length, 2);
    deadlines[0].abort(new DOMException("old deadline", "TimeoutError"));
    body.enqueue(new TextEncoder().encode('{"results":['));
    await tick();
    assert.equal(deadlines.length, 3);
    deadlines[1].abort(new DOMException("old output deadline", "TimeoutError"));
    body.enqueue(new TextEncoder().encode('{"title":"complete"}]}'));
    body.close();
    const result = await task;
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).search.results[0].title, "complete");
  }));
});

test("missing first body bytes after headers times out and falls back", async t => {
  await withTempCache(() => withEnv(clean, async () => {
    let cancelled = false;
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", ms => {
      assert.equal(ms, 60_000);
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    t.mock.method(globalThis, "fetch", async url => String(url).includes("keenable")
      ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 })
      : new Response(JSON.stringify({ results: [{ title: "fallback" }] }), { status: 200 }));
    const model = deepseekModel();
    const task = runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model] }));
    await tick();
    assert.equal(deadlines.length, 2);
    deadlines[1].abort(new DOMException("first output timeout", "TimeoutError"));
    const result = await task;
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).search.results[0].title, "fallback");
    assert.match(result.details.attempts[0].message, /timeout/);
    await tick();
    assert.equal(cancelled, true);
  }));
});

test("a stalled body after initial bytes also times out and falls back", async t => {
  await withTempCache(() => withEnv(clean, async () => {
    let cancelled = false;
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", () => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    let body;
    t.mock.method(globalThis, "fetch", async url => String(url).includes("keenable")
      ? new Response(new ReadableStream({ start(controller) { body = controller; }, cancel() { cancelled = true; } }), { status: 200 })
      : new Response(JSON.stringify({ results: [{ title: "fallback" }] }), { status: 200 }));
    const model = deepseekModel();
    const task = runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model] }));
    await tick();
    body.enqueue(new TextEncoder().encode('{"results":['));
    await tick();
    assert.equal(deadlines.length, 3);
    deadlines[2].abort(new DOMException("idle timeout", "TimeoutError"));
    const result = await task;
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).search.results[0].title, "fallback");
    await tick();
    assert.equal(cancelled, true);
  }));
});

test("SSE keepalive comments do not count as provider output", async t => {
  await withTempCache(async () => {
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", () => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    let stream;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "text/event-stream" } }));
    t.mock.method(ADAPTERS.deepseek, "search", async () => ({ results: [{ title: "fallback" }] }));
    const model = openaiResponsesModel();
    const fallback = deepseekModel();
    const task = runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model, fallback] }));
    await tick();
    stream.enqueue(new TextEncoder().encode(": keepalive\n\n"));
    await tick();
    assert.equal(deadlines.length, 2);
    deadlines[1].abort(new DOMException("idle timeout", "TimeoutError"));
    const result = await task;
    assert.equal(JSON.parse(result.content[0].text).search.results[0].title, "fallback");
  });
});

test("provider output renews the deadline even if no caller update callback is provided", async t => {
  await withTempCache(async () => {
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", () => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
    let finish;
    t.mock.method(ADAPTERS.deepseek, "search", async (_ctx, _model, _query, _signal, update) => {
      update({ content: [{ type: "text", text: "partial" }], details: {} });
      await new Promise(resolve => { finish = resolve; });
      return { results: [] };
    });
    const model = deepseekModel();
    const task = runWebSearch({ query: "query" }, createMockCtx({ model, availableModels: [model] }));
    await tick();
    assert.equal(deadlines.length, 2);
    deadlines[0].abort(new DOMException("old deadline", "TimeoutError"));
    finish();
    assert.equal((await task).isError, undefined);
  });
});

test("external cancellation still aborts a response after headers", async t => {
  await withTempCache(() => withEnv(clean, async () => {
    let cancelled = false;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }));
    const cancel = new AbortController();
    const task = runWebSearch({ query: "query" }, createMockCtx({ model: undefined, availableModels: [] }), cancel.signal);
    await tick();
    cancel.abort(new DOMException("user cancelled", "AbortError"));
    await assert.rejects(task, /user cancelled/);
    await tick();
    assert.equal(cancelled, true);
  }));
});
