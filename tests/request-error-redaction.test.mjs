import assert from "node:assert/strict";
import test from "node:test";
import { providerFetch } from "../lib/attempt-timeout.ts";
import { createRequestErrorRedactor, HttpError } from "../lib/providers/http.ts";

const key = 'unit-test-request-"key\\suffix';

test("request error redaction handles header forms, structured bodies and failure metadata", () => {
  for (const headers of [
    { Authorization: `Bearer ${key}` }, { Authorization: `Basic ${key}` },
    [["X-API-Key", key]], new Headers({ "X-API-Key": key }),
    { "X-Provider-Token": [key, "second-provider-token"] },
    { "X-API-Key": `${key}非ASCII` },
  ]) {
    const sentKey = typeof headers["X-API-Key"] === "string" ? headers["X-API-Key"] : key;
    const error = Object.assign(new TypeError(`fetch failed for ${sentKey}`), {
      status: 503, code: "ECONNRESET", body: { credential: sentKey },
    });
    const redact = createRequestErrorRedactor(headers);
    const safe = redact(error);
    assert.equal(safe.name, "TypeError");
    assert.equal(safe.status, 503);
    assert.equal(safe.code, "ECONNRESET");
    assert.match(safe.message, /\[REDACTED\]/);
    assert.deepEqual(safe.body, { credential: "[REDACTED]" });
    assert.equal(error.body.credential, sentKey, "do not mutate the original error body");
  }
});

test("request error redaction preserves HttpError status/code and leaves credential-free errors alone", () => {
  const error = new HttpError(429, `denied ${key}`, JSON.stringify({ token: key }), "RATE_LIMIT");
  const safe = createRequestErrorRedactor({ Authorization: `Bearer ${key}` })(error);
  assert.ok(safe instanceof HttpError);
  assert.equal(safe.status, 429);
  assert.equal(safe.code, "RATE_LIMIT");
  assert.deepEqual(JSON.parse(safe.body), { token: "[REDACTED]" });
  assert.equal(createRequestErrorRedactor({ Accept: "application/json" })(error), error);
  assert.equal(createRequestErrorRedactor({ Authorization: "  " })(error), error);
});

test("provider transport snapshots credentials before synchronous errors or header mutation", async t => {
  const headers = { Authorization: `Bearer ${key}` };
  t.mock.method(globalThis, "fetch", () => {
    headers.Authorization = "Bearer replacement-key";
    throw new Error(`transport failed ${key}`);
  });
  await assert.rejects(() => providerFetch("https://example.com", { headers }), error => {
    assert.equal(error.message.includes(key), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test("provider transport preserves the exact external cancellation reason", async t => {
  const controller = new AbortController();
  const reason = { source: "caller", message: "stop now" };
  t.mock.method(globalThis, "fetch", () => {
    controller.abort(reason);
    throw new Error(`transport failed ${key}`);
  });
  await assert.rejects(() => providerFetch("https://example.com", {
    headers: { Authorization: `Bearer ${key}` }, signal: controller.signal,
  }), error => error === reason);
});
