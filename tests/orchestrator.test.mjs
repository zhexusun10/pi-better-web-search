import assert from "node:assert/strict";
import test from "node:test";

import {
  createMockCtx,
  deepseekModel,
  googleModel,
  ollamaCloudModel,
  openaiResponsesModel,
  unsupportedLocalModel,
  withTempCache,
} from "./helpers.mjs";

import { readCache, writeCache, fingerprintAvailableModels } from "../lib/cache.ts";
import { FETCH_ATTEMPT_CAP, getFetchCandidates, getSearchCandidates, resolveResolutionContext, SEARCH_ATTEMPT_CAP } from "../lib/candidates.ts";
import { MAX_OUTPUT_CHARS } from "../lib/format.ts";
import { isProviderCoolingDown, recordProviderFailure } from "../lib/health.ts";
import { ADAPTERS } from "../lib/providers/index.ts";
import { parseWebSearchInput, runWebSearch, isProviderWideFailure } from "../lib/search.ts";

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
  assert.equal(result.content[0].text, "Failed: This tool is not available in this conversation.");
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
        assert.deepEqual(output.search, searchResult);
        assert.equal(output.fetched.length, 2);
        assert.deepEqual(output.fetched[0], {
          url: "https://example.com/a",
          data: { raw: "https://example.com/a", index: 0 },
        });
        assert.deepEqual(output.fetched[1], {
          url: "https://example.com/a",
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

test("a model-specific search error falls back to a sibling model in the same family", async () => {
  const primary = openaiResponsesModel({ id: "gpt-5.1" });
  const sibling = openaiResponsesModel({ id: "gpt-4.1" });
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: [primary, sibling] });

  await withTempCache(async () => {
    const calls = [];
    await withAdapterPatch(
      [
        [
          ADAPTERS.openai,
          "search",
          async (_ctx, model) => {
            calls.push(model.id);
            if (model.id === "gpt-5.1") {
              throw new Error(
                "OpenAI API error (400 Bad Request): this account does not support gpt-5.1",
              );
            }
            return { results: [{ title: "sibling model" }] };
          },
        ],
      ],
      async () => {
        const result = await runWebSearch({ query: "sibling fallback" }, ctx);
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls, ["gpt-5.1", "gpt-4.1"]);
        assert.equal(JSON.parse(result.content[0].text).search.results[0].title, "sibling model");
        assert.equal(result.details.attempts.length, 1);
        assert.equal(result.details.attempts[0].model, "gpt-5.1");
      },
    );
  });
});

test("a provider-wide failure reaches another provider despite many current-provider siblings", async () => {
  const current = openaiResponsesModel({ id: "gpt-6.1" });
  const siblings = Array.from({ length: 20 }, (_, index) =>
    openaiResponsesModel({ id: `gpt-6.${index + 2}` }),
  );
  const codex = openaiResponsesModel({ id: "gpt-5.1", provider: "openai-codex", api: "openai-codex-responses" });
  const ctx = createMockCtx({ model: current, availableModels: [current, ...siblings, codex] });
  await withTempCache(async () => {
    const calls = [];
    await withAdapterPatch([[ADAPTERS.openai, "search", async (_ctx, model) => {
      calls.push(model.provider);
      if (model.provider === "openai") throw new Error("HTTP 401 Unauthorized");
      return { results: [{ title: "codex" }] };
    }]], async () => {
      const result = await runWebSearch({ query: "test" }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls, ["openai", "openai-codex"]);
    });
  });
});

test("cooldown is applied before the attempt cap to the entire discovery set", async () => {
  const models = Array.from({ length: 20 }, (_, index) =>
    openaiResponsesModel({ id: `gpt-5.${index}`, provider: `provider-${index}` }),
  );
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: models });
  await withTempCache(async () => {
    const initiallySelected = getSearchCandidates(resolveResolutionContext(ctx));
    assert.equal(initiallySelected.length, SEARCH_ATTEMPT_CAP);
    const cooling = new Set(initiallySelected.map((candidate) => candidate.model.provider));
    for (const provider of cooling) recordProviderFailure("search", provider, "HTTP 500");
    const calls = [];
    await withAdapterPatch([[ADAPTERS.openai, "search", async (_ctx, model) => {
      calls.push(model.provider);
      return { results: [] };
    }]], async () => {
      const result = await runWebSearch({ query: "test" }, ctx);
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(cooling.has(calls[0]), false);
    });
  });
});

