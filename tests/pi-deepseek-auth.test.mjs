import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createWebSearchToolManager } from "../extensions/index.ts";
import { getFetchCandidates, getSearchCandidates, getSelectableProviders, resolveResolutionContext } from "../lib/candidates.ts";
import { getCredentialsPath, saveApiKey } from "../lib/credentials.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { registerProviderCommand } from "../lib/provider-command.ts";
import { routeFor, describeRoute } from "../lib/routes.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, createMockPi, deepseekModel, openaiResponsesModel, unsupportedLocalModel, withEnv, withTempCache } from "./helpers.mjs";

const key = "unit-test-pi-deepseek-secret";
const page = "https://example.com/source";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function piContext({ models = [], baseUrl = "https://api.deepseek.com", configured = true, auth = { ok: true, apiKey: key } } = {}) {
  const ctx = createMockCtx({ model: unsupportedLocalModel(), availableModels: models, auth, hasConfiguredAuth: configured });
  ctx.modelRegistry.getProvider = provider => provider === "deepseek" ? { id: provider, baseUrl } : undefined;
  ctx.modelRegistry.getProviderAuthStatus = provider => ({ configured: provider === "deepseek" && configured });
  return ctx;
}

for (const source of ["pi-login", "models-json"]) {
  test(`real pi 1.5.2 registry reuses official DeepSeek ${source} credentials with an empty available chat snapshot`, async t => {
    await withTempCache(({ directory, path }) => withEnv({ PI_OFFLINE: "1" }, async () => {
      const credentials = new InMemoryCredentialStore();
      if (source === "pi-login") await credentials.modify("deepseek", async () => ({ type: "api_key", key }));
      const modelsPath = source === "models-json" ? join(directory, "models.json") : null;
      if (modelsPath) writeFileSync(modelsPath, JSON.stringify({ providers: { deepseek: { apiKey: key } } }));
      const runtime = await ModelRuntime.create({ credentials, modelsPath, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
      const registry = new ModelRegistry(runtime);
      assert.equal(registry.getProviderAuthStatus("deepseek").configured, true);
      const snapshot = t.mock.method(registry, "getAvailable", () => []);
      const ctx = createMockCtx({ model: unsupportedLocalModel() });
      ctx.modelRegistry = registry;
      const resolution = resolveResolutionContext(ctx);
      assert.equal(snapshot.mock.callCount(), 1);
      for (const phase of ["search", "fetch"]) {
        const choices = getSelectableProviders(resolution, phase);
        assert.equal(choices.length, 1);
        assert.equal(choices[0].model.provider, "deepseek");
        assert.equal(choices[0].nativeTools, true);
        assert.equal(describeRoute(routeFor(choices[0], phase)), `${phase === "fetch" ? "Fetch" : "Search"}: deepseek API /v1/tools/${phase}`);
      }
      const pi = createMockPi();
      const manager = createWebSearchToolManager(pi);
      assert.deepEqual(manager.sync(ctx), { expose: true, allowUrls: true });
      assert.ok(pi.tools.get("web_search").parameters.properties.urls);
      registerProviderCommand(pi);
      ctx.hasUI = true;
      ctx.ui.select = async (_title, choices) => choices.find(choice => choice.startsWith("Fetch: deepseek API"));
      await pi.commands.get("web-search-provider").handler("fetch", ctx);
      assert.equal(readProviderPreferences().fetch, "deepseek");
      const requests = [];
      t.mock.method(globalThis, "fetch", async (url, init) => {
        requests.push(String(url));
        assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${key}`);
        const body = JSON.parse(init.body);
        assert.equal("model" in body, false);
        if (String(url).endsWith("/search")) {
          assert.deepEqual(body, { query: "official docs", count: 10, need_content: true });
          return json({ results: [{ url: page, custom: "raw search data" }] });
        }
        assert.deepEqual(body, { url: page });
        return json({ title: "primary source", content: "raw fetched content" });
      });
      const result = await runWebSearch({ query: "official docs", urls: [page] }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests, ["https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch"]);
      const output = JSON.parse(result.content[0].text);
      assert.equal(output.search.results[0].custom, "raw search data");
      assert.equal(output.fetched[0].data.content, "raw fetched content");
      assert.equal(existsSync(getCredentialsPath()), false, "pi keys must never be copied into extension storage");
      assert.doesNotMatch(readFileSync(getPreferencesPath(), "utf8") + readFileSync(path, "utf8") + JSON.stringify(result), /unit-test-pi-deepseek-secret/);
      assert.deepEqual(await credentials.read("deepseek"), source === "pi-login" ? { type: "api_key", key } : undefined);
    }));
  });
}

test("pi DeepSeek tools need no flash model, and inference-only models remain excluded", async () => {
  await withTempCache(() => {
    for (const id of ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro"]) {
      const ctx = piContext({ models: [deepseekModel({ id }), openaiResponsesModel({ id: "gpt-9-sol" })] });
      const resolution = resolveResolutionContext(ctx);
      for (const phase of ["search", "fetch"]) {
        const choices = getSelectableProviders(resolution, phase);
        assert.equal(choices.length, 1);
        assert.equal(choices[0].model.id, "pi-search-fetch");
        assert.equal(choices[0].nativeTools, true);
      }
    }
  });
});

test("provider auth status still exposes DeepSeek when the current model and auth snapshot are stale", async () => {
  await withTempCache(() => {
    const ctx = piContext();
    ctx.model = deepseekModel();
    ctx.modelRegistry.hasConfiguredAuth = () => false;
    const resolution = resolveResolutionContext(ctx);
    const [choice] = getSelectableProviders(resolution, "fetch");
    assert.equal(choice.nativeTools, true);
    assert.deepEqual(createWebSearchToolManager(createMockPi()).sync(ctx), { expose: true, allowUrls: true });
  });
});

test("existing usable native DeepSeek models are not duplicated by provider-level discovery", async () => {
  await withTempCache(() => {
    const model = deepseekModel();
    const resolution = resolveResolutionContext(piContext({ models: [model] }));
    assert.equal(resolution.available.length, 1);
    assert.equal(getFetchCandidates(resolution)[0].model.id, model.id);
    assert.equal(getFetchCandidates(resolution)[0].nativeTools, undefined);
  });
});

test("pi DeepSeek discovery trusts no unconfigured catalog or third-party model name", async () => {
  await withTempCache(() => {
    const gateway = deepseekModel({ provider: "cline", api: "openai-completions" });
    for (const ctx of [piContext({ configured: false }), piContext({ configured: false, models: [gateway] })]) {
      const resolution = resolveResolutionContext(ctx);
      assert.deepEqual(getSelectableProviders(resolution, "search"), []);
      assert.deepEqual(getSelectableProviders(resolution, "fetch"), []);
    }
    const ctx = piContext();
    ctx.modelRegistry.getProviderAuthStatus = () => { throw new Error("unavailable registry"); };
    assert.deepEqual(getSelectableProviders(resolveResolutionContext(ctx), "fetch"), []);
  });
});

test("legacy pi registry auth can reuse a registered DeepSeek endpoint without the newer provider API", async () => {
  await withTempCache(() => {
    const ctx = piContext();
    delete ctx.modelRegistry.getProvider;
    delete ctx.modelRegistry.getProviderAuthStatus;
    ctx.modelRegistry.getAll = () => [deepseekModel({ id: "deepseek-chat", baseUrl: "https://proxy.test/deepseek/v1" })];
    const [candidate] = getFetchCandidates(resolveResolutionContext(ctx));
    assert.equal(candidate.nativeTools, true);
    assert.equal(candidate.model.baseUrl, "https://proxy.test/deepseek/v1");
  });
});

test("pi DeepSeek requests preserve provider proxy origins and request-time auth overrides", async t => {
  await withTempCache(async () => {
    const ctx = piContext({
      baseUrl: "https://proxy.test/deepseek/anthropic",
      auth: { ok: true, apiKey: key, baseUrl: "https://auth-proxy.test/prefix/v1", headers: { "X-Proxy-Route": "deepseek" } },
    });
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://auth-proxy.test/prefix/v1/tools/fetch");
      assert.equal(new Headers(init.headers).get("X-Proxy-Route"), "deepseek");
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${key}`);
      return json({ content: "proxy page" });
    });
    assert.equal((await runWebSearch({ urls: [page] }, ctx)).isError, undefined);
  });
});

test("pi login/logout changes discovery fingerprints and stale routes re-resolve auth before HTTP", async t => {
  await withTempCache(async () => {
    let loggedIn = true;
    const ctx = piContext({ auth: async () => loggedIn ? { ok: true, apiKey: key } : { ok: false, error: "pi DeepSeek logged out" } });
    ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: loggedIn });
    ctx.modelRegistry.hasConfiguredAuth = () => loggedIn;
    const before = resolveResolutionContext(ctx);
    const [candidate] = getFetchCandidates(before);
    loggedIn = false;
    const after = resolveResolutionContext(ctx);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.deepEqual(getFetchCandidates(after), []);
    const network = t.mock.method(globalThis, "fetch", () => assert.fail("logged-out credentials must not be used"));
    await assert.rejects(() => candidate.adapter.fetch(ctx, candidate.model, [page]), /logged out/);
    assert.equal(network.mock.callCount(), 0);
  });
});

test("pi DeepSeek transport errors redact the sent registry credential after in-flight rotation", async t => {
  await withTempCache(async () => {
    let activeKey = key;
    const ctx = piContext({ auth: async () => ({ ok: true, apiKey: activeKey }) });
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${key}`);
      activeKey = "unit-test-rotated-pi-key";
      throw new Error(`transport failed using ${key}`);
    });
    const result = await runWebSearch({ urls: [page] }, ctx);
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /unit-test-pi-deepseek-secret/);
    assert.match(result.content[0].text, /\[REDACTED\]/);
  });
});

test("standalone priority and manual pi DeepSeek preferences preserve cross-provider fallback", async t => {
  await withTempCache(() => withEnv({ EXA_API_KEY: "unit-test-exa-key" }, async () => {
    const ctx = piContext();
    let resolution = resolveResolutionContext(ctx);
    assert.deepEqual(getSearchCandidates(resolution).map(candidate => candidate.model.provider), ["exa", "deepseek"]);
    assert.deepEqual(getFetchCandidates(resolution).map(candidate => candidate.model.provider), ["exa", "deepseek"]);
    writeProviderPreferences({ version: 1, fetch: "deepseek" });
    resolution = resolveResolutionContext(ctx);
    assert.equal(getFetchCandidates(resolution)[0].nativeTools, true);
    const hosts = [];
    t.mock.method(globalThis, "fetch", async url => {
      hosts.push(new URL(url).hostname);
      return new URL(url).hostname === "api.deepseek.com" ? json({ error: { message: "unavailable" } }, 503)
        : json({ results: [{ id: page, url: page, text: "fallback page" }] });
    });
    assert.equal((await runWebSearch({ urls: [page] }, ctx)).isError, undefined);
    assert.deepEqual(hosts, ["api.deepseek.com", "api.exa.ai"]);
  }));
});

test("extension DeepSeek credentials stay separate and have one provider-menu entry", async () => {
  await withTempCache(async () => {
    await saveApiKey("deepseek", "unit-test-extension-key");
    const resolution = resolveResolutionContext(piContext());
    assert.equal(resolution.available.filter(candidate => candidate.family === "deepseek").length, 2);
    const choices = getSelectableProviders(resolution, "fetch");
    assert.equal(choices.length, 1);
    assert.equal(choices[0].adapter.standalone, true);
    assert.equal(getFetchCandidates(resolution)[1].nativeTools, true);
  });
});
