import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import piBetterWebSearch from "../extensions/index.ts";
import { fingerprintAvailableModels, readCache, writeCache } from "../lib/cache.ts";
import { candidateKey, getFetchCandidates, getSearchCandidates, getSelectableProviders, resolveResolutionContext } from "../lib/candidates.ts";
import { clearProviderFailure } from "../lib/health.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { PROVIDER_COMMAND_NAME } from "../lib/provider-command.ts";
import { ADAPTERS } from "../lib/providers/index.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, createMockPi, deepseekModel, googleModel, ollamaCloudModel, openaiResponsesModel, unsupportedLocalModel, withEnv, withTempCache } from "./helpers.mjs";

function commandUI(ctx, choose) {
  const pi = createMockPi();
  piBetterWebSearch(pi);
  const dialogs = [];
  const notifications = [];
  ctx.hasUI = true;
  ctx.ui.select = async (title, options) => {
    dialogs.push({ title, options });
    return choose(title, options);
  };
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  return { command: pi.commands.get(PROVIDER_COMMAND_NAME), dialogs, notifications, pi };
}

const providerOption = (options, provider) => options.find(option => {
  const target = option.replace(/^(?:Search|Fetch): /, "");
  return target.startsWith(`${provider}/`) || target.startsWith(`${provider} API `);
});

test("settings are separate from the success cache, whitelist fields, and tolerate invalid files", async () => {
  await withTempCache(({ path, directory }) => {
    assert.deepEqual(readProviderPreferences(), { version: 1 });
    const settings = { version: 1, search: "openai", fetch: "google", apiKey: "must-not-leak", model: "ignored" };
    assert.equal(writeProviderPreferences(settings), true);
    assert.deepEqual(readProviderPreferences(), { version: 1, search: "openai", fetch: "google" });
    assert.doesNotMatch(readFileSync(getPreferencesPath(), "utf8"), /must-not-leak|ignored/);
    assert.equal(existsSync(path), false);
    for (const invalid of ["{", "null", "[]", '{"version":2}', '{"version":1,"search":42}', '{"version":1,"fetch":"  "}']) {
      writeFileSync(getPreferencesPath(), invalid);
      assert.deepEqual(readProviderPreferences(), { version: 1 });
    }
    return withEnv({ PI_BETTER_WEB_SEARCH_SETTINGS: directory }, () => {
      assert.deepEqual(readProviderPreferences(), { version: 1 });
      assert.equal(writeProviderPreferences(settings), false);
    });
  });
});

test("terminal command chooses search and fetch independently and shows native endpoints", async () => {
  await withTempCache(() => {
    const current = deepseekModel();
    const ctx = createMockCtx({ model: current, availableModels: [current, openaiResponsesModel(), googleModel()] });
    let phase = "Web Search";
    let provider = "openai";
    const ui = commandUI(ctx, (_title, options) => options.find(option => option.startsWith(`${phase} — `)) ?? providerOption(options, provider));
    assert.equal(ui.pi.commands.size, 3);
    assert.equal(ui.pi.tools.size, 1);
    return (async () => {
      await ui.command.handler("", ctx);
      assert.deepEqual(readProviderPreferences(), { version: 1, search: "openai" });
      assert.match(ui.dialogs[1].title, /fallback enabled/);
      assert.ok(ui.dialogs[1].options.includes("Search: deepseek API /v1/tools/search"));
      phase = "URL Fetch";
      provider = "google";
      await ui.command.handler("", ctx);
      assert.deepEqual(readProviderPreferences(), { version: 1, search: "openai", fetch: "google" });
      const fetchOptions = ui.dialogs[3].options;
      assert.equal(providerOption(fetchOptions, "openai"), undefined);
      assert.ok(fetchOptions.includes("Fetch: deepseek API /v1/tools/fetch"));
      assert.match(ui.notifications.at(-1).message, /Automatic fallback remains enabled/);
      // A new extension instance reads the saved choice; no process-local pin.
      const reloaded = commandUI(ctx, () => undefined);
      await reloaded.command.handler("search", ctx);
      assert.match(reloaded.dialogs[0].title, /openai/);
      assert.match(providerOption(reloaded.dialogs[0].options, "openai"), /\(selected\)/);
    })();
  });
});

test("Auto resets only the selected phase; cancelling either menu leaves settings unchanged", async () => {
  await withTempCache(async () => {
    const ctx = createMockCtx({ availableModels: [deepseekModel()] });
    let pick = (_title, options) => options[0];
    const ui = commandUI(ctx, (...args) => pick(...args));
    writeProviderPreferences({ version: 1, search: "deepseek", fetch: "deepseek" });
    await ui.command.handler("search", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1, fetch: "deepseek" });
    const before = readFileSync(getPreferencesPath(), "utf8");
    pick = () => undefined;
    await ui.command.handler("", ctx);
    await ui.command.handler("fetch", ctx);
    pick = (_title, options) => options.find(option => option.startsWith("URL Fetch — "));
    await ui.command.handler("", ctx);
    assert.equal(readFileSync(getPreferencesPath(), "utf8"), before);
  });
});

