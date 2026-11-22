import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";
import piBetterWebSearch from "../extensions/index.ts";
import { getCredentialsPath, LOGIN_LABELS, LOGIN_PROVIDERS, removeApiKey, saveApiKey, savedApiKey } from "../lib/credentials.ts";
import { LOGIN_COMMAND_NAME } from "../lib/login-command.ts";
import { SecretInput } from "../lib/secret-input.ts";
import { dedicatedKey, dedicatedState } from "../lib/dedicated-config.ts";
import { getSearchCandidates, resolveResolutionContext } from "../lib/candidates.ts";
import { getCachePath } from "../lib/cache.ts";
import { getPreferencesPath, readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { isProviderCoolingDown, recordProviderFailure } from "../lib/health.ts";
import { runWebSearch } from "../lib/search.ts";
import { createMockCtx, createMockPi, withEnv, withTempCache } from "./helpers.mjs";

const theme = { fg: (_color, text) => text, bold: text => text };
const fakeKey = "unit-test-login-secret";

function loginUI(provider, key = fakeKey, submit = "\r") {
  const pi = createMockPi(); piBetterWebSearch(pi);
  const ctx = createMockCtx(); ctx.mode = "tui"; ctx.hasUI = true;
  const notifications = [], menus = [], frames = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  ctx.ui.select = async (title, options) => {
    menus.push({ title, options });
    return options.find(option => option.startsWith(LOGIN_LABELS[provider]));
  };
  ctx.ui.confirm = async () => true;
  ctx.ui.input = () => assert.fail("login must never use plaintext ui.input");
  ctx.ui.custom = factory => new Promise(resolve => {
    const component = factory({}, theme, {}, resolve);
    component.focused = true;
    frames.push(component.render(90).join("\n"));
    component.handleInput(`\x1b[200~${key}\x1b[201~`);
    frames.push(component.render(90).join("\n"));
    component.handleInput(submit);
    frames.push(component.render(90).join("\n"));
    component.dispose?.();
  });
  return { pi, ctx, command: pi.commands.get(LOGIN_COMMAND_NAME), notifications, menus, frames };
}

for (const provider of LOGIN_PROVIDERS) {
  test(`terminal login saves ${provider}, immediately exposes its API and sends the saved key`, async (t) => {
    await withTempCache(async () => {
      const ui = loginUI(provider);
      writeProviderPreferences({ version: 1, search: provider, apis: { [provider]: false } });
      t.mock.method(ui.ctx.modelRegistry, "getApiKeyAndHeaders", () => assert.fail("standalone login does not use model auth"));
      let calls = 0;
      t.mock.method(globalThis, "fetch", async (url, init) => {
        calls++;
        const headers = new Headers(init.headers);
        assert.equal(headers.get(provider === "perplexity" || provider === "deepseek" ? "Authorization" : "X-API-Key"), provider === "perplexity" || provider === "deepseek" ? `Bearer ${fakeKey}` : fakeKey);
        assert.equal(new URL(url).hostname, `api.${provider === "deepseek" ? "deepseek.com" : `${provider}.ai`}`);
        return new Response(JSON.stringify({ results: [] }));
      });
      await ui.command.handler("login", ui.ctx);
      assert.equal(calls, 0, "login saves without a billable validation call");
      assert.deepEqual(ui.menus[0].options, ["DeepSeek", "Exa", "Keenable", "Parallel", "Perplexity"]);
      assert.equal(savedApiKey(provider), fakeKey);
      assert.equal(dedicatedKey(provider), fakeKey);
      assert.equal(dedicatedState(provider).keySource, "saved");
      assert.equal(readProviderPreferences().apis[provider], true);
      assert.equal(readProviderPreferences().search, provider);
      assert.equal(getSearchCandidates(resolveResolutionContext(ui.ctx))[0].model.provider, provider);
      assert.ok(ui.pi.getActiveTools().includes("web_search"));
      assert.equal(!!ui.pi.tools.get("web_search").parameters.properties.urls, provider !== "perplexity");
      const result = await runWebSearch(provider === "parallel" ? { objective: "test", search_queries: ["test"] } : { query: "test" }, ui.ctx);
      assert.equal(result.isError, undefined);
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify([...ui.frames, ...ui.notifications, ...ui.menus]), /unit-test-login-secret/);
      assert.doesNotMatch(readFileSync(getPreferencesPath(), "utf8"), /unit-test-login-secret/);
      assert.doesNotMatch(readFileSync(getCachePath(), "utf8"), /unit-test-login-secret/);
      assert.equal(JSON.parse(readFileSync(getCredentialsPath(), "utf8")).keys[provider], fakeKey);
      if (process.platform !== "win32") assert.equal(statSync(getCredentialsPath()).mode & 0o777, 0o600);
    });
  });
}

