import assert from "node:assert/strict";
import test from "node:test";

import { deepseekModel, openaiResponsesModel } from "./helpers.mjs";
import {
  clearProviderFailure,
  getProviderFailure,
  isModelCoolingDown,
  isProviderCoolingDown,
  prioritizeCandidates,
  recordModelFailure,
  recordProviderFailure,
  resetProviderFailures,
} from "../lib/health.ts";

test("provider-wide failures cool down and move behind healthy candidates", () => {
  resetProviderFailures();
  const openai = { model: openaiResponsesModel() };
  const deepseek = { model: deepseekModel() };

  recordProviderFailure("search", "openai", "The operation was aborted due to timeout", 1_000);
  assert.equal(isProviderCoolingDown("search", "openai", 2_000), true);
  assert.deepEqual(
    prioritizeCandidates("search", [openai, deepseek], 2_000).map((candidate) => candidate.model.provider),
    ["deepseek", "openai"],
  );

  // A second consecutive failure doubles the cooldown.
  recordProviderFailure("search", "openai", "still timing out", 2_000);
  assert.equal(getProviderFailure("search", "openai")?.consecutiveFailures, 2);
  assert.equal(getProviderFailure("search", "openai")?.retryAt, 122_000);
  assert.equal(isProviderCoolingDown("search", "openai", 61_000), true);
  assert.equal(isProviderCoolingDown("search", "openai", 122_000), false);

  clearProviderFailure("search", "openai");
  assert.equal(isProviderCoolingDown("search", "openai", 61_000), false);
  assert.deepEqual(
    prioritizeCandidates("search", [openai, deepseek], 2_000).map((candidate) => candidate.model.provider),
    ["openai", "deepseek"],
  );
  resetProviderFailures();
});

test("a model-specific failure is remembered without cooling down its whole provider", () => {
  resetProviderFailures();
  const failed = { model: openaiResponsesModel({ id: "gpt-5.6-luna" }) };
  const healthy = { model: openaiResponsesModel({ id: "gpt-6.1-terra" }) };

  recordModelFailure("search", "openai", "gpt-5.6-luna", "unsupported model", 1_000);
  assert.equal(isProviderCoolingDown("search", "openai", 2_000), false);
  assert.equal(isModelCoolingDown("search", "openai", "gpt-5.6-luna", 2_000), true);
  assert.deepEqual(
    prioritizeCandidates("search", [failed, healthy], 2_000).map((candidate) => candidate.model.id),
    ["gpt-6.1-terra", "gpt-5.6-luna"],
  );
  resetProviderFailures();
});
