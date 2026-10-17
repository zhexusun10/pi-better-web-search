import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockCtx,
  createModel,
  ollamaCloudModel,
  withEnv,
} from "./helpers.mjs";
import { getProviderFamily } from "../lib/families.ts";
import {
  OLLAMA_SEARCH_MAX_RESULTS,
  ollamaAdapter,
  resolveOllamaApiRoot,
} from "../lib/providers/ollama.ts";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Ollama Cloud detection is provider- or exact-host-based", () => {
  assert.equal(getProviderFamily(ollamaCloudModel()), "ollama");
  assert.equal(
    getProviderFamily(createModel({ provider: "my-proxy", baseUrl: "https://ollama.com/v1" })),
    "ollama",
  );
  assert.equal(
    getProviderFamily(createModel({ provider: "ollama", baseUrl: "http://localhost:11434/v1" })),
    undefined,
  );
  assert.equal(
    getProviderFamily(createModel({ provider: "other", baseUrl: "https://example.test/v1" })),
    undefined,
  );
});

test("resolveOllamaApiRoot strips trailing version suffixes and honors auth base URLs", () => {
  assert.equal(resolveOllamaApiRoot(ollamaCloudModel()), "https://ollama.com");
  assert.equal(
    resolveOllamaApiRoot(createModel({ baseUrl: "https://proxy.test/ollama/v1/" })),
    "https://proxy.test/ollama",
  );
  assert.equal(
    resolveOllamaApiRoot(createModel({ baseUrl: "https://proxy.test/ollama/v12" })),
    "https://proxy.test/ollama",
  );
  assert.equal(
    resolveOllamaApiRoot(
      createModel({ baseUrl: "https://ollama.com/v1" }),
      { ok: true, baseUrl: "https://proxy.test/custom/v1/" },
    ),
    "https://proxy.test/custom",
  );
  assert.equal(resolveOllamaApiRoot("https://proxy.test/string/v1/"), "https://proxy.test/string");
});

test("Ollama search sends the cloud request and preserves raw results", async (t) => {
  const raw = [
    {
      title: "Pi",
      url: "https://example.com/pi?utm_source=ollama",
      content: "An agent harness.",
      unknown: { raw: true },
    },
    {
      title: "Duplicate Pi",
      url: "https://example.com/pi?utm_source=ollama",
      content: "Deliberately duplicated.",
    },
  ];
  const controller = new AbortController();
  const ctx = createMockCtx({
    model: ollamaCloudModel(),
    auth: { ok: true, apiKey: "ollama-key" },
  });

  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://ollama.com/api/web_search");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer ollama-key");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), {
      query: "pi agent",
      max_results: OLLAMA_SEARCH_MAX_RESULTS,
    });
    assert.equal(OLLAMA_SEARCH_MAX_RESULTS, 10);
    return jsonResponse({ results: raw });
  });

  const result = await ollamaAdapter.search(ctx, ctx.model, "pi agent", controller.signal);

  assert.deepEqual(result, { results: raw });
});

test("Ollama search defaults a missing results field to an empty array", async (t) => {
  const responses = [jsonResponse({}), jsonResponse({ results: [] })];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  const ctx = createMockCtx({ model: ollamaCloudModel() });

  assert.deepEqual(await ollamaAdapter.search(ctx, ctx.model, "first", undefined), { results: [] });
  assert.deepEqual(await ollamaAdapter.search(ctx, ctx.model, "second", undefined), { results: [] });
});

test("Ollama fetch posts each URL and preserves raw title/content/links", async (t) => {
  const urls = ["https://example.com/a", "https://example.com/b"];
  const requests = [];
  const ctx = createMockCtx({ model: ollamaCloudModel() });

  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    const target = JSON.parse(init.body).url;
    return jsonResponse({
      title: `Page ${target}`,
      content: `Body ${target}`,
      links: [`${target}/next`],
      extra: { raw: true },
    });
  });

  const result = await ollamaAdapter.fetch(ctx, ctx.model, urls, "ignored", undefined);

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, "https://ollama.com/api/web_fetch");
    assert.deepEqual(JSON.parse(request.init.body), { url: urls[index] });
  }
  assert.deepEqual(result, {
    entries: urls.map((url) => ({
      url,
      data: {
        title: `Page ${url}`,
        content: `Body ${url}`,
        links: [`${url}/next`],
        extra: { raw: true },
      },
    })),
  });
});

