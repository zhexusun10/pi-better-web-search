import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

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

async function withResolution(models, fn, current = unsupportedLocalModel()) {
  return withTempCache(() => fn(resolveResolutionContext(createMockCtx({
    model: current,
    availableModels: models,
  }))));
}

const searchKeys = (resolution) => getSearchCandidates(resolution).map(candidateKey);
const fetchKeys = (resolution) => getFetchCandidates(resolution).map(candidateKey);

test("candidate keys and descriptions are stable", async () => {
  await withResolution([deepseekModel()], (resolution) => {
    const candidate = resolution.available[0];
    assert.equal(candidateKey(candidate), "deepseek/deepseek-v4-flash");
    assert.equal(describeCandidate(candidate), "deepseek/deepseek-v4-flash (deepseek)");
  });
});

test("the current provider uses its newest light model, not the current model", async () => {
  const current = openaiResponsesModel({ id: "gpt-6-luna" });
  const newer = openaiResponsesModel({ id: "gpt-6.1-luna" });
  const large = openaiResponsesModel({ id: "gpt-9-sol" });
  await withResolution([current, newer, large, deepseekModel()], (resolution) => {
    assert.deepEqual(searchKeys(resolution), [
      "openai/gpt-6.1-luna", "deepseek/deepseek-v4-flash", "openai/gpt-6-luna",
    ]);
  }, current);
});

test("a non-light current model is only a provider hint and is never requested", async () => {
  const current = anthropicModel({ id: "claude-opus-9-0" });
  await withResolution([anthropicModel(), deepseekModel()], (resolution) => {
    assert.deepEqual(searchKeys(resolution), [
      "anthropic/claude-haiku-5-5", "deepseek/deepseek-v4-flash",
    ]);
  }, current);
});

test("no qualifying current-provider model falls back to other providers", async () => {
  await withResolution([deepseekModel()], (resolution) => {
    assert.deepEqual(searchKeys(resolution), ["deepseek/deepseek-v4-flash"]);
  }, openaiResponsesModel({ id: "gpt-9-sol" }));
});

test("cache remembers a provider but cannot pin an older or non-light model", async () => {
  for (const cachedId of ["claude-haiku-5-5", "claude-opus-9-0", "removed-model"]) {
    const models = [anthropicModel(), anthropicModel({ id: "claude-haiku-5-6" }), deepseekModel()];
    const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: models });
    await withTempCache(() => {
      writeCache({
        version: 1,
        fingerprint: fingerprintAvailableModels(ctx),
        search: { provider: "anthropic", model: cachedId },
      });
      assert.deepEqual(searchKeys(resolveResolutionContext(ctx)), [
        "anthropic/claude-haiku-5-6", "deepseek/deepseek-v4-flash", "anthropic/claude-haiku-5-5",
      ]);
    });
  }
});

test("cache cannot reintroduce a provider with only non-light models", async () => {
  const ctx = createMockCtx({ availableModels: [openaiResponsesModel({ id: "gpt-9-sol" }), deepseekModel()] });
  await withTempCache(() => {
    writeCache({ version: 1, fingerprint: fingerprintAvailableModels(ctx), search: { provider: "openai", model: "gpt-9-sol" } });
    assert.deepEqual(searchKeys(resolveResolutionContext(ctx)), ["deepseek/deepseek-v4-flash"]);
  });
});

test("stale fingerprints invalidate cached provider priority", async () => {
  await withResolution([googleModel(), deepseekModel()], (resolution) => {
    writeCache({ version: 1, fingerprint: "stale", search: { provider: "google", model: "gemini-2.5-flash" } });
    const refreshed = resolveResolutionContext(resolution.ctx);
    assert.equal(refreshed.fresh, true);
    assert.deepEqual(searchKeys(refreshed), ["deepseek/deepseek-v4-flash", "google/gemini-2.5-flash"]);
  });
});

test("OpenAI only admits luna, ordered by numeric version rather than price tier", async () => {
  const ids = ["gpt-9-astra", "gpt-8-sol", "gpt-7-terra", "gpt-6-luna", "gpt-6.1-luna", "gpt-6.10-luna", "gpt-6.2-luna"];
  await withResolution(ids.map(id => openaiResponsesModel({ id })), (resolution) => {
    assert.deepEqual(searchKeys(resolution), [
      "openai/gpt-6.10-luna", "openai/gpt-6.2-luna", "openai/gpt-6.1-luna", "openai/gpt-6-luna",
    ]);
  });
});

test("future major luna versions win without hardcoded catalog versions", async () => {
  await withResolution(["gpt-6.10-luna", "gpt-7-luna"].map(id => openaiResponsesModel({ id })), (resolution) => {
    assert.deepEqual(searchKeys(resolution), ["openai/gpt-7-luna", "openai/gpt-6.10-luna"]);
  });
});

