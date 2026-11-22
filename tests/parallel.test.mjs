import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Value } from "typebox/value";
import piBetterWebSearch, { createWebSearchToolManager } from "../extensions/index.ts";
import { API_COMMAND_NAME } from "../lib/api-command.ts";
import { fingerprintAvailableModels, getCachePath, readCache } from "../lib/cache.ts";
import {
  getFetchCandidates,
  getSearchCandidates,
  getSelectableProviders,
  isParallelLocked,
  resolveResolutionContext,
} from "../lib/candidates.ts";
import { saveApiKey } from "../lib/credentials.ts";
import { dedicatedState, isParallelActive } from "../lib/dedicated-config.ts";
import { readProviderPreferences, writeProviderPreferences } from "../lib/preferences.ts";
import { PROVIDER_COMMAND_NAME } from "../lib/provider-command.ts";
import { ADAPTERS, parallelAdapter } from "../lib/providers/index.ts";
import { HttpError } from "../lib/providers/http.ts";
import { renderWebSearchCall } from "../lib/render.ts";
import {
  buildWebSearchSchema,
  buildWebSearchToolDescription,
  MAX_PARALLEL_SEARCH_QUERIES,
  MAX_URLS,
  PARALLEL_EXTRACT_DESCRIPTION,
  PARALLEL_EXTRACT_OBJECTIVE_DESCRIPTION,
  PARALLEL_OBJECTIVE_DESCRIPTION,
  PARALLEL_SEARCH_DESCRIPTION,
  PARALLEL_SEARCH_OBJECTIVE_DESCRIPTION,
  PARALLEL_SEARCH_QUERIES_DESCRIPTION,
  PARALLEL_URLS_DESCRIPTION,
  PARALLEL_WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_DESCRIPTION,
} from "../lib/schema.ts";
import { parseWebSearchInput, runWebSearch } from "../lib/search.ts";
import {
  createMockCtx,
  createMockPi,
  deepseekModel,
  googleModel,
  openaiResponsesModel,
  withEnv,
  withTempCache,
} from "./helpers.mjs";

const key = "unit-test-parallel-secret";
const page = "https://example.com/page";
const other = "https://example.com/other";
const theme = { fg: (_color, text) => text, bold: text => text };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const ctx = () => createMockCtx({ availableModels: [] });
const providers = candidates => candidates.map(candidate => candidate.model.provider);
const withParallel = fn => withTempCache(() => withEnv({ PARALLEL_API_KEY: key }, fn));

test("Parallel active state switches tool schema and descriptions to Parallel's official definitions", async () => {
  await withParallel(async () => {
    const pi = createMockPi();
    const manager = createWebSearchToolManager(pi);
    assert.deepEqual(manager.sync(ctx()), { expose: true, allowUrls: true });
    const tool = pi.tools.get("web_search");
    assert.equal(tool.description, PARALLEL_WEB_SEARCH_DESCRIPTION);
    assert.equal(
      PARALLEL_WEB_SEARCH_DESCRIPTION,
      `${PARALLEL_SEARCH_DESCRIPTION} ${PARALLEL_EXTRACT_DESCRIPTION}`,
    );
    assert.equal(
      PARALLEL_OBJECTIVE_DESCRIPTION,
      `${PARALLEL_SEARCH_OBJECTIVE_DESCRIPTION} ${PARALLEL_EXTRACT_OBJECTIVE_DESCRIPTION}`,
    );
    const schema = tool.parameters;
    assert.deepEqual(Object.keys(schema.properties), ["objective", "search_queries", "urls"]);
    assert.equal(schema.properties.query, undefined);
    assert.equal(schema.required, undefined);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.objective.description, PARALLEL_OBJECTIVE_DESCRIPTION);
    assert.equal(schema.properties.search_queries.description, PARALLEL_SEARCH_QUERIES_DESCRIPTION);
    assert.equal(schema.properties.search_queries.minItems, 1);
    assert.equal(schema.properties.search_queries.maxItems, MAX_PARALLEL_SEARCH_QUERIES);
    assert.equal(schema.properties.urls.description, PARALLEL_URLS_DESCRIPTION);
    assert.equal(schema.properties.urls.minItems, 1);
    assert.equal(schema.properties.urls.maxItems, MAX_URLS);

    assert.equal(
      Value.Check(schema, {
        objective: "Find latest TypeScript release notes.",
        search_queries: ["TypeScript release notes", "TypeScript new features"],
      }),
      true,
    );
    assert.equal(Value.Check(schema, { urls: [page], objective: "Extract installation steps." }), true);
    assert.equal(Value.Check(schema, { urls: [page] }), true);
    assert.equal(Value.Check(schema, { query: "legacy query" }), false);
    assert.equal(
      Value.Check(schema, {
        objective: "Too many queries",
        search_queries: ["q1", "q2", "q3", "q4"],
      }),
      false,
    );
  });
});

