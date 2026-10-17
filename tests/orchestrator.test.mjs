import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockCtx,
  deepseekModel,
  googleModel,
  openaiResponsesModel,
  unsupportedLocalModel,
  withTempCache,
} from "./helpers.mjs";

import { readCache, writeCache, fingerprintAvailableModels } from "../src/cache.ts";
import { MAX_OUTPUT_CHARS } from "../src/format.ts";
import { ADAPTERS } from "../src/providers/index.ts";
import { parseWebSearchInput, runWebSearch } from "../src/search.ts";

async function withAdapterPatch(patches, fn) {
  const originals = [];
  try {
    for (const [adapter, key, replacement] of patches) {
      originals.push([adapter, key, adapter[key]]);
      adapter[key] = replacement;
    }
    return await fn();
  } finally {
    for (const [adapter, key, original] of originals.reverse()) {
      adapter[key] = original;
    }
  }
}

test("input parsing trims queries, preserves operators, and validates URLs", () => {
  assert.deepEqual(parseWebSearchInput({ query: "  cats AND dogs  " }), {
    ok: true,
    query: "cats AND dogs",
    urls: [],
    urlErrors: [],
  });

  assert.deepEqual(parseWebSearchInput({ urls: ["https://example.com/a"] }), {
    ok: true,
    urls: ["https://example.com/a"],
    urlErrors: [],
  });

  assert.deepEqual(
    parseWebSearchInput({
      query: "q",
      urls: ["https://example.com/a", "https://example.com/a"],
    }),
    {
      ok: true,
      query: "q",
      urls: ["https://example.com/a", "https://example.com/a"],
      urlErrors: [],
    },
  );

  const mixed = parseWebSearchInput({
    query: "q",
    urls: [
      "https://example.com/a",
      "ftp://example.com/file",
      "https://user:pass@example.com/",
      "https://example.com/ok",
    ],
  });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.urls, ["https://example.com/a", "https://example.com/ok"]);
  assert.equal(mixed.urlErrors.length, 2);

  const invalidOnly = parseWebSearchInput({ urls: ["not a url"] });
  assert.equal(invalidOnly.ok, false);
  assert.match(invalidOnly.error, /not a url/);
  assert.match(invalidOnly.error, /valid URL|valid query|valid URL/);

  const tooMany = parseWebSearchInput({
    urls: Array.from({ length: 21 }, (_, index) => `https://example.com/${index}`),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /20/);

  assert.equal(parseWebSearchInput({ query: "   " }).ok, false);
});

test("no supported provider returns a clear error instead of calling an adapter", async () => {
  const ctx = createMockCtx({ model: unsupportedLocalModel() });
  const result = await runWebSearch({ query: "anything" }, ctx);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Failed: No supported web search provider is available/);
});

test("output wrapper keeps provider results raw and fetch data untouched", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });
  const updates = [];
  const onUpdate = (update) => updates.push(update);

  const searchResult = {
    answer: "raw answer",
    results: [{ title: "one", url: "https://example.com/one", score: 0.9 }],
    citations: [{ url: "https://example.com/one" }],
    searchQueries: ["original query"],
    groundingMetadata: { raw: true },
    urlContextMetadata: { alsoRaw: true },
  };

  await withTempCache(async () => {
    await withAdapterPatch(
      [
        [ADAPTERS.deepseek, "search", async () => searchResult],
        [
          ADAPTERS.deepseek,
          "fetch",
          async (_ctx, _model, urls) => ({
            entries: urls.map((url, index) => ({
              url,
              data: { raw: url, index },
            })),
          }),
        ],
      ],
      async () => {
        const result = await runWebSearch(
          {
            query: "original query",
            urls: ["https://example.com/a", "https://example.com/a"],
          },
          ctx,
          undefined,
          onUpdate,
        );

        assert.equal(result.isError, undefined);
        const output = JSON.parse(result.content[0].text);
        assert.deepEqual(output.search, {
          provider: "deepseek",
          model: "deepseek-chat",
          ...searchResult,
        });
        assert.equal(output.fetched.length, 2);
        assert.deepEqual(output.fetched[0], {
          url: "https://example.com/a",
          provider: "deepseek",
          model: "deepseek-chat",
          data: { raw: "https://example.com/a", index: 0 },
        });
        assert.deepEqual(output.fetched[1], {
          url: "https://example.com/a",
          provider: "deepseek",
          model: "deepseek-chat",
          data: { raw: "https://example.com/a", index: 1 },
        });

        assert.equal(result.details.provider, "deepseek");
        assert.equal(result.details.model, "deepseek-chat");
        assert.deepEqual(result.details.fetchProviders, ["deepseek"]);
        assert.equal(result.details.fetchedCount, 2);
        assert.equal(result.details.resultCount, 1);
        assert.ok(updates.length > 0);
        assert.ok(
          updates.every((update) =>
            update.content.every((part) => part.type === "text" && !part.text.startsWith("{")),
          ),
        );

        const cache = readCache();
        assert.deepEqual(cache.search, { provider: "deepseek", model: "deepseek-chat" });
        assert.deepEqual(cache.fetch, { provider: "deepseek", model: "deepseek-chat" });
        assert.equal(cache.fingerprint, fingerprintAvailableModels(ctx));
      },
    );
  });
});