test("unavailable preferences stay visible and can be cleared even without any providers", async () => {
  await withTempCache(async () => {
    writeProviderPreferences({ version: 1, fetch: "removed-provider" });
    const ctx = createMockCtx({ model: unsupportedLocalModel() });
    const ui = commandUI(ctx, (_title, options) => options[0]);
    await ui.command.handler("fetch", ctx);
    assert.match(ui.dialogs[0].title, /removed-provider \(unavailable\)/);
    assert.equal(ui.dialogs[0].options.length, 1);
    assert.equal(ui.notifications[0].level, "warning");
    assert.deepEqual(readProviderPreferences(), { version: 1 });
  });
});

test("invalid arguments, noninteractive mode, and persistence failures do not claim success", async () => {
  await withTempCache(async ({ directory }) => {
    const ctx = createMockCtx({ availableModels: [deepseekModel()] });
    const ui = commandUI(ctx, (_title, options) => options[0]);
    await ui.command.handler("invalid", ctx);
    assert.match(ui.notifications.at(-1).message, /Usage:/);
    ctx.hasUI = false;
    await ui.command.handler("search", ctx);
    assert.match(ui.notifications.at(-1).message, /interactive UI/);
    assert.equal(ui.dialogs.length, 0);
    ctx.hasUI = true;
    await withEnv({ PI_BETTER_WEB_SEARCH_SETTINGS: directory }, () => ui.command.handler("search", ctx));
    assert.equal(ui.notifications.at(-1).level, "error");
    assert.match(ui.notifications.at(-1).message, /Could not save/);
  });
});

test("provider menus include all authenticated eligible providers without duplicates or attempt caps", async () => {
  await withTempCache(() => {
    const models = Array.from({ length: 15 }, (_, index) => googleModel({ provider: `google-${index}` }));
    const ctx = createMockCtx({
      model: googleModel({ provider: "unauthenticated-current" }),
      availableModels: [...models, models[0], googleModel({ provider: models[0].provider, id: "gemini-3-flash" }),
        googleModel({ provider: "large-only", id: "gemini-9-pro" }), unsupportedLocalModel()],
      hasConfiguredAuth: false,
    });
    return withEnv({ GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined }, () => {
      for (const phase of ["search", "fetch"]) {
        const choices = getSelectableProviders(resolveResolutionContext(ctx), phase);
        assert.equal(choices.length, 15);
        assert.equal(new Set(choices.map(choice => choice.model.provider)).size, 15);
        assert.equal(choices.find(choice => choice.model.provider === models[0].provider).model.id, "gemini-3-flash");
      }
    });
  });
});

test("explicit choices outrank current and cached providers, reselect newest models, and survive fingerprint changes", async () => {
  await withTempCache(() => {
    const current = deepseekModel();
    const models = [current, openaiResponsesModel(), openaiResponsesModel({ id: "gpt-6.1-luna" }),
      googleModel(), googleModel({ id: "gemini-3-flash" }), ollamaCloudModel()];
    const ctx = createMockCtx({ model: current, availableModels: models });
    writeProviderPreferences({ version: 1, search: "openai", fetch: "google" });
    for (const fingerprint of [fingerprintAvailableModels(ctx), "stale"]) {
      writeCache({ version: 1, fingerprint, search: { provider: "ollama-cloud", model: "old" }, fetch: { provider: "ollama-cloud", model: "old" } });
      const resolution = resolveResolutionContext(ctx);
      const search = getSearchCandidates(resolution).map(candidateKey);
      const fetch = getFetchCandidates(resolution).map(candidateKey);
      assert.equal(search[0], "openai/gpt-6.1-luna");
      assert.equal(fetch[0], "google/gemini-3-flash");
      assert.equal(search[1], "deepseek/deepseek-v4-flash");
      assert.equal(fetch[1], "deepseek/deepseek-v4-flash");
      assert.ok(search.includes("ollama-cloud/qwen-4-flash"));
      assert.ok(fetch.includes("ollama-cloud/qwen-4-flash"));
      assert.ok(search.includes("openai/gpt-6-luna"));
      assert.ok(fetch.includes("google/gemini-2.5-flash"));
    }
  });
});