test("Parallel search fixes mode to advanced, sends objective and search_queries, and omits root bookkeeping", async (t) => {
  await withParallel(async () => {
    const search = {
      results: [
        {
          url: page,
          title: "Parallel Result",
          publish_date: "2026-01-15",
          excerpts: ["Dense relevant excerpt"],
          extra: {
            search_id: "nested-id",
            usage: "nested-usage",
            session_id: "nested-session",
          },
        },
      ],
      unknown: { preserved: true },
    };
    const raw = {
      ...search,
      search_id: "search_123",
      warnings: null,
      usage: [{ name: "sku_search", count: 1 }],
      metadata: null,
      session_id: "session_123",
    };
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.parallel.ai/v1/search");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.get("X-API-Key"), key);
      assert.equal(init.headers.has("Authorization"), false);
      assert.equal(init.headers.get("Content-Type"), "application/json");
      assert.equal(init.headers.get("Accept"), "application/json");
      assert.deepEqual(JSON.parse(init.body), {
        mode: "advanced",
        objective: "Find latest information about Parallel Web Systems.",
        search_queries: ["Parallel Web Systems products", "Parallel Web Systems announcements"],
      });
      return json(raw);
    });
    const context = ctx();
    t.mock.method(context.modelRegistry, "getApiKeyAndHeaders", () => assert.fail("Parallel must not use model auth"));
    const result = await runWebSearch(
      {
        objective: " Find latest information about Parallel Web Systems. ",
        search_queries: [" Parallel Web Systems products ", "Parallel Web Systems announcements"],
      },
      context,
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { search });
    assert.deepEqual(result.details.routes, [{ phase: "search", provider: "parallel", endpoint: "/v1/search" }]);
    assert.equal(result.details.resultCount, 1);
    assert.equal(readCache().search.provider, "parallel");
    assert.doesNotMatch(readFileSync(getCachePath(), "utf8"), /unit-test-parallel-secret/);
  });
});

test("Parallel extract sends urls and optional objective, matches identities, and handles HTTP-200 errors", async (t) => {
  await withParallel(async () => {
    const missing = "https://example.com/missing";
    const rootSlash = "https://example.com/";
    const pageData = {
      url: page,
      title: "Example Page",
      publish_date: null,
      excerpts: ["Extracted markdown excerpt"],
      full_content: null,
      acquired_at: "2026-11-21T00:00:00Z",
    };
    const rootData = {
      url: "https://example.com",
      title: "Root Domain",
      excerpts: ["Root domain content"],
    };
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://api.parallel.ai/v1/extract");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.get("X-API-Key"), key);
      const parsedBody = JSON.parse(init.body);
      bodies.push(parsedBody);
      return json({
        extract_id: "extract_123",
        results: [
          rootData,
          { url: "https://example.com/unrequested", excerpts: ["do not assign by index"] },
          pageData,
        ],
        errors: [
          {
            url: missing,
            error_type: "fetch_error",
            http_status_code: 404,
            content: `Not found with key ${key}`,
          },
        ],
        warnings: null,
        usage: [{ name: "sku_extract_excerpts", count: 1 }],
        session_id: "session_123",
      });
    });

    const withObjective = await runWebSearch(
      {
        urls: [page, missing, rootSlash],
        objective: " Summarize the page ",
      },
      ctx(),
    );
    assert.equal(withObjective.isError, undefined);
    assert.deepEqual(bodies[0], {
      urls: [page, missing, rootSlash],
      objective: "Summarize the page",
    });
    assert.deepEqual(withObjective.details.routes, [{ phase: "fetch", provider: "parallel", endpoint: "/v1/extract" }]);
    assert.equal(withObjective.details.fetchedCount, 2);
    assert.equal(withObjective.details.fetchFailedCount, 1);
    const output = JSON.parse(withObjective.content[0].text);
    assert.equal(output.search, undefined);
    assert.deepEqual(output.fetched[0], { url: page, data: pageData });
    assert.match(output.fetched[1].error, /fetch_error, HTTP 404\): Not found with key \[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(withObjective), /unit-test-parallel-secret/);
    assert.deepEqual(output.fetched[2], { url: rootSlash, data: rootData });

    const withoutObjective = await runWebSearch({ urls: [page] }, ctx());
    assert.equal(withoutObjective.isError, undefined);
    assert.deepEqual(bodies[1], { urls: [page] });
  });
});

