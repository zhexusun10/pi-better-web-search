import assert from "node:assert/strict";
import test from "node:test";
import { readSseEvents } from "../lib/providers/sse.ts";

function streamResponse(chunks, { open = false, cancel = () => {} } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      if (!open) controller.close();
    },
    cancel,
  }));
}

test("SSE event names do not leak out of data-less frames", async () => {
  const events = [];
  await readSseEvents(streamResponse(["event: error\n\n", 'data: {"ok":true}\n\n']), undefined, event => { events.push(event); });
  assert.deepEqual(events, [{ event: "", data: { ok: true } }]);
});

test("SSE supports CR, LF, and CRLF even when split across chunks", async () => {
  for (const ending of ["\n", "\r", "\r\n"]) {
    const events = [];
    const bytes = new TextEncoder().encode(`event: update${ending}data: {"text":${ending}data: "😀"}${ending}${ending}`);
    await readSseEvents(streamResponse(Array.from(bytes, byte => Uint8Array.of(byte))), undefined, event => { events.push(event); });
    assert.deepEqual(events, [{ event: "update", data: { text: "😀" } }], JSON.stringify(ending));
  }
});

test("SSE DONE stops reading and cancels a connection that stays open", async () => {
  let cancelled = false;
  const events = [];
  const response = streamResponse(['data: {"ok":true}\n\ndata: [DONE]\n\ndata: {"late":true}\n\n'], { open: true, cancel: () => { cancelled = true; } });
  const timeout = setTimeout(() => {}, 1000);
  try {
    await readSseEvents(response, AbortSignal.timeout(500), event => { events.push(event); });
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(cancelled, true);
  assert.equal(events.length, 1);
});

test("SSE abort cancels a pending read even if the response ignores the signal", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled by user", "AbortError");
  let cancelled = false;
  const response = streamResponse([], { open: true, cancel: () => { cancelled = true; } });
  const pending = readSseEvents(response, controller.signal, () => assert.fail("no event expected"));
  const rejected = assert.rejects(pending, error => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("SSE preserves callback early-stop and releases the reader on errors", async () => {
  let cancelled = 0;
  const response = streamResponse(['data: {"ok":true}\n\ndata: {"unexpected":true}\n\n'], { open: true, cancel: () => { cancelled += 1; } });
  const events = [];
  await readSseEvents(response, undefined, event => { events.push(event); return true; });
  assert.equal(events.length, 1);
  assert.equal(cancelled, 1);
  assert.equal(response.body.locked, false);

  const broken = streamResponse(['data: {}\n\n'], { open: true, cancel: () => { cancelled += 1; } });
  await assert.rejects(() => readSseEvents(broken, undefined, () => { throw new Error("callback failed"); }), /callback failed/);
  assert.equal(cancelled, 2);
  assert.equal(broken.body.locked, false);
});

test("SSE cleanup does not wait for a non-settling underlying cancellation", async () => {
  const response = streamResponse(['data: {}\n\n'], { open: true, cancel: () => new Promise(() => {}) });
  await readSseEvents(response, undefined, () => true);
  assert.equal(response.body.locked, false);
});

test("SSE abort wins over an early-stop callback", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled in callback", "AbortError");
  await assert.rejects(() => readSseEvents(streamResponse(['data: {}\n\n']), controller.signal, () => {
    controller.abort(reason);
    return true;
  }), error => error === reason);
});

test("SSE accepts an unterminated last frame and skips malformed frames", async () => {
  const events = [];
  await readSseEvents(streamResponse(['data: not-json\n\n: keepalive\n\ndata: {"ok":true}']), undefined, event => { events.push(event); });
  assert.deepEqual(events, [{ event: "", data: { ok: true } }]);
});