test("Ollama fetch reports per-URL failures in entries", async (t) => {
  const urls = ["https://example.com/ok", "https://example.com/missing", "https://example.com/gone"];
  const responses = [
    jsonResponse({ title: "OK", content: "Body", links: [] }),
    jsonResponse({ error: { message: "missing page" } }, 404),
    jsonResponse({ error: { message: "gone page" } }, 403),
  ];
  const ctx = createMockCtx({ model: ollamaCloudModel() });

  t.mock.method(globalThis, "fetch", async () => responses.shift());

  const result = await ollamaAdapter.fetch(ctx, ctx.model, urls, undefined, undefined);

  assert.equal(result.entries.length, urls.length);
  assert.deepEqual(result.entries[0], {
    url: urls[0],
    data: { title: "OK", content: "Body", links: [] },
  });
  assert.match(result.entries[1].error, /404/);
  assert.match(result.entries[1].error, /missing page/);
  assert.match(result.entries[2].error, /403/);
  assert.match(result.entries[2].error, /gone page/);
});

test("Ollama search errors include the HTTP status and provider message", async (t) => {
  const statuses = [401, 429, 500];
  const ctx = createMockCtx({ model: ollamaCloudModel() });
  t.mock.method(globalThis, "fetch", async () => {
    const status = statuses.shift();
    return jsonResponse({ error: { message: `ollama-${status}` } }, status);
  });

  for (const status of [401, 429, 500]) {
    await assert.rejects(
      () => ollamaAdapter.search(ctx, ctx.model, "query", undefined),
      (error) => {
        assert.match(error.message, new RegExp(String(status)));
        assert.match(error.message, new RegExp(`ollama-${status}`));
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test("Ollama fetch rethrows global errors instead of hiding them in entries", async (t) => {
  const statuses = [401, 402, 429, 500];
  const ctx = createMockCtx({ model: ollamaCloudModel() });
  t.mock.method(globalThis, "fetch", async () => {
    const status = statuses.shift();
    return jsonResponse({ error: { message: `fetch-${status}` } }, status);
  });

  for (const status of [401, 402, 429, 500]) {
    await assert.rejects(
      () => ollamaAdapter.fetch(ctx, ctx.model, ["https://example.com"], undefined, undefined),
      new RegExp(String(status)),
    );
  }
});

test("Ollama uses OLLAMA_API_KEY and explicit auth headers", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ results: [] });
  });

  await withEnv({ OLLAMA_API_KEY: "env-ollama-key" }, async () => {
    const ctx = createMockCtx({ model: ollamaCloudModel(), auth: { ok: true } });
    await ollamaAdapter.search(ctx, ctx.model, "env", undefined);
  });
  assert.equal(requests[0].init.headers.Authorization, "Bearer env-ollama-key");

  const headerCtx = createMockCtx({
    model: ollamaCloudModel(),
    auth: { ok: true, headers: { Authorization: "Bearer explicit-header-key" } },
  });
  await ollamaAdapter.search(headerCtx, headerCtx.model, "header", undefined);
  assert.equal(requests[1].init.headers.Authorization, "Bearer explicit-header-key");
});

test("Ollama throws a clear missing-key error before fetching", async (t) => {
  await withEnv({ OLLAMA_API_KEY: undefined }, async () => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
    const ctx = createMockCtx({ model: ollamaCloudModel(), auth: { ok: true } });

    await assert.rejects(
      () => ollamaAdapter.search(ctx, ctx.model, "query", undefined),
      /OLLAMA_API_KEY|\/login ollama-cloud/,
    );
    await assert.rejects(
      () => ollamaAdapter.fetch(ctx, ctx.model, ["https://example.com"], undefined, undefined),
      /OLLAMA_API_KEY|\/login ollama-cloud/,
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
});

test("Ollama propagates aborts", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const ctx = createMockCtx({ model: ollamaCloudModel() });

  await assert.rejects(
    () => ollamaAdapter.search(ctx, ctx.model, "query", controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(
    () => ollamaAdapter.fetch(ctx, ctx.model, ["https://example.com"], undefined, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(fetch.mock.callCount(), 0);
});
