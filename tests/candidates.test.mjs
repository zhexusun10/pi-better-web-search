import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicModel,
  createMockCtx,
  createModel,
  deepseekModel,
  googleModel,
  ollamaCloudModel,
  openaiResponsesModel,
  unsupportedLocalModel,
  withEnv,
  withTempCache,
} from "./helpers.mjs";

import { fingerprintAvailableModels, writeCache } from "../src/cache.ts";
import {
  FETCH_ATTEMPT_CAP,
  SEARCH_ATTEMPT_CAP,
  candidateKey,
  describeCandidate,
  getFetchCandidates,
  getSearchCandidates,
  hasExposedCandidate,
  hasUrlCandidate,
  resolveResolutionContext,
} from "../src/candidates.ts";

function ctxFor(model, availableModels, extra = {}) {
  return createMockCtx({ model, availableModels, ...extra });
}

async function withResolution(ctx, model, fn) {
  return withTempCache(async () => {
    const resolution = resolveResolutionContext(ctx, model);
    return fn(resolution);
  });
}

test("candidate keys and descriptions are stable", () => {
  const ctx = createMockCtx({ availableModels: [deepseekModel()] });
  const resolution = resolveResolutionContext(ctx);
  const candidate = resolution.available[0];
  assert.equal(candidateKey(candidate), "deepseek/deepseek-chat");
  assert.match(describeCandidate(candidate), /deepseek\/deepseek-chat/);
  assert.match(describeCandidate(candidate), /deepseek/);
});

test("current supported search model comes first, followed by a fresh cached preference", async () => {
  const current = openaiResponsesModel();
  const deepseek = deepseekModel();
  const anthropic = anthropicModel();
  const ctx = ctxFor(current, [deepseek, anthropic]);
  const fingerprint = fingerprintAvailableModels(ctx);

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint,
      search: { provider: "deepseek", model: "deepseek-chat" },
    });
    const resolution = resolveResolutionContext(ctx);
    assert.equal(resolution.fresh, false);
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["openai/gpt-5.1", "deepseek/deepseek-chat", "anthropic/claude-sonnet-4-5"],
    );
  });
});

test("a cached preference is first when the current model cannot search", async () => {
  const current = unsupportedLocalModel();
  const deepseek = deepseekModel();
  const anthropic = anthropicModel();
  const ctx = ctxFor(current, [anthropic, deepseek]);
  const fingerprint = fingerprintAvailableModels(ctx);

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint,
      search: { provider: "deepseek", model: "deepseek-chat" },
    });
    const resolution = resolveResolutionContext(ctx);
    assert.equal(hasExposedCandidate(resolution), true);
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4-5"],
    );
  });
});

test("stale fingerprints invalidate cached refs but keep deterministic discovery", async () => {
  const current = unsupportedLocalModel();
  const deepseek = deepseekModel();
  const google = googleModel();
  const ctx = ctxFor(current, [google, deepseek]);

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint: "stale",
      search: { provider: "google", model: "gemini-2.5-flash" },
      fetch: { provider: "google", model: "gemini-2.5-flash" },
    });
    const resolution = resolveResolutionContext(ctx);
    assert.equal(resolution.fresh, true);
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
    );
  });
});

test("cached refs resolve to another available model from the same provider", async () => {
  const current = unsupportedLocalModel();
  const replacement = deepseekModel({ id: "deepseek-reasoner" });
  const ctx = ctxFor(current, [replacement]);
  const fingerprint = fingerprintAvailableModels(ctx);

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint,
      search: { provider: "deepseek", model: "deepseek-chat" },
    });
    const resolution = resolveResolutionContext(ctx);
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-reasoner"],
    );
  });
});

test("a cached model from the current provider is not retried", async () => {
  const current = deepseekModel({ id: "deepseek-chat" });
  const replacement = deepseekModel({ id: "deepseek-reasoner" });
  const fallback = openaiResponsesModel();
  const ctx = ctxFor(current, [replacement, fallback]);
  const fingerprint = fingerprintAvailableModels(ctx);

  await withTempCache(async () => {
    writeCache({
      version: 1,
      fingerprint,
      search: { provider: "deepseek", model: "deepseek-reasoner" },
    });
    const resolution = resolveResolutionContext(ctx);
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-chat", "openai/gpt-5.1"],
    );
  });
});

