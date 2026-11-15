import assert from "node:assert/strict";
import test from "node:test";
import { dedicatedRequest } from "../lib/providers/dedicated-http.ts";
import { responseError } from "../lib/providers/http.ts";
import { redactSecrets } from "../lib/redact.ts";
import * as sse from "../lib/providers/sse.ts";
import { withEnv, withTempCache } from "./helpers.mjs";

const frameLimit = sse.MAX_SSE_FRAME_CHARS;
function streamed(chunks, cancel = () => {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
    cancel,
  }));
}

test("SSE bounds an unterminated line and cancels an open connection", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(frameLimit)}`)); },
    cancel() { cancelled = true; },
  }));
  let timer;
  try {
    await assert.rejects(Promise.race([
      sse.readSseEvents(response, controller.signal, () => assert.fail("no valid event")),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("oversized SSE line was not rejected")), 1000); }),
    ]), /SSE.*(?:limit|large)/i);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
  } finally { clearTimeout(timer); controller.abort(); }
});

test("SSE bounds accumulated multiline data, not just individual lines", async () => {
  const line = `data: ${" ".repeat(frameLimit / 2)}\n`;
  await assert.rejects(() => sse.readSseEvents(streamed([line, line, "\n"]), undefined, () => {}), /SSE.*(?:limit|large)/i);
});

test("SSE permits a large stream composed of individually bounded frames", async () => {
  const payload = "x".repeat(frameLimit / 2);
  const chunks = Array.from({ length: 3 }, () => `data: ${JSON.stringify({ payload })}\n\n`);
  let events = 0;
  await sse.readSseEvents(streamed(chunks), undefined, ({ data }) => { assert.equal(data.payload, payload); events++; });
  assert.equal(events, 3);
});

test("SSE accepts a frame exactly at the normalized character limit", async () => {
  const overhead = `data: ${JSON.stringify({ text: "" })}\n`.length;
  const text = "x".repeat(frameLimit - overhead);
  let events = 0;
  await sse.readSseEvents(streamed([`data: ${JSON.stringify({ text })}\n\n`]), undefined, ({ data }) => {
    assert.equal(data.text, text);
    events++;
  });
  assert.equal(events, 1);
});

test("SSE preserves long lines fragmented into many tiny chunks", async () => {
  const payload = "fragmented ".repeat(8192);
  const frame = `data: ${JSON.stringify({ payload })}\r\n\r\ndata: [DONE]`;
  const chunks = frame.match(/[\s\S]{1,17}/g);
  const events = [];
  await sse.readSseEvents(streamed(chunks), undefined, event => { events.push(event.data); });
  assert.deepEqual(events, [{ payload }]);
});

test("SSE ignores oversized trailing data after an explicit DONE", async () => {
  await sse.readSseEvents(streamed([`data: [DONE]\n\n${"x".repeat(frameLimit + 1)}`]), undefined,
    () => assert.fail("no event after DONE"));
});

test("redaction handles overlapping credentials and JSON escaping without rewriting ordinary errors", () => {
  const key = 'unit-test-"quoted\\credential';
  assert.equal(redactSecrets(`prefix-token-full ${key} ${JSON.stringify(key)}`, ["prefix-token", "prefix-token-full", key]),
    '[REDACTED] [REDACTED] "[REDACTED]"');
  assert.equal(redactSecrets("ordinary failure", [undefined, ""]), "ordinary failure");
});

test("HTTP credentials are redacted from status text and structured error codes too", async () => {
  const key = "unit-test-secret-status-token";
  const error = await responseError(new Response(JSON.stringify({ error: { code: key, message: "denied" } }), {
    status: 401, statusText: `Unauthorized ${key}`,
  }), "Provider", { Authorization: `Bearer ${key}` });
  assert.doesNotMatch(error.message, new RegExp(key));
  assert.doesNotMatch(error.code, new RegExp(key));
  assert.match(error.message, /\[REDACTED\]/);
});

test("dedicated transport errors redact JSON-escaped credentials captured before key rotation", async t => {
  const key = 'unit-test-escaped-"key\\suffix';
  await withTempCache(() => withEnv({ EXA_API_KEY: key }, async () => {
    t.mock.method(globalThis, "fetch", async () => {
      process.env.EXA_API_KEY = "replacement-key";
      throw new Error(`transport failed for ${JSON.stringify(key)}`);
    });
    await assert.rejects(() => dedicatedRequest("exa", "https://api.exa.ai/search", { method: "POST" }), error => {
      assert.equal(error.message.includes(JSON.stringify(key).slice(1, -1)), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
  }));
});