test("saved DeepSeek keys support URL-only fetch and are redacted from agent-visible API errors", async (t) => {
  await withTempCache(async () => {
    await saveApiKey("deepseek", fakeKey);
    const ctx = createMockCtx();
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${fakeKey}`);
      if (String(url).endsWith("/fetch")) {
        assert.deepEqual(JSON.parse(init.body), { url: "https://example.com" });
        return new Response(JSON.stringify({ title: "page", content: "raw fetched page" }));
      }
      return new Response(JSON.stringify({ error: { message: `invalid credential ${fakeKey}` } }), { status: 401 });
    });
    const fetched = await runWebSearch({ urls: ["https://example.com"] }, ctx);
    assert.equal(fetched.isError, undefined);
    assert.equal(JSON.parse(fetched.content[0].text).fetched[0].data.content, "raw fetched page");
    const failed = await runWebSearch({ query: "test" }, ctx);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(failed), /unit-test-login-secret/);
  });
});

test("saved keys survive new command instances, override environment keys and never change environment", async () => {
  await withTempCache(async () => {
    await withEnv({ PERPLEXITY_API_KEY: "unit-test-environment-key" }, async () => {
      const ui = loginUI("perplexity");
      await ui.command.handler("login", ui.ctx);
      assert.equal(process.env.PERPLEXITY_API_KEY, "unit-test-environment-key");
      assert.equal(dedicatedKey("perplexity"), fakeKey);
      const reloaded = loginUI("perplexity");
      await reloaded.command.handler("status", reloaded.ctx);
      assert.match(reloaded.notifications[0].message, /Perplexity: saved key present/);
      assert.doesNotMatch(JSON.stringify(reloaded.notifications), /unit-test-/);
      assert.equal(reloaded.menus.length, 0);
    });
  });
});

test("secret input masks typing/paste at all widths, supports editing and clears on submit/cancel", () => {
  const finished = [];
  const input = new SecretInput("API key", theme, value => finished.push(value));
  input.focused = true;
  input.handleInput("\x1b[200~unit-test-secretX\x1b[201~");
  input.handleInput("\x7f"); // Backspace
  for (const width of [1, 10, 80, 200]) {
    assert.doesNotMatch(input.render(width).join("\n"), /unit-test/);
  }
  assert.match(input.render(80).join("\n"), /\*+/);
  input.handleInput("\r");
  assert.deepEqual(finished, ["unit-test-secret"]);
  assert.doesNotMatch(input.render(80).join("\n"), /\*/);
  input.handleInput("more"); input.handleInput("\r");
  assert.equal(finished.length, 1);
  for (const key of ["\x1b", "\x03"]) {
    let result = "pending";
    const cancelled = new SecretInput("API key", theme, value => { result = value; });
    cancelled.handleInput(fakeKey); cancelled.handleInput(key);
    assert.equal(result, undefined);
    assert.doesNotMatch(cancelled.render(80).join("\n"), /\*|unit-test/);
  }
});

test("cancelling either login dialog leaves credentials and ordinary preferences untouched", async () => {
  await withTempCache(async () => {
    await saveApiKey("exa", "unit-test-existing-key");
    writeProviderPreferences({ version: 1, search: "keenable", apis: { exa: false } });
    const credentials = readFileSync(getCredentialsPath(), "utf8");
    const settings = readFileSync(getPreferencesPath(), "utf8");
    const ui = loginUI("exa", fakeKey, "\x1b");
    await ui.command.handler("login", ui.ctx);
    ui.ctx.ui.select = async () => undefined;
    await ui.command.handler("login", ui.ctx);
    assert.equal(readFileSync(getCredentialsPath(), "utf8"), credentials);
    assert.equal(readFileSync(getPreferencesPath(), "utf8"), settings);
  });
});

test("invalid keys and arguments do not leak values, save files or make HTTP requests", async (t) => {
  await withTempCache(async () => {
    t.mock.method(globalThis, "fetch", () => assert.fail("must not send a key validation request"));
    for (const key of ["", " ", "invalid key", "x".repeat(8193)]) {
      const ui = loginUI("exa", key);
      await ui.command.handler("login", ui.ctx);
      assert.equal(existsSync(getCredentialsPath()), false);
      assert.equal(ui.notifications.at(-1).level, "warning");
      assert.match(ui.notifications.at(-1).message, /Invalid API key/);
    }
    for (const args of [`login ${fakeKey}`, `help ${fakeKey}`, `search ${fakeKey}`]) {
      const ui = loginUI("exa");
      await ui.command.handler(args, ui.ctx);
      assert.equal(ui.menus.length, 0);
      assert.equal(ui.notifications.at(-1).level, "warning");
      assert.match(ui.notifications.at(-1).message, /Usage:/);
      assert.match(ui.notifications.at(-1).message, /\/web-search-provider search/);
      assert.match(ui.notifications.at(-1).message, /\/web-search-provider fetch/);
      assert.doesNotMatch(JSON.stringify(ui.notifications), /unit-test-login-secret/);
    }
  });
});

test("root/help discovers priority and API commands without opening dialogs or changing state", async (t) => {
  await withTempCache(async () => {
    t.mock.method(globalThis, "fetch", () => assert.fail("help must not make requests"));
    await saveApiKey("exa", fakeKey);
    writeProviderPreferences({ version: 1, search: "exa", fetch: "keenable", apis: { exa: true } });
    const credentials = readFileSync(getCredentialsPath(), "utf8");
    const settings = readFileSync(getPreferencesPath(), "utf8");
    for (const args of ["", "help", " help "]) {
      for (const mode of ["tui", "rpc", "print"]) {
        const ui = loginUI("exa");
        ui.ctx.mode = mode;
        ui.ctx.hasUI = mode === "tui";
        await ui.command.handler(args, ui.ctx);
        assert.equal(ui.notifications.length, 1);
        assert.equal(ui.notifications[0].level, "info");
        const help = ui.notifications[0].message;
        assert.match(help, /\/pi-better-web-search login\|logout\|status/);
        assert.match(help, /\/web-search-provider search/);
        assert.match(help, /\/web-search-provider fetch/);
        assert.match(help, /\/web-search-api/);
        assert.match(help, /automatic fallback remains enabled/);
        assert.match(help, /Enter keys only in the hidden terminal dialog/);
        assert.doesNotMatch(help, /unit-test-login-secret/);
        assert.equal(ui.menus.length, 0);
        assert.equal(ui.frames.length, 0);
      }
    }
    assert.equal(readFileSync(getCredentialsPath(), "utf8"), credentials);
    assert.equal(readFileSync(getPreferencesPath(), "utf8"), settings);
  });
});

test("RPC/print/no-UI login is refused instead of using an insecure plaintext fallback", async () => {
  await withTempCache(async () => {
    for (const mode of ["rpc", "print", "json", "tui"]) {
      const ui = loginUI("perplexity");
      ui.ctx.mode = mode;
      if (mode === "tui") ui.ctx.hasUI = false;
      ui.ctx.ui.custom = () => assert.fail("must not prompt outside local TUI");
      await ui.command.handler("login", ui.ctx);
      assert.equal(ui.menus.length, 0);
      assert.match(ui.notifications.at(-1).message, /local interactive pi terminal/);
    }
    const ui = loginUI("exa"); delete ui.ctx.ui.custom;
    await ui.command.handler("login", ui.ctx);
    assert.equal(existsSync(getCredentialsPath()), false);
  });
});

test("credential writes preserve other providers, serialize concurrent saves and reject a corrupt store", async () => {
  await withTempCache(async () => {
    assert.deepEqual(await Promise.all(LOGIN_PROVIDERS.map(provider => saveApiKey(provider, `${fakeKey}-${provider}`))), [true, true, true, true, true]);
    for (const provider of LOGIN_PROVIDERS) assert.equal(savedApiKey(provider), `${fakeKey}-${provider}`);
    assert.equal(await saveApiKey("exa", "unit-test-rotated"), true);
    assert.equal(savedApiKey("deepseek"), `${fakeKey}-deepseek`);
    assert.equal(await removeApiKey("exa"), true);
    assert.equal(savedApiKey("exa"), undefined);
    assert.equal(existsSync(`${getCredentialsPath()}.lock`), false);
    writeFileSync(getCredentialsPath(), "{corrupt-existing-storage");
    assert.equal(savedApiKey("deepseek"), undefined);
    assert.equal(await saveApiKey("exa", fakeKey), false);
    assert.equal(readFileSync(getCredentialsPath(), "utf8"), "{corrupt-existing-storage");
  });
});

test("save failures leave existing settings alone and never report false success", async () => {
  await withTempCache(async ({ directory }) => {
    writeProviderPreferences({ version: 1, search: "exa", apis: { exa: false } });
    const before = readFileSync(getPreferencesPath(), "utf8");
    await withEnv({ PI_BETTER_WEB_SEARCH_AUTH: directory }, async () => {
      const ui = loginUI("exa");
      await ui.command.handler("login", ui.ctx);
      assert.equal(ui.notifications.at(-1).level, "error");
      assert.match(ui.notifications.at(-1).message, /Could not save credentials/);
      assert.doesNotMatch(JSON.stringify(ui.notifications), /unit-test-login-secret/);
    });
    assert.equal(readFileSync(getPreferencesPath(), "utf8"), before);
  });
});

test("if enabling fails after a successful save, the terminal explicitly reports that the key was saved", async () => {
  await withTempCache(async ({ directory }) => {
    await withEnv({ PI_BETTER_WEB_SEARCH_SETTINGS: directory }, async () => {
      const ui = loginUI("exa");
      await ui.command.handler("login", ui.ctx);
      assert.equal(savedApiKey("exa"), fakeKey);
      assert.equal(ui.notifications.at(-1).level, "warning");
      assert.match(ui.notifications.at(-1).message, /key saved, but.*enable setting/);
    });
  });
});

test("replacing a key clears only that provider's health state and preserves manual routing", async () => {
  await withTempCache(async () => {
    recordProviderFailure("search", "exa", "HTTP 401");
    recordProviderFailure("fetch", "exa", "HTTP 401");
    recordProviderFailure("search", "perplexity", "HTTP 503");
    writeProviderPreferences({ version: 1, search: "perplexity", fetch: "keenable" });
    const ui = loginUI("exa"); await ui.command.handler("login", ui.ctx);
    assert.equal(isProviderCoolingDown("search", "exa"), false);
    assert.equal(isProviderCoolingDown("fetch", "exa"), false);
    assert.equal(isProviderCoolingDown("search", "perplexity"), true);
    assert.equal(readProviderPreferences().search, "perplexity");
    assert.equal(readProviderPreferences().fetch, "keenable");
  });
});

test("losing a keyed Keenable credential does not silently fall back to public access", async (t) => {
  await withTempCache(async () => {
    const ui = loginUI("keenable"); await ui.command.handler("login", ui.ctx);
    await removeApiKey("keenable"); // Simulate deletion/credential-file loss, not an explicit public opt-in.
    assert.equal(readProviderPreferences().apis.keenableKeyRequired, true);
    assert.equal(dedicatedState("keenable", readProviderPreferences().apis).available, false);
    t.mock.method(globalThis, "fetch", () => assert.fail("must not downgrade to a public request"));
    const result = await runWebSearch({ query: "test" }, ui.ctx);
    assert.equal(result.isError, true);
  });
});

test("logging in again with the same key cannot bypass the server's Retry-After", async (t) => {
  await withTempCache(async () => {
    const ui = loginUI("perplexity"); await ui.command.handler("login", ui.ctx);
    const network = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "Retry-After": "600" } }));
    await runWebSearch({ query: "first" }, ui.ctx);
    await ui.command.handler("login", ui.ctx);
    const result = await runWebSearch({ query: "second" }, ui.ctx);
    assert.equal(network.mock.callCount(), 1);
    assert.match(result.content[0].text, /Retry-After is active/);
  });
});

test("logout removes only the selected saved key and does not silently enable keyless Keenable", async () => {
  await withTempCache(async () => {
    await saveApiKey("exa", "unit-test-existing-exa");
    const ui = loginUI("keenable");
    await ui.command.handler("login", ui.ctx);
    await ui.command.handler("logout", ui.ctx);
    assert.equal(savedApiKey("keenable"), undefined);
    assert.equal(savedApiKey("exa"), "unit-test-existing-exa");
    assert.equal(readProviderPreferences().apis.keenable, false);
    assert.equal(dedicatedState("keenable", readProviderPreferences().apis).available, false);
    assert.match(ui.notifications.at(-1).message, /saved key removed/);
  });
});