test("Claude only admits haiku and compares dotted and dashed minor versions numerically", async () => {
  const ids = ["claude-opus-9-0", "claude-sonnet-8-0", "claude-fable-7-0", "claude-haiku-5.5", "claude-haiku-5.10", "claude-haiku-5-6"];
  await withResolution(ids.map(id => anthropicModel({ id })), (resolution) => {
    assert.deepEqual(searchKeys(resolution), [
      "anthropic/claude-haiku-5.10", "anthropic/claude-haiku-5-6", "anthropic/claude-haiku-5.5",
    ]);
  });
});

test("Claude date suffixes do not become minor versions", async () => {
  const ids = ["claude-haiku-5-20260514", "claude-haiku-5-6", "claude-haiku-5-5-20260929"];
  await withResolution(ids.map(id => anthropicModel({ id })), (resolution) => {
    assert.deepEqual(searchKeys(resolution), [
      "anthropic/claude-haiku-5-6", "anthropic/claude-haiku-5-5-20260929", "anthropic/claude-haiku-5-20260514",
    ]);
  });
});

test("DeepSeek and other brands require flash and choose the highest version", async () => {
  for (const [make, prefix, provider] of [
    [deepseekModel, "deepseek-v", "deepseek"],
    [googleModel, "gemini-", "google"],
    [ollamaCloudModel, "qwen-", "ollama-cloud"],
  ]) {
    const ids = [`${prefix}9-pro`, `${prefix}8`, `${prefix}4.1-flash`, `${prefix}4.10-flash`, `${prefix}4.2-flash`];
    await withResolution(ids.map(id => make({ id })), (resolution) => {
      assert.deepEqual(searchKeys(resolution), [
        `${provider}/${prefix}4.10-flash`, `${provider}/${prefix}4.2-flash`, `${provider}/${prefix}4.1-flash`,
      ]);
    });
  }
});

test("gateway model tiers and versions follow the brand, not the Responses API", async () => {
  const ids = [
    "deepseek-v5-pro", "deepseek-v4-flash", "deepseek-v4.1-flash",
    "gpt-9-sol", "gpt-6-luna", "gpt-6.1-luna",
    "claude-opus-9-0", "claude-haiku-5-5", "claude-haiku-5.10",
    "gemini-4-pro", "gemini-3.8-flash", "custom-v6.1-flash",
  ];
  await withResolution(ids.map(id => openaiResponsesModel({ id, provider: "gateway" })), (resolution) => {
    assert.deepEqual(getSearchCandidates(resolution, Infinity).map(candidateKey), [
      "gateway/deepseek-v4.1-flash", "gateway/deepseek-v4-flash",
      "gateway/gpt-6.1-luna", "gateway/gpt-6-luna",
      "gateway/claude-haiku-5.10", "gateway/claude-haiku-5-5",
      "gateway/gemini-3.8-flash", "gateway/custom-v6.1-flash",
    ]);
  });
});

test("namespaces are ignored and partial tier words are not accepted", async () => {
  const ids = ["openai/gpt-6.1-luna", "gpt-6luna", "gpt-99-lunatic", "claude-haikuplus-99", "other-99-flashy"];
  await withResolution(ids.map(id => openaiResponsesModel({ id })), (resolution) => {
    assert.deepEqual(searchKeys(resolution), ["openai/openai/gpt-6.1-luna", "openai/gpt-6luna"]);
  });
});

test("opencode-go completions models remain unsupported despite a flash name", async () => {
  const models = getBuiltinModels("opencode-go");
  const deepseek = models.filter(model => model.id.startsWith("deepseek-"));
  const gpt = models.find(model => model.id === "gpt-6-luna");
  assert.ok(deepseek.length > 0 && gpt);
  assert.ok(deepseek.every(model => model.api === "openai-completions"));
  await withResolution([...deepseek, gpt], (resolution) => {
    assert.deepEqual(searchKeys(resolution), ["opencode-go/gpt-6-luna"]);
  });
});

test("a family contributes older light models only after other family primaries", async () => {
  await withResolution([
    openaiResponsesModel({ id: "gpt-5-luna" }), openaiResponsesModel(), deepseekModel(),
  ], (resolution) => {
    assert.deepEqual(searchKeys(resolution), [
      "deepseek/deepseek-v4-flash", "openai/gpt-6-luna", "openai/gpt-5-luna",
    ]);
  });
});

test("different providers precede sibling models of an already represented provider", async () => {
  const models = Array.from({ length: 20 }, (_, index) => openaiResponsesModel({ id: `gpt-6.${index}-luna` }));
  const codex = openaiResponsesModel({ provider: "openai-codex", api: "openai-codex-responses" });
  await withResolution([...models, codex], (resolution) => {
    const candidates = getSearchCandidates(resolution);
    assert.equal(candidates.length, SEARCH_ATTEMPT_CAP);
    assert.equal(candidates[1].model.provider, "openai-codex");
  }, models[0]);
});