test("search falls back to the next candidate and records the failed attempt", async () => {
  const deepseek = deepseekModel();
  const google = googleModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek, google] });

  await withTempCache(async () => {
    await withAdapterPatch(
      [
        [
          ADAPTERS.deepseek,
          "search",
          async () => {
            throw new Error("deepseek unavailable");
          },
        ],
        [ADAPTERS.google, "search", async () => ({ results: [{ title: "google" }] })],
      ],
      async () => {
        const result = await runWebSearch({ query: "fallback" }, ctx);
        const output = JSON.parse(result.content[0].text);
        assert.equal(result.isError, undefined);
        assert.equal(output.search.provider, "google");
        assert.equal(result.details.attempts.length, 1);
        assert.equal(result.details.attempts[0].phase, "search");
        assert.equal(result.details.attempts[0].provider, "deepseek");
        assert.match(result.details.attempts[0].message, /deepseek unavailable/);
      },
    );
  });
});

test("invalid URL entries are included alongside valid fetch results", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    await withAdapterPatch(
      [
        [
          ADAPTERS.deepseek,
          "fetch",
          async (_ctx, _model, urls) => ({
            entries: urls.map((url) => ({ url, data: { url } })),
          }),
        ],
      ],
      async () => {
        const result = await runWebSearch(
          {
            urls: ["https://example.com/valid", "mailto:test@example.com"],
          },
          ctx,
        );
        const output = JSON.parse(result.content[0].text);
        assert.equal(output.query, undefined);
        assert.deepEqual(output.fetched, [
          {
            url: "https://example.com/valid",
            provider: "deepseek",
            model: "deepseek-chat",
            data: { url: "https://example.com/valid" },
          },
          {
            url: "mailto:test@example.com",
            error: "URL must use http or https",
          },
        ]);
      },
    );
  });
});

test("invalid URLs supplied with a query are reported instead of dropped", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    await withAdapterPatch(
      [[ADAPTERS.deepseek, "search", async () => ({ results: [{ title: "search wins" }] })]],
      async () => {
        const result = await runWebSearch(
          {
            query: "query with bad urls",
            urls: ["ftp://example.com/file", "not a url"],
          },
          ctx,
        );
        assert.equal(result.isError, undefined);
        const output = JSON.parse(result.content[0].text);
        assert.equal(output.search.results[0].title, "search wins");
        assert.equal(output.fetched.length, 2);
        assert.match(output.fetched[0].error, /http or https/);
        assert.match(output.fetched[1].error, /not a valid URL/);
      },
    );
  });
});

