import assert from "node:assert/strict";
import test from "node:test";

import { deepseekModel, createMockCtx, withEnv } from "./helpers.mjs";
import {
  DEEPSEEK_MAX_QUERY_LENGTH,
  DEEPSEEK_NEED_CONTENT,
  DEEPSEEK_SEARCH_COUNT,
  deepseekAdapter,
  resolveDeepSeekToolUrl,
} from "../src/providers/deepseek.ts";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawResults() {
  return [
    {
      rerank_score: 0.98,
      title: "First",
      url: "https://example.com/a?utm_source=test",
      snippet: "Snippet",
      summary: "Summary",
      content: "Content",
      site_name: "Example",
      site_icon: "https://example.com/icon.png",
      date: "2026-01-02",
      authority: "high",
      unknown_field: { nested: true },
    },
    {
      rerank_score: 0.42,
      title: "Duplicate URL",
      url: "https://example.com/a?utm_source=test",
      snippet: "Same URL, deliberately not deduped",
    },
  ];
}

test("DeepSeek tool URL builder preserves proxy paths and strips only API suffixes", () => {
  for (const suffix of ["", "/", "/v1", "/v1/", "/anthropic", "/anthropic/v1/"]) {
    const base = `https://proxy.test/deepseek${suffix}`;
    assert.equal(
      resolveDeepSeekToolUrl(base, "search"),
      "https://proxy.test/deepseek/v1/tools/search",
    );
    assert.equal(
      resolveDeepSeekToolUrl(base, "fetch"),
      "https://proxy.test/deepseek/v1/tools/fetch",
    );
  }

  assert.equal(
    resolveDeepSeekToolUrl("https://api.deepseek.com", "search"),
    "https://api.deepseek.com/v1/tools/search",
  );
  assert.equal(
    resolveDeepSeekToolUrl("https://api.deepseek.com/v1", "fetch"),
    "https://api.deepseek.com/v1/tools/fetch",
  );
});

test("DeepSeek search sends the native request and returns raw results", async (t) => {
  const raw = rawResults();
  const controller = new AbortController();
  const ctx = createMockCtx({ model: deepseekModel(), auth: { ok: true, apiKey: "test-key" } });

  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), {
      query: "deepseek operators site:example.com",
      count: DEEPSEEK_SEARCH_COUNT,
      need_content: DEEPSEEK_NEED_CONTENT,
    });
    assert.equal(DEEPSEEK_SEARCH_COUNT, 10);
    assert.equal(DEEPSEEK_NEED_CONTENT, true);
    return jsonResponse({ results: raw });
  });

  const result = await deepseekAdapter.search(
    ctx,
    ctx.model,
    "deepseek operators site:example.com",
    controller.signal,
  );

  assert.deepEqual(result, { results: raw });
});

test("DeepSeek search preserves empty and missing result arrays", async (t) => {
  const responses = [jsonResponse({ results: [] }), jsonResponse({})];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  const ctx = createMockCtx({ model: deepseekModel() });

  assert.deepEqual(await deepseekAdapter.search(ctx, ctx.model, "empty", undefined), { results: [] });
  assert.deepEqual(await deepseekAdapter.search(ctx, ctx.model, "missing", undefined), {
    results: undefined,
  });
});

test("DeepSeek rejects an invalid query before fetching", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const ctx = createMockCtx({ model: deepseekModel() });

  await assert.rejects(
    () => deepseekAdapter.search(ctx, ctx.model, "", undefined),
    new RegExp(`1-${DEEPSEEK_MAX_QUERY_LENGTH}`),
  );
  await assert.rejects(
    () => deepseekAdapter.search(ctx, ctx.model, "   \t\n ", undefined),
    /non-whitespace/,
  );
  await assert.rejects(
    () => deepseekAdapter.search(ctx, ctx.model, "x".repeat(DEEPSEEK_MAX_QUERY_LENGTH + 1), undefined),
    new RegExp(`1-${DEEPSEEK_MAX_QUERY_LENGTH}`),
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("DeepSeek fetch posts one request per URL and keeps raw fetch payloads", async (t) => {
  const urls = ["https://example.com/a", "https://example.com/b"];
  const requests = [];
  const ctx = createMockCtx({ model: deepseekModel(), auth: { ok: true, apiKey: "test-key" } });

  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    const target = JSON.parse(init.body).url;
    return jsonResponse({
      title: `Title ${target}`,
      content: `Content ${target}`,
      provider_extra: { raw: true },
    });
  });

  const result = await deepseekAdapter.fetch(ctx, ctx.model, urls, "ignored query", undefined);

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, "https://api.deepseek.com/v1/tools/fetch");
    assert.equal(request.init.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(request.init.body), { url: urls[index] });
  }
  assert.deepEqual(result, {
    entries: urls.map((url) => ({
      url,
      data: {
        title: `Title ${url}`,
        content: `Content ${url}`,
        provider_extra: { raw: true },
      },
    })),
  });
});

