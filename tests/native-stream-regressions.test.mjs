import assert from "node:assert/strict";
import test from "node:test";
import { anthropicAdapter, deepseekAdapter, googleAdapter, ollamaAdapter, openaiAdapter, xaiAdapter } from "../lib/providers/index.ts";
import { anthropicModel, createMockCtx, deepseekModel, googleModel, ollamaCloudModel, openaiResponsesModel, xaiModel, withTempCache } from "./helpers.mjs";

const key = 'unit-test-native-"secret\\suffix';
const extraKey = "unit-test-native-extra-token";
const wire = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const searchCall = { type: "web_search_call", id: "call", status: "completed", action: { query: "test", sources: [] } };

for (const [label, adapter, makeModel] of [["OpenAI", openaiAdapter, openaiResponsesModel], ["xAI", xaiAdapter, xaiModel]]) {
  for (const type of ["response.completed", "response.done", "response.incomplete"]) {
    test(`${label} stops at ${type} even when the connection remains open`, async t => {
      let cancelled = false;
      const events = [{ type: "response.output_text.delta", delta: "useful answer" }, {
        type, response: { status: type.endsWith("incomplete") ? "incomplete" : "completed", output: [searchCall] },
      }];
      t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(wire(events))); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("terminal response event was ignored")), 1000);
      try {
        const model = makeModel();
        const result = await adapter.search(createMockCtx({ model }), model, "test", controller.signal);
        assert.equal(result.answer, "useful answer");
        assert.deepEqual(result.results, [searchCall]);
        assert.equal(cancelled, true);
      } finally { clearTimeout(timer); controller.abort(); }
    });
  }
}

test("Anthropic stops at message_stop even when the connection remains open", async t => {
  let cancelled = false;
  const block = { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://example.com", title: "original" }] };
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(wire([
      { type: "content_block_start", index: 0, content_block: block }, { type: "message_stop" },
    ]))); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("message_stop was ignored")), 1000);
  try {
    const model = anthropicModel();
    const result = await anthropicAdapter.search(createMockCtx({ model }), model, "test", controller.signal);
    assert.deepEqual(result.results, [block]);
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); controller.abort(); }
});

test("Anthropic skips non-object frames without losing later search results", async t => {
  const block = { type: "web_search_tool_result", content: [] };
  t.mock.method(globalThis, "fetch", async () => new Response(wire([
    null, 1, "keepalive", { type: "content_block_start", index: 0, content_block: block },
    { type: "message_stop" }, { type: "error", error: { message: "must not read after stop" } },
  ])));
  const model = anthropicModel();
  const result = await anthropicAdapter.search(createMockCtx({ model }), model, "test");
  assert.deepEqual(result.results, [block]);
});

test("Anthropic does not count unrelated server tools as web-search evidence", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(wire([
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "calculator", input: {} } },
    { type: "message_stop" },
  ])));
  const model = anthropicModel();
  await assert.rejects(() => anthropicAdapter.search(createMockCtx({ model }), model, "test"), /did not perform a web search/);
});

for (const [label, adapter, makeModel, errorEvent] of [
  ["OpenAI", openaiAdapter, openaiResponsesModel, message => ({ type: "error", error: { message } })],
  ["xAI", xaiAdapter, xaiModel, message => ({ type: "response.failed", response: { error: { message } } })],
  ["Google", googleAdapter, googleModel, message => ({ error: { code: 503, message, details: { token: key } } })],
  ["Anthropic", anthropicAdapter, anthropicModel, message => ({ type: "error", error: { message } })],
]) {
  test(`${label} stream errors redact all sent credentials after auth rotation`, async t => {
    await withTempCache(async () => {
      let current = key;
      const model = makeModel({ headers: { "X-Provider-Token": extraKey } });
      const ctx = createMockCtx({ model, auth: () => ({ ok: true, apiKey: current }) });
      t.mock.method(globalThis, "fetch", async () => {
        current = "replacement-key";
        return new Response(wire([errorEvent(`failed ${key}; escaped ${JSON.stringify(key)}; extra ${extraKey}`)]), {
          headers: { "Content-Type": "text/event-stream" },
        });
      });
      await assert.rejects(() => adapter.search(ctx, model, "test"), error => {
        const visible = `${error.message} ${JSON.stringify(error)}`;
        assert.equal(visible.includes(key), false);
        assert.equal(visible.includes(JSON.stringify(key).slice(1, -1)), false);
        assert.equal(visible.includes(extraKey), false);
        assert.match(error.message, /\[REDACTED\]/);
        if (label === "Google") assert.equal(error.status, 503);
        return true;
      });
    });
  });
}

for (const [label, adapter, makeModel] of [
  ["OpenAI", openaiAdapter, openaiResponsesModel], ["xAI", xaiAdapter, xaiModel],
  ["Google", googleAdapter, googleModel], ["Anthropic", anthropicAdapter, anthropicModel],
  ["Ollama", ollamaAdapter, ollamaCloudModel], ["DeepSeek", deepseekAdapter, deepseekModel],
]) {
  test(`${label} transport errors redact sent headers without losing failure metadata`, async t => {
    await withTempCache(async () => {
      const model = makeModel({ headers: { "X-Provider-Token": extraKey } });
      const ctx = createMockCtx({ model, auth: { ok: true, apiKey: key } });
      t.mock.method(globalThis, "fetch", async () => {
        throw Object.assign(new TypeError(`fetch failed using ${key} and ${extraKey}`), { code: "ECONNRESET", status: 503, body: { credential: key } });
      });
      await assert.rejects(() => adapter.search(ctx, model, "test"), error => {
        const visible = `${error.message} ${JSON.stringify(error)}`;
        assert.equal(visible.includes(key), false);
        assert.equal(visible.includes(extraKey), false);
        assert.match(error.message, /\[REDACTED\]/);
        assert.equal(error.status, 503);
        assert.equal(error.code, "ECONNRESET");
        return true;
      });
    });
  });
}

test("Ollama malformed JSON errors do not expose credentials in parser snippets or stored bodies", async t => {
  const model = ollamaCloudModel();
  const ctx = createMockCtx({ model, auth: { ok: true, apiKey: key } });
  t.mock.method(globalThis, "fetch", async () => new Response(`${key} invalid JSON`));
  await assert.rejects(() => ollamaAdapter.search(ctx, model, "test"), error => {
    assert.match(error.message, /Invalid JSON/);
    assert.equal(error.message.includes("unit-test-native"), false);
    assert.equal(String(error.body).includes(JSON.stringify(key).slice(1, -1)), false);
    assert.equal(String(error.body).includes(key), false);
    return true;
  });
});