test("url-incapable candidates are filtered from fetch ordering", async () => {
  const current = openaiResponsesModel();
  const openai = openaiResponsesModel({ id: "gpt-4o" });
  const google = googleModel();
  const deepseek = deepseekModel();
  const ctx = ctxFor(current, [openai, google, deepseek]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getFetchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
    );
  });
});

test("search and fetch candidate lists are deterministic and enforce caps", async () => {
  const current = unsupportedLocalModel();
  const models = Array.from({ length: 20 }, (_, index) =>
    openaiResponsesModel({ id: `gpt-5-${index}`, provider: `openai-${index}` }),
  ).reverse();

  await withResolution(ctxFor(current, models), undefined, (resolution) => {
    const search = getSearchCandidates(resolution);
    assert.equal(search.length, SEARCH_ATTEMPT_CAP);
    assert.equal(candidateKey(search[0]), "openai-0/gpt-5-0");
    assert.equal(new Set(search.map((entry) => entry.model.provider)).size, search.length);
  });

  const urlModels = [
    deepseekModel(),
    ollamaCloudModel({ provider: "ollama-a" }),
    ollamaCloudModel({ provider: "ollama-b" }),
    ollamaCloudModel({ provider: "ollama-c" }),
    googleModel({ provider: "google-a" }),
    googleModel({ provider: "google-b" }),
    googleModel({ provider: "google-c" }),
    googleModel({ provider: "google-d" }),
  ];
  await withResolution(ctxFor(current, urlModels), undefined, (resolution) => {
    const fetchCandidates = getFetchCandidates(resolution);
    assert.equal(fetchCandidates.length, FETCH_ATTEMPT_CAP);
    assert.deepEqual(
      fetchCandidates.slice(0, 3).map(candidateKey),
      ["deepseek/deepseek-chat", "ollama-a/gpt-oss:120b", "google-a/gemini-2.5-flash"],
    );
    assert.equal(
      new Set(fetchCandidates.map((entry) => entry.model.provider)).size,
      fetchCandidates.length,
    );
  });
});

test("hasUrlCandidate only trusts an unavailable current model with auth", async () => {
  await withEnv(
    {
      DEEPSEEK_API_KEY: undefined,
      OLLAMA_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      XAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      LMSTUDIO_API_KEY: undefined,
    },
    async () => {
      const unauthenticated = ctxFor(deepseekModel(), [], { hasConfiguredAuth: false });
      await withResolution(unauthenticated, undefined, (resolution) => {
        assert.equal(hasUrlCandidate(resolution), false);
      });

      const authenticated = ctxFor(deepseekModel(), [], { hasConfiguredAuth: true });
      await withResolution(authenticated, undefined, (resolution) => {
        assert.equal(hasUrlCandidate(resolution), true);
      });

      const withAvailable = ctxFor(unsupportedLocalModel(), [googleModel()]);
      await withResolution(withAvailable, undefined, (resolution) => {
        assert.equal(hasUrlCandidate(resolution), true);
      });

      const openaiOnly = ctxFor(openaiResponsesModel(), [openaiResponsesModel()]);
      await withResolution(openaiOnly, undefined, (resolution) => {
        assert.equal(hasUrlCandidate(resolution), false);
      });
    },
  );
});

test("models are deduped by provider/model and unsupported families are ignored", async () => {
  const current = createModel({
    id: "local",
    provider: "lmstudio",
    api: "openai-completions",
  });
  const deepseek = deepseekModel();
  const duplicate = deepseekModel();
  const ctx = ctxFor(current, [deepseek, duplicate, unsupportedLocalModel()]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.equal(resolution.current, undefined);
    assert.deepEqual(resolution.available.map(candidateKey), ["deepseek/deepseek-chat"]);
  });
});
