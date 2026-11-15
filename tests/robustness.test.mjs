import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintAvailableModels } from "../lib/cache.ts";
import { candidateKey, getFetchCandidates, getSearchCandidates, resolveResolutionContext } from "../lib/candidates.ts";
import { ADAPTERS } from "../lib/providers/index.ts";
import { renderWebSearchResult } from "../lib/render.ts";
import { DEFAULT_ATTEMPT_TIMEOUT_MS, runWebSearch } from "../lib/search.ts";
import { createMockCtx, createModel, deepseekModel, googleModel, ollamaCloudModel, openaiResponsesModel, withEnv, withTempCache } from "./helpers.mjs";

const theme = { fg: (_color, text) => text, bold: text => text };
const render = result => renderWebSearchResult(result, { expanded: false, isPartial: false }, theme).render(200).join("\n");

test("an unsupported conversation API still supplies the current provider hint", async () => {
  await withTempCache(() => {
    const current = createModel({ provider: "gateway", id: "large-chat-model" });
    const preferred = openaiResponsesModel({ provider: "gateway" });
    const ctx = createMockCtx({ model: current, availableModels: [deepseekModel(), preferred] });
    assert.equal(candidateKey(getSearchCandidates(resolveResolutionContext(ctx))[0]), "gateway/gpt-6-luna");

    const fetchModel = googleModel({ provider: "gateway" });
    ctx.modelRegistry.getAvailable = () => [deepseekModel(), fetchModel];
    assert.equal(candidateKey(getFetchCandidates(resolveResolutionContext(ctx))[0]), "gateway/gemini-2.5-flash");

    // Explicit model-selection events must override a stale ctx.model too.
    const other = createModel({ provider: "other-gateway" });
    ctx.modelRegistry.getAvailable = () => [preferred, openaiResponsesModel({ provider: other.provider })];
    assert.equal(getSearchCandidates(resolveResolutionContext(ctx, other))[0].model.provider, other.provider);
  });
});

test("candidate discovery and its fingerprint share exactly one registry snapshot", async () => {
  await withTempCache(() => {
    const models = [deepseekModel(), openaiResponsesModel()];
    const expected = fingerprintAvailableModels(createMockCtx({ availableModels: models }));
    const ctx = createMockCtx();
    let reads = 0;
    ctx.modelRegistry.getAvailable = () => ++reads === 1 ? models : [googleModel()];
    const resolution = resolveResolutionContext(ctx);
    assert.equal(reads, 1);
    assert.equal(resolution.fingerprint, expected);
    assert.deepEqual(resolution.available.map(candidateKey), models.map(candidateKey));
  });
});

test("invalid timeout overrides cannot throw or overflow into a one-millisecond timer", async (t) => {
  const timeouts = [];
  const originalSearch = ADAPTERS.openai.search;
  t.mock.method(AbortSignal, "timeout", ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  ADAPTERS.openai.search = async () => ({ results: [] });
  try {
    for (const value of ["0.5", "1.5", "2147483648", "4294967295", "4294967296", "9007199254740991", "NaN", "Infinity", "-1", "0"]) {
      await withEnv({ PI_BETTER_WEB_SEARCH_TIMEOUT_MS: value }, () => withTempCache(async () => {
        const result = await runWebSearch({ query: "test" }, createMockCtx({ model: openaiResponsesModel() }));
        assert.equal(result.isError, undefined);
        assert.equal(timeouts.pop(), DEFAULT_ATTEMPT_TIMEOUT_MS, value);
      }));
    }
  } finally {
    ADAPTERS.openai.search = originalSearch;
  }
});

test("an adapter that aborts before returning does not leave an unhandled rejection", async () => {
  await withTempCache(async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled by user", "AbortError");
    const original = ADAPTERS.openai.search;
    ADAPTERS.openai.search = async () => {
      controller.abort(reason);
      throw reason;
    };
    try {
      await assert.rejects(
        () => runWebSearch({ query: "test" }, createMockCtx({ model: openaiResponsesModel() }), controller.signal),
        error => error === reason,
      );
      // Let any detached rejection surface in Node's test runner.
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      ADAPTERS.openai.search = original;
    }
  });
});

for (const [family, makeModel, fallbackFamily, makeFallback] of [
  ["deepseek", deepseekModel, "ollama", ollamaCloudModel],
  ["ollama", ollamaCloudModel, "deepseek", deepseekModel],
]) {
  test(`${family} preserves successful URLs after a later global HTTP failure`, async (t) => {
    await withTempCache(async () => {
      const first = "https://example.com/first";
      const second = "https://example.com/second";
      const third = "https://example.com/third";
      const requests = [];
      let primaryCalls = 0;
      t.mock.method(globalThis, "fetch", async (url, init) => {
        const requested = JSON.parse(init.body).url;
        const primary = family === "deepseek" ? String(url).includes("deepseek") : String(url).includes("ollama");
        requests.push({ family: primary ? family : fallbackFamily, url: requested });
        if (primary && ++primaryCalls === 2) {
          return new Response(JSON.stringify({ error: { message: "service unavailable" } }), { status: 503 });
        }
        return new Response(JSON.stringify({ content: primary ? "original data" : "fallback data" }));
      });
      const model = makeModel();
      const result = await runWebSearch({ urls: [first, second, third] }, createMockCtx({ model, availableModels: [model, makeFallback()] }));
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests, [
        { family, url: first }, { family, url: second },
        { family: fallbackFamily, url: second }, { family: fallbackFamily, url: third },
      ]);
      assert.deepEqual(JSON.parse(result.content[0].text).fetched[0], { url: first, data: { content: "original data" } });
      assert.equal(result.details.fetchedCount, 3);
      assert.equal(result.details.attempts.length, 1);
      assert.match(result.details.attempts[0].message, /503/);
    });
  });
}

test("collapsed results disclose unsuccessful URLs without changing raw output", async (t) => {
  await withTempCache(async () => {
    const model = deepseekModel();
    t.mock.method(globalThis, "fetch", async (_url, init) => new Response(JSON.stringify(
      JSON.parse(init.body).url.endsWith("missing") ? { error: "missing" } : { content: "page" },
    ), { status: JSON.parse(init.body).url.endsWith("missing") ? 404 : 200 }));
    const result = await runWebSearch({ urls: ["https://example.com/ok", "https://example.com/missing", "ftp://example.com/invalid"] }, createMockCtx({ model, availableModels: [model] }));
    assert.equal(result.isError, undefined);
    assert.equal(result.details.fetchedCount, 1);
    assert.equal(result.details.fetchFailedCount, 2);
    assert.match(render(result), /2 URLs failed/);
    assert.equal(JSON.parse(result.content[0].text).fetched.length, 3);
  });
});

test("collapsed results disclose output truncation", () => {
  const result = { content: [{ type: "text", text: "{}\n[truncated]" }], details: { attempts: [], routes: [{ phase: "search", provider: "openai", model: "gpt-6-luna" }], truncated: true } };
  assert.match(render(result), /truncated/i);
});