test("valid URLs with no URL-capable provider return a clear tool error", async () => {
  const openai = openaiResponsesModel();
  const ctx = createMockCtx({ model: openai, availableModels: [openai] });

  await withTempCache(async () => {
    let searchCalls = 0;
    await withAdapterPatch(
      [
        [
          ADAPTERS.openai,
          "search",
          async () => {
            searchCalls += 1;
            return { results: [] };
          },
        ],
      ],
      async () => {
        const result = await runWebSearch(
          { query: "needs urls", urls: ["https://example.com/page"] },
          ctx,
        );
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /No URL fetch provider is available/);
        assert.equal(result.details.attempts.length, 0);
        assert.equal(searchCalls, 1);
        assert.deepEqual(readCache().search, { provider: "openai", model: "gpt-5.1" });
      },
    );
  });
});

test("only URLs requested and none fetched returns an error", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    await withAdapterPatch(
      [
        [
          ADAPTERS.deepseek,
          "fetch",
          async (_ctx, _model, urls) => ({
            entries: urls.map((url) => ({ url, error: "blocked" })),
          }),
        ],
      ],
      async () => {
        const result = await runWebSearch({ urls: ["https://example.com/nope"] }, ctx);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /URL fetch failed/);
        assert.match(result.content[0].text, /blocked/);
      },
    );
  });
});

test("oversized output is truncated after raw JSON is assembled", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    await withAdapterPatch(
      [
        [
          ADAPTERS.deepseek,
          "search",
          async () => ({ results: [{ text: "x".repeat(MAX_OUTPUT_CHARS + 1_000) }] }),
        ],
      ],
      async () => {
        const result = await runWebSearch({ query: "truncate" }, ctx);
        assert.equal(result.isError, undefined);
        assert.equal(result.details.truncated, true);
        assert.ok(result.content[0].text.length <= MAX_OUTPUT_CHARS);
        assert.ok(result.content[0].text.endsWith("[Truncated]"));
      },
    );
  });
});

test("a successful search does not carry an unverified stale preference into a new fingerprint", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint: "stale",
      fetch: { provider: "google", model: "gemini-2.5-flash" },
    });

    await withAdapterPatch(
      [[ADAPTERS.deepseek, "search", async () => ({ results: [] })]],
      async () => {
        const result = await runWebSearch({ query: "cache" }, ctx);
        assert.equal(result.isError, undefined);
        const cache = readCache();
        assert.deepEqual(cache.search, { provider: "deepseek", model: "deepseek-chat" });
        assert.equal(cache.fetch, undefined);
        assert.equal(cache.fingerprint, fingerprintAvailableModels(ctx));
      },
    );
  });
});

test("a matching fingerprint preserves a preference when this call's fetch fails", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint: fingerprintAvailableModels(ctx),
      fetch: { provider: "google", model: "gemini-2.5-flash" },
    });

    await withAdapterPatch(
      [
        [ADAPTERS.deepseek, "search", async () => ({ results: [] })],
        [
          ADAPTERS.deepseek,
          "fetch",
          async (_ctx, _model, urls) => ({
            entries: urls.map((url) => ({ url, error: "blocked" })),
          }),
        ],
      ],
      async () => {
        const result = await runWebSearch(
          { query: "cache", urls: ["https://example.com/blocked"] },
          ctx,
        );
        assert.equal(result.isError, undefined);
        assert.equal(JSON.parse(result.content[0].text).fetched[0].error, "blocked");
        const cache = readCache();
        assert.deepEqual(cache.search, { provider: "deepseek", model: "deepseek-chat" });
        assert.deepEqual(cache.fetch, { provider: "google", model: "gemini-2.5-flash" });
        assert.equal(cache.fingerprint, fingerprintAvailableModels(ctx));
      },
    );
  });
});

test("a matching fingerprint preserves an unrequested preference", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint: fingerprintAvailableModels(ctx),
      fetch: { provider: "google", model: "gemini-2.5-flash" },
    });

    await withAdapterPatch(
      [[ADAPTERS.deepseek, "search", async () => ({ results: [] })]],
      async () => {
        const result = await runWebSearch({ query: "cache" }, ctx);
        assert.equal(result.isError, undefined);
        const cache = readCache();
        assert.deepEqual(cache.search, { provider: "deepseek", model: "deepseek-chat" });
        assert.deepEqual(cache.fetch, { provider: "google", model: "gemini-2.5-flash" });
        assert.equal(cache.fingerprint, fingerprintAvailableModels(ctx));
      },
    );
  });
});