test("Parallel combined call runs /v1/search and /v1/extract with shared objective", async (t) => {
  await withParallel(async () => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, body: JSON.parse(init.body) });
      if (pathname === "/v1/search") {
        return json({
          search_id: "s1",
          results: [{ url: page, title: "Result", excerpts: ["Search excerpt"] }],
          session_id: "sess1",
        });
      }
      return json({
        extract_id: "e1",
        results: [{ url: page, title: "Page", excerpts: ["Extract excerpt"] }],
        errors: [],
        session_id: "sess1",
      });
    });
    const result = await runWebSearch(
      {
        objective: "Check TypeScript 5.9 features",
        search_queries: ["TypeScript 5.9 release notes"],
        urls: [page],
      },
      ctx(),
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        pathname: "/v1/search",
        body: {
          mode: "advanced",
          objective: "Check TypeScript 5.9 features",
          search_queries: ["TypeScript 5.9 release notes"],
        },
      },
      {
        pathname: "/v1/extract",
        body: {
          urls: [page],
          objective: "Check TypeScript 5.9 features",
        },
      },
    ]);
    assert.deepEqual(result.details.routes, [
      { phase: "search", provider: "parallel", endpoint: "/v1/search" },
      { phase: "fetch", provider: "parallel", endpoint: "/v1/extract" },
    ]);
  });
});

test("Parallel locks priority and disables fallback to all other dedicated and model providers", async (t) => {
  await withParallel(() =>
    withEnv(
      {
        KEENABLE_API_KEY: "test-keenable",
        EXA_API_KEY: "test-exa",
        PERPLEXITY_API_KEY: "test-perplexity",
        DEEPSEEK_API_KEY: "test-deepseek",
      },
      async () => {
        writeProviderPreferences({ version: 1, search: "deepseek", fetch: "exa" });
        const model = deepseekModel();
        const context = createMockCtx({
          model,
          availableModels: [model, openaiResponsesModel(), googleModel()],
        });
        const resolution = resolveResolutionContext(context);
        assert.equal(isParallelActive(resolution.preferences.apis), true);
        assert.equal(isParallelLocked(resolution), true);
        assert.deepEqual(providers(getSearchCandidates(resolution)), ["parallel"]);
        assert.deepEqual(providers(getFetchCandidates(resolution)), ["parallel"]);
        assert.deepEqual(providers(getSelectableProviders(resolution, "search")), ["parallel"]);
        assert.deepEqual(providers(getSelectableProviders(resolution, "fetch")), ["parallel"]);

        const hosts = [];
        t.mock.method(globalThis, "fetch", async url => {
          hosts.push(new URL(url).hostname);
          return json({ type: "error", error: { ref_id: "err1", message: "Parallel service outage" } }, 503);
        });
        t.mock.method(ADAPTERS.deepseek, "search", () => assert.fail("must not fall back to DeepSeek search"));
        t.mock.method(ADAPTERS.deepseek, "fetch", () => assert.fail("must not fall back to DeepSeek fetch"));
        t.mock.method(ADAPTERS.google, "fetch", () => assert.fail("must not fall back to Google fetch"));

        const failed = await runWebSearch(
          {
            objective: "Test no fallback on failure",
            search_queries: ["parallel no fallback"],
            urls: [page],
          },
          context,
        );
        assert.equal(failed.isError, true);
        assert.deepEqual(hosts, ["api.parallel.ai", "api.parallel.ai"]);
        assert.deepEqual(
          failed.details.attempts.map(attempt => [attempt.phase, attempt.provider]),
          [
            ["search", "parallel"],
            ["fetch", "parallel"],
          ],
        );
      },
    ),
  );
});

