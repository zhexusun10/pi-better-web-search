import assert from "node:assert/strict";
import test from "node:test";

import { deepseekModel, openaiResponsesModel, withEnv } from "./helpers.mjs";
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

  // Failures from requests already in flight do not lengthen this cooldown.
  recordProviderFailure("search", "openai", "still timing out", 2_000);
  assert.equal(getProviderFailure("search", "openai")?.consecutiveFailures, 1);
  assert.equal(getProviderFailure("search", "openai")?.retryAt, 61_000);
  assert.equal(isProviderCoolingDown("search", "openai", 61_000), false);

  // A slow request that started before cooldown still belongs to the same
  // outage even if it completes after the cooldown expires.
  recordProviderFailure("search", "openai", "slow failure", 70_000, 500);
  assert.equal(getProviderFailure("search", "openai")?.consecutiveFailures, 1);
  assert.equal(getProviderFailure("search", "openai")?.retryAt, 61_000);

  // A failed probe after expiry doubles the next cooldown.
  recordProviderFailure("search", "openai", "probe failed", 71_000);
  assert.equal(getProviderFailure("search", "openai")?.consecutiveFailures, 2);
  assert.equal(getProviderFailure("search", "openai")?.retryAt, 191_000);
  assert.equal(isProviderCoolingDown("search", "openai", 190_999), true);
  assert.equal(isProviderCoolingDown("search", "openai", 191_000), false);

  clearProviderFailure("search", "openai");
  assert.equal(isProviderCoolingDown("search", "openai", 61_000), false);
  assert.deepEqual(
    prioritizeCandidates("search", [openai, deepseek], 2_000).map((candidate) => candidate.model.provider),
    ["openai", "deepseek"],
  );
  resetProviderFailures();
});

test("zero cooldown disables and clears health state", async () => {
  resetProviderFailures();
  recordProviderFailure("search", "openai", "failure", 1_000);
  await withEnv({ PI_BETTER_WEB_SEARCH_FAILURE_COOLDOWN_MS: "0" }, async () => {
    assert.equal(isProviderCoolingDown("search", "openai", 2_000), false);
    recordProviderFailure("search", "openai", "failure", 2_000);
    assert.equal(getProviderFailure("search", "openai"), undefined);
    assert.equal(isProviderCoolingDown("search", "openai", 2_000), false);
  });
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