test("fetch also replaces the current and cached model with the newest flash", async () => {
  const current = googleModel({ id: "gemini-9-pro" });
  const old = googleModel();
  const latest = googleModel({ id: "gemini-3.8-flash" });
  await withResolution([old, latest, deepseekModel()], (resolution) => {
    writeCache({ version: 1, fingerprint: resolution.fingerprint, fetch: { provider: "google", model: old.id } });
    assert.deepEqual(fetchKeys(resolveResolutionContext(resolution.ctx)), [
      "google/gemini-3.8-flash", "deepseek/deepseek-v4-flash", "google/gemini-2.5-flash",
    ]);
  }, current);
});

test("cached fetch priority selects the newest flash even without a current provider", async () => {
  await withResolution([googleModel(), googleModel({ id: "gemini-3.8-flash" }), deepseekModel()], (resolution) => {
    writeCache({ version: 1, fingerprint: resolution.fingerprint, fetch: { provider: "google", model: "gemini-2.5-flash" } });
    assert.equal(fetchKeys(resolveResolutionContext(resolution.ctx))[0], "google/gemini-3.8-flash");
  });
});

test("url-incapable models are filtered from fetch ordering", async () => {
  await withResolution([openaiResponsesModel(), googleModel(), deepseekModel()], (resolution) => {
    assert.deepEqual(fetchKeys(resolution), ["deepseek/deepseek-v4-flash", "google/gemini-2.5-flash"]);
  }, openaiResponsesModel());
});

test("candidate ordering is deterministic and respects search and fetch caps", async () => {
  const models = Array.from({ length: 20 }, (_, index) =>
    openaiResponsesModel({ id: `gpt-6.${index}-luna`, provider: `openai-${index}` }),
  );
  await withResolution(models.reverse(), (resolution) => {
    const search = getSearchCandidates(resolution);
    assert.equal(search.length, SEARCH_ATTEMPT_CAP);
    assert.equal(candidateKey(search[0]), "openai-19/gpt-6.19-luna");
    assert.equal(new Set(search.map(entry => entry.model.provider)).size, search.length);
  });
  const urlModels = [deepseekModel(), ...["a", "b", "c"].map(suffix => ollamaCloudModel({ provider: `ollama-${suffix}` })),
    ...["a", "b", "c", "d"].map(suffix => googleModel({ provider: `google-${suffix}` }))];
  await withResolution(urlModels, (resolution) => {
    const fetch = getFetchCandidates(resolution);
    assert.equal(fetch.length, FETCH_ATTEMPT_CAP);
    assert.equal(new Set(fetch.map(entry => entry.model.provider)).size, fetch.length);
    assert.deepEqual(fetch.slice(0, 3).map(candidateKey), [
      "deepseek/deepseek-v4-flash", "ollama-a/qwen-4-flash", "google-a/gemini-2.5-flash",
    ]);
  });
});

test("no light models means no search exposure or URL exposure", async () => {
  const models = [openaiResponsesModel({ id: "gpt-9-sol" }), anthropicModel({ id: "claude-opus-9-0" }), googleModel({ id: "gemini-9-pro" })];
  await withResolution(models, (resolution) => {
    assert.deepEqual(searchKeys(resolution), []);
    assert.deepEqual(fetchKeys(resolution), []);
    assert.equal(hasExposedCandidate(resolution), false);
    assert.equal(hasUrlCandidate(resolution), false);
  }, models[0]);
});

test("hasUrlCandidate only trusts an unavailable current light model with auth", async () => {
  await withEnv({ DEEPSEEK_API_KEY: undefined }, async () => {
    await withTempCache(() => {
      for (const authenticated of [false, true]) {
        const ctx = createMockCtx({ model: deepseekModel(), hasConfiguredAuth: authenticated });
        assert.equal(hasUrlCandidate(resolveResolutionContext(ctx)), authenticated);
      }
      const large = googleModel({ id: "gemini-9-pro" });
      const ctx = createMockCtx({ model: large, hasConfiguredAuth: true });
      assert.equal(hasUrlCandidate(resolveResolutionContext(ctx)), false);
    });
  });
});

test("models are deduped by provider/model and unsupported families are ignored", async () => {
  const current = createModel({ id: "local", provider: "lmstudio", api: "openai-completions" });
  await withResolution([deepseekModel(), deepseekModel(), unsupportedLocalModel()], (resolution) => {
    assert.equal(resolution.current, undefined);
    assert.deepEqual(resolution.available.map(candidateKey), ["deepseek/deepseek-v4-flash"]);
  }, current);
});