test("DeepSeek fetch turns per-URL failures into entries", async (t) => {
  const urls = [
    "https://example.com/ok",
    "https://example.com/forbidden",
    "https://example.com/missing",
    "not a url",
  ];
  const responses = [
    jsonResponse({ title: "OK", content: "Body" }),
    jsonResponse({ error: { message: "forbidden", type: "permission_error" } }, 403),
    jsonResponse({ error: { message: "not found", type: "not_found_error" } }, 404),
  ];
  const ctx = createMockCtx({ model: deepseekModel() });

  t.mock.method(globalThis, "fetch", async () => responses.shift());

  const result = await deepseekAdapter.fetch(ctx, ctx.model, urls, undefined, undefined);

  assert.equal(result.entries.length, urls.length);
  assert.deepEqual(result.entries[0], {
    url: urls[0],
    data: { title: "OK", content: "Body" },
  });
  assert.match(result.entries[1].error, /403/);
  assert.match(result.entries[1].error, /forbidden/);
  assert.match(result.entries[2].error, /404/);
  assert.match(result.entries[3].error, /Invalid URL/);
});

test("DeepSeek rejects an overlong or credentialed URL per entry", async (t) => {
  const urls = [
    `https://example.com/${"x".repeat(8192)}`,
    "https://user:password@example.com/private",
    "ftp://example.com/file",
  ];
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const ctx = createMockCtx({ model: deepseekModel() });

  const result = await deepseekAdapter.fetch(ctx, ctx.model, urls, undefined, undefined);

  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(result.entries.length, urls.length);
  for (const entry of result.entries) assert.match(entry.error, /Invalid URL/);
});

test("DeepSeek search error statuses are thrown with provider messages", async (t) => {
  const expectedStatuses = [400, 401, 402, 403, 404, 408, 413, 429, 500, 504];
  const statuses = [...expectedStatuses];
  const ctx = createMockCtx({ model: deepseekModel() });

  t.mock.method(globalThis, "fetch", async (_url, _init) => {
    const status = statuses.shift();
    return jsonResponse(
      { error: { message: `failure-${status}`, type: "provider_error", param: null, code: "code" } },
      status,
    );
  });

  for (const status of expectedStatuses) {
    await assert.rejects(
      () => deepseekAdapter.search(ctx, ctx.model, "query", undefined),
      (error) => {
        assert.match(error.message, new RegExp(String(status)));
        assert.match(error.message, new RegExp(`failure-${status}`));
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test("DeepSeek fetch rethrows global auth, rate-limit, and server errors", async (t) => {
  const expectedStatuses = [400, 401, 402, 408, 413, 429, 500, 504];
  const statuses = [...expectedStatuses];
  const ctx = createMockCtx({ model: deepseekModel() });
  t.mock.method(globalThis, "fetch", async () => {
    const status = statuses.shift();
    return jsonResponse({ error: { message: `fetch-${status}` } }, status);
  });

  for (const status of expectedStatuses) {
    await assert.rejects(
      () => deepseekAdapter.fetch(ctx, ctx.model, ["https://example.com"], undefined, undefined),
      new RegExp(String(status)),
    );
  }
});

test("DeepSeek honors auth headers, base URL overrides, and env credentials", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ results: [] });
  });

  const headerCtx = createMockCtx({
    model: deepseekModel(),
    auth: {
      ok: true,
      apiKey: "unused-key",
      headers: { Authorization: "Bearer explicit-header-key" },
      baseUrl: "https://proxy.test/deepseek/v1/",
    },
  });
  await deepseekAdapter.search(headerCtx, headerCtx.model, "header", undefined);
  assert.equal(requests[0].url, "https://proxy.test/deepseek/v1/tools/search");
  assert.equal(requests[0].init.headers.Authorization, "Bearer explicit-header-key");

  await withEnv({ DEEPSEEK_API_KEY: "env-key" }, async () => {
    const envCtx = createMockCtx({ model: deepseekModel(), auth: { ok: true } });
    await deepseekAdapter.search(envCtx, envCtx.model, "env", undefined);
  });
  assert.equal(requests[1].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(requests[1].init.headers.Authorization, "Bearer env-key");
});

test("DeepSeek throws a clear missing-credential error before fetching", async (t) => {
  await withEnv({ DEEPSEEK_API_KEY: undefined }, async () => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
    const ctx = createMockCtx({ model: deepseekModel(), auth: { ok: true } });
    await assert.rejects(
      () => deepseekAdapter.search(ctx, ctx.model, "query", undefined),
      /DeepSeek|DEEPSEEK_API_KEY|\/login/,
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
});

test("DeepSeek propagates aborts without turning them into fetch entries", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const ctx = createMockCtx({ model: deepseekModel() });

  await assert.rejects(
    () => deepseekAdapter.search(ctx, ctx.model, "query", controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(
    () => deepseekAdapter.fetch(ctx, ctx.model, ["https://example.com"], undefined, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(fetch.mock.callCount(), 0);
});
