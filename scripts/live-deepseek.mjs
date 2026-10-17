#!/usr/bin/env node
/**
 * Opt-in live test for the native DeepSeek Search/Fetch API.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... npm run test:live:deepseek
 *
 * Optional:
 *   PI_BWS_TEST_QUERY="DeepSeek V4 模型 发布"
 *   PI_BWS_TEST_URL="https://example.com"
 *
 * The key is read from the environment, never printed, and never written to the
 * repository. The preference cache is redirected to a temporary directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) {
  console.error("DEEPSEEK_API_KEY is required for the live DeepSeek test.");
  console.error("Example: DEEPSEEK_API_KEY=... npm run test:live:deepseek");
  process.exit(1);
}

const query = process.env.PI_BWS_TEST_QUERY?.trim() || "DeepSeek V4 模型 发布";
const url = process.env.PI_BWS_TEST_URL?.trim() || "https://example.com";
const cacheDir = mkdtempSync(join(tmpdir(), "pi-bws-live-deepseek-"));
process.env.PI_BETTER_WEB_SEARCH_CACHE = join(cacheDir, "cache.json");
process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS ||= "1000000";

const { deepseekAdapter } = await import("../lib/providers/deepseek.ts");
const { runWebSearch } = await import("../lib/search.ts");

const deepseek = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  provider: "deepseek",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  type: "chat",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  headers: {},
};
const local = {
  ...deepseek,
  id: "local-model",
  provider: "lmstudio",
  baseUrl: "http://127.0.0.1:1234/v1",
};

function makeCtx(current, available) {
  return {
    model: current,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: key };
      },
      getAvailable() {
        return available;
      },
      find(provider, model) {
        return available.find((candidate) => candidate.provider === provider && candidate.id === model);
      },
      hasConfiguredAuth(provider) {
        return available.some((candidate) => candidate.provider === provider);
      },
    },
    sessionManager: {
      getSessionId() {
        return "live-deepseek-test";
      },
    },
    cwd: root,
    ui: { notify() {}, setStatus() {} },
  };
}

function firstResult(result) {
  assert.ok(Array.isArray(result.results), "search results must be an array");
  assert.ok(result.results.length > 0, "search returned no results");
  const first = result.results[0];
  assert.equal(typeof first, "object");
  assert.equal(typeof first.title, "string");
  assert.equal(typeof first.url, "string");
  assert.ok(
    typeof first.summary === "string" || typeof first.content === "string",
    "result is missing summary/content",
  );
  return first;
}

try {
  console.log(`live DeepSeek query: ${query}`);

  const searchCtx = makeCtx(deepseek, [deepseek]);
  const search = await deepseekAdapter.search(searchCtx, deepseek, query);
  const first = firstResult(search);
  console.log(`  search: ${search.results.length} results; first="${first.title}" (${first.url})`);

  const fetched = await deepseekAdapter.fetch(searchCtx, deepseek, [url], undefined);
  assert.equal(fetched.entries.length, 1);
  assert.equal(fetched.entries[0].error, undefined);
  assert.equal(typeof fetched.entries[0].data?.title, "string");
  assert.equal(typeof fetched.entries[0].data?.content, "string");
  console.log(
    `  fetch: "${fetched.entries[0].data.title}" (${fetched.entries[0].data.content.length} chars)`,
  );

  // Exercise the real orchestration path: an unsupported current model with a
  // compatible authenticated provider must auto-switch to DeepSeek.
  const ctx = makeCtx(local, [deepseek]);
  const result = await runWebSearch({ query, urls: [url] }, ctx);
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.search?.provider, "deepseek");
  assert.ok(Array.isArray(output.search?.results));
  assert.ok(output.search.results.length > 0);
  assert.equal(output.fetched?.length, 1);
  assert.equal(typeof output.fetched[0].data?.title, "string");
  console.log(
    `  runWebSearch: provider=${output.search.provider} model=${output.search.model} results=${output.search.results.length} fetched=${output.fetched.length}`,
  );

  console.log("PASS: live DeepSeek Search/Fetch and auto-switch orchestration.");
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