test("actual search attempts are capped even with a larger discovery set", async () => {
  const models = Array.from({ length: 20 }, (_, index) =>
    openaiResponsesModel({ id: `gpt-5.${index}`, provider: `provider-${index}` }),
  );
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: models });
  await withTempCache(async () => {
    let calls = 0;
    await withAdapterPatch([[ADAPTERS.openai, "search", async () => {
      calls += 1;
      throw new Error("unsupported model");
    }]], async () => {
      const result = await runWebSearch({ query: "test" }, ctx);
      assert.equal(result.isError, true);
      assert.equal(calls, SEARCH_ATTEMPT_CAP);
      assert.equal(result.details.attempts.length, SEARCH_ATTEMPT_CAP);
    });
  });
});

test("fetch cooldown is applied before the attempt cap to all candidates", async () => {
  const models = Array.from({ length: 12 }, (_, index) =>
    googleModel({ id: `gemini-3.${index}-flash`, provider: `google-${index}` }),
  );
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: models });
  await withTempCache(async () => {
    const first = getFetchCandidates(resolveResolutionContext(ctx));
    const cooling = new Set(first.map((candidate) => candidate.model.provider));
    assert.equal(cooling.size, FETCH_ATTEMPT_CAP);
    for (const provider of cooling) recordProviderFailure("fetch", provider, "HTTP 500");
    const calls = [];
    await withAdapterPatch([[ADAPTERS.google, "fetch", async (_ctx, model, urls) => {
      calls.push(model.provider);
      return { entries: urls.map((url) => ({ url, data: { ok: true } })) };
    }]], async () => {
      const result = await runWebSearch({ urls: ["https://example.com/page"] }, ctx);
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(cooling.has(calls[0]), false);
    });
  });
});

test("actual fetch attempts are capped even with a larger discovery set", async () => {
  const models = Array.from({ length: 12 }, (_, index) =>
    googleModel({ id: `gemini-3.${index}-flash`, provider: `google-${index}` }),
  );
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: models });
  await withTempCache(async () => {
    let calls = 0;
    await withAdapterPatch([[ADAPTERS.google, "fetch", async () => {
      calls += 1;
      throw new Error("unsupported model");
    }]], async () => {
      const result = await runWebSearch({ urls: ["https://example.com/page"] }, ctx);
      assert.equal(result.isError, true);
      assert.equal(calls, FETCH_ATTEMPT_CAP);
      assert.equal(result.details.attempts.length, FETCH_ATTEMPT_CAP);
    });
  });
});

test("a provider-wide search error does not retry sibling models from the same provider", async () => {
  const primary = openaiResponsesModel({ id: "gpt-5.1" });
  const sibling = openaiResponsesModel({ id: "gpt-4.1" });
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: [primary, sibling] });

  await withTempCache(async () => {
    const calls = [];
    await withAdapterPatch(
      [
        [
          ADAPTERS.openai,
          "search",
          async (_ctx, model) => {
            calls.push(model.id);
            throw new Error("OpenAI API error (401 Unauthorized): invalid API key");
          },
        ],
      ],
      async () => {
        const result = await runWebSearch({ query: "provider wide" }, ctx);
        assert.equal(result.isError, true);
        assert.deepEqual(calls, ["gpt-5.1"]);
        assert.equal(result.details.attempts.length, 1);
      },
    );
  });
});