test("missing, unsupported, non-light, and URL-incapable preferences do not disable fallback", async () => {
  await withTempCache(() => {
    const ctx = createMockCtx({ availableModels: [deepseekModel(), openaiResponsesModel(),
      googleModel({ provider: "large-only", id: "gemini-9-pro" }), unsupportedLocalModel()] });
    for (const provider of ["removed", "large-only", "lmstudio"]) {
      writeProviderPreferences({ version: 1, search: provider, fetch: provider });
      const resolution = resolveResolutionContext(ctx);
      assert.equal(getSearchCandidates(resolution)[0].model.provider, "deepseek");
      assert.equal(getFetchCandidates(resolution)[0].model.provider, "deepseek");
      assert.deepEqual(readProviderPreferences(), { version: 1, search: provider, fetch: provider });
    }
    writeProviderPreferences({ version: 1, fetch: "openai" });
    assert.deepEqual(getFetchCandidates(resolveResolutionContext(ctx)).map(candidateKey), ["deepseek/deepseek-v4-flash"]);
  });
});

test("terminal selections actually route search and fetch to independent preferred providers", async (t) => {
  await withTempCache(async () => {
    const current = deepseekModel();
    const ctx = createMockCtx({ model: current, availableModels: [current, openaiResponsesModel(), googleModel()] });
    let provider = "openai";
    const ui = commandUI(ctx, (_title, options) => providerOption(options, provider));
    await ui.command.handler("search", ctx);
    provider = "google";
    await ui.command.handler("fetch", ctx);
    assert.deepEqual(readProviderPreferences(), { version: 1, search: "openai", fetch: "google" });
    t.mock.method(ADAPTERS.deepseek, "search", async () => assert.fail("must prefer the selected search provider"));
    t.mock.method(ADAPTERS.deepseek, "fetch", async () => assert.fail("must prefer the selected fetch provider"));
    const calls = [];
    t.mock.method(ADAPTERS.openai, "search", async (_ctx, model) => {
      calls.push(["search", model.provider]);
      return { results: [{ title: "raw" }] };
    });
    t.mock.method(ADAPTERS.google, "fetch", async (_ctx, model, urls) => {
      calls.push(["fetch", model.provider]);
      return { entries: urls.map(url => ({ url, data: { content: "raw page" } })) };
    });
    const result = await ui.pi.tools.get("web_search").execute("call", { query: "test", urls: ["https://example.com/"] }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [["search", "openai"], ["fetch", "google"]]);
    assert.deepEqual(result.details.attempts, []);
    assert.equal(readCache().search.provider, "openai");
    assert.equal(readCache().fetch.provider, "google");
  });
});

test("selected providers retry despite cooldown, preserve successful URLs, and are not overwritten by cache", async (t) => {
  await withTempCache(async () => {
    const current = deepseekModel();
    const ctx = createMockCtx({ model: current, availableModels: [current, openaiResponsesModel(), googleModel()] });
    const preferences = { version: 1, search: "openai", fetch: "google" };
    writeProviderPreferences(preferences);
    const urls = ["https://example.com/first", "https://example.com/second"];
    const calls = [];
    let fail = true;
    t.mock.method(ADAPTERS.openai, "search", async () => {
      calls.push("openai search");
      if (fail) throw new Error("HTTP 401 Unauthorized");
      return { results: [] };
    });
    t.mock.method(ADAPTERS.deepseek, "search", async () => {
      calls.push("deepseek search");
      return { results: [] };
    });
    t.mock.method(ADAPTERS.google, "fetch", async (_ctx, _model, requested) => {
      calls.push(["google fetch", requested]);
      if (fail) return { entries: [{ url: requested[0], data: { content: "original" } }], providerError: "HTTP 503 Unavailable" };
      return { entries: requested.map(url => ({ url, data: {} })) };
    });
    t.mock.method(ADAPTERS.deepseek, "fetch", async (_ctx, _model, requested) => {
      calls.push(["deepseek fetch", requested]);
      return { entries: requested.map(url => ({ url, data: { content: "fallback" } })) };
    });
    const result = await runWebSearch({ query: "test", urls }, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ["openai search", "deepseek search", ["google fetch", urls], ["deepseek fetch", [urls[1]]]]);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.fetched[0].data.content, "original");
    assert.equal(output.fetched[1].data.content, "fallback");
    assert.deepEqual(result.details.attempts.map(attempt => [attempt.phase, attempt.provider]), [["search", "openai"], ["fetch", "google"]]);
    assert.equal(readCache().search.provider, "deepseek");
    assert.deepEqual(readProviderPreferences(), preferences);

    calls.length = 0;
    await runWebSearch({ query: "test", urls }, ctx);
    assert.deepEqual(calls, ["openai search", "deepseek search", ["google fetch", urls], ["deepseek fetch", [urls[1]]]]);
    assert.deepEqual(readProviderPreferences(), preferences);

    // Recovery restores the explicit choices, not the most recent fallback.
    clearProviderFailure("search", "openai");
    clearProviderFailure("fetch", "google");
    fail = false;
    calls.length = 0;
    await runWebSearch({ query: "test", urls }, ctx);
    assert.deepEqual(calls, ["openai search", ["google fetch", urls]]);
  });
});