test("/web-search-provider refuses priority changes while Parallel is active and unlocks when Parallel is disabled", async () => {
  await withParallel(async () => {
    const pi = createMockPi();
    piBetterWebSearch(pi);
    const model = deepseekModel();
    const context = createMockCtx({ model, availableModels: [model, openaiResponsesModel()] });
    context.hasUI = true;
    const notifications = [];
    let selectCalls = 0;
    context.ui.notify = (message, level) => notifications.push({ message, level });
    context.ui.select = async (_title, options) => {
      selectCalls += 1;
      return options[0];
    };
    writeProviderPreferences({ version: 1, search: "openai" });

    const providerCommand = pi.commands.get(PROVIDER_COMMAND_NAME);
    for (const arg of ["", "search", "fetch"]) {
      await providerCommand.handler(arg, context);
    }
    assert.equal(selectCalls, 0, "provider picker must not open while Parallel is active");
    assert.equal(notifications.length, 3);
    for (const entry of notifications) {
      assert.equal(entry.level, "info");
      assert.match(entry.message, /locked to Parallel/i);
    }
    assert.equal(readProviderPreferences().search, "openai");

    // Disable Parallel via /web-search-api parallel; schema and priority picker unlock.
    const apiCommand = pi.commands.get(API_COMMAND_NAME);
    context.ui.select = async (_title, options) => options.find(option => option.startsWith("Disable"));
    await apiCommand.handler("parallel", context);
    assert.equal(readProviderPreferences().apis?.parallel, false);
    assert.equal(pi.tools.get("web_search").description, WEB_SEARCH_DESCRIPTION);
    assert.deepEqual(Object.keys(pi.tools.get("web_search").parameters.properties), ["query", "urls"]);
    assert.deepEqual(providers(getSearchCandidates(resolveResolutionContext(context))), ["openai", "deepseek"]);

    let providerMenuOpened = false;
    context.ui.select = async (_title, options) => {
      providerMenuOpened = true;
      return options[0];
    };
    await providerCommand.handler("search", context);
    assert.equal(providerMenuOpened, true);
  });
});

test("Parallel input validation enforces objective + search_queries for search and rejects legacy query", async (t) => {
  await withParallel(async () => {
    for (const invalid of [
      {},
      { query: "legacy query" },
      { objective: "Only objective without queries or urls" },
      { search_queries: ["missing objective"] },
      { objective: "   ", search_queries: ["valid query"] },
      { objective: "Valid objective", search_queries: [] },
      { objective: "Valid objective", search_queries: ["   "] },
      { objective: "Valid objective", search_queries: ["q1", "q2", "q3", "q4"] },
      { objective: "Valid objective", search_queries: ["q1"], mode: "fast" },
      { urls: [page], advanced_settings: { full_content: true } },
    ]) {
      const parsed = parseWebSearchInput(invalid, { parallel: true });
      assert.equal(parsed.ok, false, JSON.stringify(invalid));
    }

    const fetchMock = t.mock.method(globalThis, "fetch", () => assert.fail("invalid input must not fetch"));
    const rejected = await runWebSearch({ query: "legacy" }, ctx());
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unknown argument "query"/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

test("Parallel per-URL error redaction uses the sent credential even after in-flight key rotation", async (t) => {
  await withTempCache(async () => {
    const oldKey = "unit-test-old-parallel-key";
    const newKey = "unit-test-new-parallel-key";
    assert.equal(await saveApiKey("parallel", oldKey), true);
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("X-API-Key"), oldKey);
      assert.equal(await saveApiKey("parallel", newKey), true);
      return json({
        results: [],
        errors: [
          {
            url: page,
            error_type: "fetch_error",
            http_status_code: 500,
            content: `credential ${oldKey} failed`,
          },
        ],
      });
    });
    const result = await parallelAdapter.fetch(ctx(), null, [page], "objective");
    assert.match(result.entries[0].error, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(result), /unit-test-old-parallel-key/);
  });
});

test("Parallel shares Retry-After across search and extract and respects cancellation", async (t) => {
  await withParallel(async () => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return calls === 1 ? json({ error: { message: "rate limited" } }, 429, { "Retry-After": "60" }) : json({ results: [] });
    });
    await assert.rejects(() => parallelAdapter.search(ctx(), null, "objective", undefined, undefined, ["query"]), { status: 429 });
    await assert.rejects(() => parallelAdapter.search(ctx(), null, "objective", undefined, undefined, ["query"]), /Retry-After is active/);
    await assert.rejects(() => parallelAdapter.fetch(ctx(), null, [page], "objective"), /Retry-After is active/);
    assert.equal(calls, 1);

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(
      () => parallelAdapter.search(ctx(), null, "objective", controller.signal, undefined, ["query"]),
      { name: "AbortError" },
    );
  });
});

test("renderWebSearchCall displays Parallel search, extract, and combined calls", () => {
  const render = component => component.render(200).map(line => line.trimEnd()).join("\n");
  assert.equal(
    render(renderWebSearchCall({ objective: "Find EV credits", search_queries: ["EV tax credit"] }, theme)),
    "Web Search Find EV credits",
  );
  assert.equal(
    render(renderWebSearchCall({ urls: [page], objective: "Extract summary" }, theme)),
    "Web Fetch 1 URL",
  );
  assert.equal(
    render(
      renderWebSearchCall(
        { objective: "Find EV credits", search_queries: ["EV tax credit"], urls: [page, other] },
        theme,
      ),
    ),
    "Web Search + Fetch Find EV credits + 2 URLs",
  );
});
