import assert from "node:assert/strict";
import test from "node:test";
import { createAttemptSignal, providerFetch } from "../lib/attempt-timeout.ts";
import { ADAPTERS } from "../lib/providers/index.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, deepseekModel, ollamaCloudModel, withTempCache } from "./helpers.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
function mockDeadlines(t) {
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  return deadlines;
}

test("response bytes cannot restart a disposed attempt's deadline", async t => {
  const deadlines = mockDeadlines(t);
  let body;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) { body = controller; } })));
  const attempt = createAttemptSignal(undefined, 60_000);
  const response = await providerFetch("https://example.com", { signal: attempt.signal });
  attempt.dispose();
  const previous = deadlines.length;
  const text = response.text();
  body.enqueue(new TextEncoder().encode("completed late"));
  body.close();
  assert.equal(await text, "completed late");
  assert.equal(deadlines.length, previous);
});

test("attempt timeout cancels a stalled JSON body even when fetch ignores its signal", async t => {
  const deadlines = mockDeadlines(t);
  let cancelled;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel(reason) { cancelled = reason; return new Promise(() => {}); },
  })));
  const attempt = createAttemptSignal(undefined, 60_000);
  const reason = new DOMException("body inactivity timeout", "TimeoutError");
  let timer;
  try {
    const response = await providerFetch("https://example.com", { signal: attempt.signal });
    const rejected = assert.rejects(Promise.race([
      response.text(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("body was not cancelled")), 1000); }),
    ]), error => error === reason);
    deadlines.at(-1).abort(reason);
    await rejected;
    await tick();
    assert.equal(cancelled, reason);
  } finally {
    clearTimeout(timer);
    attempt.dispose();
  }
});

test("a response arriving after timeout is cancelled without waiting for source cleanup", async t => {
  const deadlines = mockDeadlines(t);
  let finishFetch;
  let cancelled;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finishFetch = resolve; }));
  const attempt = createAttemptSignal(undefined, 60_000);
  const reason = new DOMException("headers timeout", "TimeoutError");
  const pending = providerFetch("https://example.com", { signal: attempt.signal });
  const rejected = assert.rejects(pending, error => error === reason);
  deadlines[0].abort(reason);
  attempt.dispose();
  finishFetch(new Response(new ReadableStream({
    cancel(value) { cancelled = value; return new Promise(() => {}); },
  })));
  await rejected;
  assert.equal(cancelled, reason);
});

for (const [phase, timesOut] of [["search", true], ["fetch", true], ["search", false], ["fetch", false]]) {
  test(`${phase} ignores late adapter updates after ${timesOut ? "timeout and fallback" : "success"}`, async t => {
    await withTempCache(async () => {
      const deadlines = mockDeadlines(t);
      let lateUpdate;
      const url = "https://example.com/page";
      const successful = phase === "search"
        ? { results: [] }
        : { entries: [{ url, data: { content: "page" } }] };
      t.mock.method(ADAPTERS.deepseek, phase, async (...args) => {
        lateUpdate = args.at(-1);
        return timesOut ? new Promise(() => {}) : successful;
      });
      t.mock.method(ADAPTERS.ollama, phase, async () => successful);
      const model = deepseekModel();
      const updates = [];
      const task = runWebSearch(phase === "search" ? { query: "test" } : { urls: [url] },
        createMockCtx({ model, availableModels: [model, ollamaCloudModel()] }), undefined, update => updates.push(update));
      await tick();
      if (timesOut) deadlines.at(-1).abort(new DOMException("attempt timed out", "TimeoutError"));
      assert.equal((await task).isError, undefined);
      const previous = updates.length;
      lateUpdate({ content: [{ type: "text", text: "obsolete provider output" }], details: {} });
      assert.equal(updates.length, previous);
    });
  });
}