test("a provider-wide fetch error does not retry sibling models from the same provider", async () => {
  const primary = ollamaCloudModel({ provider: "ollama-cloud", id: "gpt-oss:120b" });
  const sibling = ollamaCloudModel({ provider: "ollama-cloud", id: "qwen3:32b" });
  const ctx = createMockCtx({
    model: unsupportedLocalModel(),
    availableModels: [primary, sibling],
  });

  await withTempCache(async () => {
    const calls = [];
    await withAdapterPatch(
      [
        [
          ADAPTERS.ollama,
          "fetch",
          async (_ctx, model) => {
            calls.push(model.id);
            throw new Error("Ollama API error (401 Unauthorized): invalid key");
          },
        ],
      ],
      async () => {
        const result = await runWebSearch({ urls: ["https://example.com/page"] }, ctx);
        assert.equal(result.isError, true);
        assert.deepEqual(calls, ["gpt-oss:120b"]);
        assert.equal(result.details.attempts.filter((entry) => entry.phase === "fetch").length, 1);
      },
    );
  });
});

test("provider-wide failures are classified separately from model-specific ones", () => {
  assert.equal(isProviderWideFailure("OpenAI API error (401 Unauthorized): bad key"), true);
  assert.equal(isProviderWideFailure("Anthropic API error (403 Forbidden): insufficient balance"), true);
  assert.equal(isProviderWideFailure("fetch failed"), true);
  assert.equal(isProviderWideFailure("Cannot convert argument to a ByteString"), true);
  assert.equal(isProviderWideFailure("OpenAI API error (500 Internal Server Error): upstream"), true);
  assert.equal(isProviderWideFailure("HTTP 429 Too Many Requests"), true);
  assert.equal(
    isProviderWideFailure(
      "OpenAI API error (400 Bad Request): Codex/ChatGPT account does not support gpt-4.1",
    ),
    false,
  );
  assert.equal(isProviderWideFailure("Google API error (404): model not found"), false);
  assert.equal(isProviderWideFailure("HTTP 403 Forbidden: You do not have access to the model gpt-6.1"), false);
  assert.equal(isProviderWideFailure("HTTP 403 Forbidden: Access denied", { status: 403, code: "model_not_allowed" }), false);
  assert.equal(isProviderWideFailure("HTTP 403 Forbidden: Access denied to model gpt-6"), false);
  assert.equal(isProviderWideFailure("HTTP 403 Forbidden: Access to model gpt-6 was denied"), false);
  assert.equal(isProviderWideFailure("HTTP 403 Forbidden: insufficient balance for this model"), true);
  assert.equal(isProviderWideFailure("Access denied", { status: 403 }), true);
  assert.equal(isProviderWideFailure("HTTP 401 Unauthorized: model not allowed"), true);
  assert.equal(
    isProviderWideFailure("OpenAI API error (400): max_tokens 500 is too large for this model"),
    false,
  );
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
        assert.equal(output.search.results[0].title, "google");
        assert.equal(result.details.attempts.length, 1);
        assert.equal(result.details.attempts[0].phase, "search");
        assert.equal(result.details.attempts[0].provider, "deepseek");
        assert.match(result.details.attempts[0].message, /deepseek unavailable/);
      },
    );
  });
});

test("fetch transport errors preserve partial results and cool the provider for later calls", async (t) => {
  const deepseek = deepseekModel();
  const google = googleModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek, google] });
  const urls = ["https://example.com/one", "https://example.com/two", "https://example.com/three"];
  await withTempCache(async () => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const url = JSON.parse(init.body).url;
      calls.push(`deepseek:${url}`);
      if (url === urls[0]) return Response.json({ title: "first" });
      throw new TypeError("fetch failed");
    });
    await withAdapterPatch([[ADAPTERS.google, "fetch", async (_ctx, _model, requested) => {
      calls.push(`google:${requested.join(",")}`);
      return { entries: requested.map((url) => ({ url, data: { title: "fallback" } })) };
    }]], async () => {
      const first = await runWebSearch({ urls }, ctx);
      assert.equal(first.isError, undefined);
      const output = JSON.parse(first.content[0].text);
      assert.equal(output.fetched[0].data.title, "first");
      assert.equal(output.fetched[1].data.title, "fallback");
      assert.equal(output.fetched[2].data.title, "fallback");
      assert.deepEqual(calls, [
        `deepseek:${urls[0]}`,
        `deepseek:${urls[1]}`,
        `google:${urls[1]},${urls[2]}`,
      ]);
      assert.equal(isProviderCoolingDown("fetch", "deepseek"), true);
      assert.equal(first.details.attempts[0].message, "fetch failed");
      calls.length = 0;
      const next = await runWebSearch({ urls: ["https://example.com/next"] }, ctx);
      assert.equal(next.isError, undefined);
      assert.deepEqual(calls, ["google:https://example.com/next"]);
    });
  });
});

