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

import { fingerprintAvailableModels, writeCache } from "../lib/cache.ts";
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
} from "../lib/candidates.ts";

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

test("modern models rank before legacy ones within a family", async () => {
  const legacy = openaiResponsesModel({ id: "gpt-4.1" });
  const modern = openaiResponsesModel({ id: "gpt-5.1" });
  const ctx = ctxFor(unsupportedLocalModel(), [legacy, modern]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["openai/gpt-5.1", "openai/gpt-4.1"],
    );
  });
});

test("higher version numbers rank first within the same tier", async () => {
  const older = openaiResponsesModel({ id: "gpt-6.1-luna" });
  const newer = openaiResponsesModel({ id: "gpt-7.0-luna" });
  const ctx = ctxFor(unsupportedLocalModel(), [older, newer]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["openai/gpt-7.0-luna", "openai/gpt-6.1-luna"],
    );
  });
});

test("OpenAI tiers rank luna before sol before astra", async () => {
  const astra = openaiResponsesModel({ id: "gpt-6.1-astra" });
  const sol = openaiResponsesModel({ id: "gpt-6.1-sol" });
  const luna = openaiResponsesModel({ id: "gpt-6.1-luna" });
  const ctx = ctxFor(unsupportedLocalModel(), [astra, sol, luna]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["openai/gpt-6.1-luna", "openai/gpt-6.1-sol", "openai/gpt-6.1-astra"],
    );
  });
});

test("Claude tiers rank haiku before sonnet before opus before fable", async () => {
  const fable = anthropicModel({ id: "claude-fable-6-0" });
  const opus = anthropicModel({ id: "claude-opus-5-5" });
  const sonnet = anthropicModel({ id: "claude-sonnet-5-5" });
  const haiku = anthropicModel({ id: "claude-haiku-5-5" });
  const ctx = ctxFor(unsupportedLocalModel(), [fable, opus, sonnet, haiku]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      [
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-fable-6-0",
      ],
    );
  });
});

test("a family contributes alternate models only after every family primary", async () => {
  const current = unsupportedLocalModel();
  const openaiLegacy = openaiResponsesModel({ id: "gpt-4.1" });
  const openaiModern = openaiResponsesModel({ id: "gpt-5.1" });
  const deepseek = deepseekModel();
  const ctx = ctxFor(current, [openaiLegacy, openaiModern, deepseek]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-chat", "openai/gpt-5.1", "openai/gpt-4.1"],
    );
  });
});

test("the current model's provider id is not retried with a different model", async () => {
  const current = deepseekModel({ id: "deepseek-chat" });
  const sibling = deepseekModel({ id: "deepseek-reasoner" });
  const openai = openaiResponsesModel();
  const ctx = ctxFor(current, [sibling, openai]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["deepseek/deepseek-chat", "openai/gpt-5.1"],
    );
  });
});

test("a different provider id in the current model's family is still tried", async () => {
  const current = anthropicModel({ id: "claude-opus-5-5", provider: "zicc-anthropic" });
  const other = anthropicModel({ id: "claude-haiku-5-5", provider: "opencode-go" });
  const ctx = ctxFor(current, [other]);

  await withResolution(ctx, undefined, (resolution) => {
    assert.deepEqual(
      getSearchCandidates(resolution).map(candidateKey),
      ["zicc-anthropic/claude-opus-5-5", "opencode-go/claude-haiku-5-5"],
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
    // Newer version numbers rank first, so `gpt-5-19` beats `gpt-5-0`.
    assert.equal(candidateKey(search[0]), "openai-19/gpt-5-19");
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