test("URL-specific failures do not clear an existing provider cooldown", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });
  await withTempCache(async () => {
    recordProviderFailure("fetch", "deepseek", "fetch failed");
    await withAdapterPatch([[ADAPTERS.deepseek, "fetch", async (_ctx, _model, urls) => ({
      entries: urls.map((url) => ({ url, error: "blocked" })),
    })]], async () => {
      const result = await runWebSearch({ urls: ["https://example.com/blocked"] }, ctx);
      assert.equal(result.isError, true);
      assert.equal(isProviderCoolingDown("fetch", "deepseek"), true);
    });
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
        assert.equal(result.content[0].text, "Failed: URL fetch is not available in this conversation.");
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
        assert.doesNotMatch(result.content[0].text, /deepseek\/deepseek-chat:/);
      },
    );
  });
});

test("oversized search and fetch results share the budget with one trailing marker", async () => {
  const deepseek = deepseekModel();
  const ctx = createMockCtx({ model: deepseek, availableModels: [deepseek] });
  const urls = Array.from({ length: 4 }, (_, index) => `https://example.com/page-${index}`);

  await withTempCache(async () => {
    await withAdapterPatch(
      [
        [
          ADAPTERS.deepseek,
          "search",
          async () => ({
            results: Array.from({ length: 10 }, (_, index) => ({
              title: `result-${index}`,
              url: `https://example.com/result-${index}`,
              content: "s".repeat(8_000),
            })),
          }),
        ],
        [
          ADAPTERS.deepseek,
          "fetch",
          async (_ctx, _model, requested) => ({
            entries: requested.map((url, index) => ({
              url,
              data: { title: `page-${index}`, content: "p".repeat(30_000) },
            })),
          }),
        ],
      ],
      async () => {
        const result = await runWebSearch({ query: "truncate", urls }, ctx);
        assert.equal(result.isError, undefined);
        assert.equal(result.details.truncated, true);
        assert.equal(result.details.fetchedCount, 4);
        assert.ok(Array.from(result.content[0].text).length <= MAX_OUTPUT_CHARS);
        const text = result.content[0].text;
        const suffix = "\n[truncated]";
        assert.ok(text.startsWith('{"query":"truncate",'));
        assert.ok(text.endsWith(suffix));
        assert.equal(text.match(/\[truncated\]/g)?.length, 1);
        const output = JSON.parse(text.slice(0, -suffix.length));
        assert.deepEqual(Object.keys(output), ["query", "search", "fetched"]);
        assert.equal(output.search.results.length, 10);
        assert.deepEqual(output.fetched.map((entry) => entry.url), urls);
        for (const [index, entry] of output.search.results.entries()) {
          assert.equal(entry.title, `result-${index}`);
          assert.ok(entry.content.length > 100);
          assert.ok(entry.content.length < 8_000);
          assert.match(entry.content, /^s+$/);
        }
        for (const [index, entry] of output.fetched.entries()) {
          assert.equal(entry.data.title, `page-${index}`);
          assert.ok(entry.data.content.length > 100);
          assert.ok(entry.data.content.length < 30_000);
          assert.match(entry.data.content, /^p+$/);
        }
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
