import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  createMockCtx,
  createMockPi,
  deepseekModel,
  ollamaCloudModel,
  openaiResponsesModel,
  unsupportedLocalModel,
  withTempCache,
} from "./helpers.mjs";

import piBetterWebSearch, { createWebSearchToolManager } from "../extensions/index.ts";
import { fingerprintAvailableModels, readCache } from "../lib/cache.ts";
import { MAX_OUTPUT_CHARS } from "../lib/format.ts";
import { WEB_SEARCH_TOOL_NAME } from "../lib/schema.ts";
import { runWebSearch } from "../lib/search.ts";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";

function jsonResponse(payload, status = 200, statusText = "") {
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events) {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openaiSearchCall(query, id = "ws_integration") {
  return {
    type: "web_search_call",
    id,
    status: "completed",
    action: {
      type: "search",
      query,
      queries: [query],
      sources: [{ type: "url", title: "Example", url: "https://example.com/openai" }],
    },
  };
}

function openaiSearchEvents(query, answer = "OpenAI answer") {
  const call = openaiSearchCall(query);
  return [
    { type: "response.output_item.done", item: call },
    { type: "response.output_text.delta", delta: answer },
    { type: "response.completed", response: { output: [call] } },
  ];
}

function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = String(input);
    let body;
    if (typeof init.body === "string") {
      body = JSON.parse(init.body);
    }
    const call = { url, init, body };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function unexpected(url) {
  throw new Error(`Unexpected fetch request: ${url}`);
}

test("exposure: hidden without providers, DeepSeek adds urls, OpenAI-only stays query-only", () => {
  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  const manager = createWebSearchToolManager(pi);
  const current = unsupportedLocalModel();

  assert.deepEqual(manager.sync(createMockCtx({ model: current })), {
    expose: false,
    allowUrls: false,
  });
  assert.deepEqual(pi.getActiveTools(), ["read"]);
  assert.equal(pi.tools.get(WEB_SEARCH_TOOL_NAME).defaultActive, false);

  const withDeepSeek = createMockCtx({
    model: current,
    availableModels: [deepseekModel()],
  });
  assert.deepEqual(manager.sync(withDeepSeek), { expose: true, allowUrls: true });
  assert.ok(pi.getActiveTools().includes(WEB_SEARCH_TOOL_NAME));
  let tool = pi.tools.get(WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.parameters.required, undefined);
  assert.equal(tool.parameters.anyOf, undefined);
  assert.ok(tool.parameters.properties.urls);
  assert.equal(tool.parameters.properties.urls.maxItems, 20);

  const openaiOnly = createMockCtx({
    model: current,
    availableModels: [openaiResponsesModel()],
  });
  assert.deepEqual(manager.sync(openaiOnly), { expose: true, allowUrls: false });
  assert.ok(pi.getActiveTools().includes(WEB_SEARCH_TOOL_NAME));
  tool = pi.tools.get(WEB_SEARCH_TOOL_NAME);
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.equal(tool.parameters.properties.urls, undefined);
  assert.equal(tool.parameters.anyOf, undefined);
});

test("fallback: unsupported current model uses DeepSeek first and remembers it", async (t) => {
  await withTempCache(async (temp) => {
    const openai = openaiResponsesModel();
    const deepseek = deepseekModel();
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels: [openai, deepseek],
    });
    const rawResults = [
      {
        rerank_score: 0.9,
        title: "Raw result",
        url: "https://example.com/raw?utm_source=search",
        unknown_field: { preserved: true },
      },
      {
        rerank_score: 0.4,
        title: "Duplicate URL",
        url: "https://example.com/raw?utm_source=search",
      },
    ];
    const calls = mockFetch(t, ({ url, body }) => {
      if (url === DEEPSEEK_SEARCH_URL) {
        if (body.query === "first query") {
          assert.deepEqual(body, {
            query: "first query",
            count: 10,
            need_content: true,
          });
        }
        return jsonResponse({ results: rawResults });
      }
      if (url === OPENAI_RESPONSES_URL) {
        return sseResponse(openaiSearchEvents("first query"));
      }
      return unexpected(url);
    });

    const first = await runWebSearch({ query: "first query" }, ctx);
    assert.equal(first.isError, undefined);
    assert.deepEqual(JSON.parse(first.content[0].text), {
      query: "first query",
      search: {
        provider: "deepseek",
        model: "deepseek-chat",
        results: rawResults,
      },
    });
    assert.deepEqual(calls.map((call) => call.url), [DEEPSEEK_SEARCH_URL]);

    const fileAfterFirst = JSON.parse(readFileSync(temp.path, "utf8"));
    assert.deepEqual(fileAfterFirst.search, {
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.equal(fileAfterFirst.fingerprint, fingerprintAvailableModels(ctx));

    calls.length = 0;
    const second = await runWebSearch({ query: "second query" }, ctx);
    assert.equal(second.isError, undefined);
    assert.equal(JSON.parse(second.content[0].text).search.provider, "deepseek");
    assert.deepEqual(calls.map((call) => call.url), [DEEPSEEK_SEARCH_URL]);
    assert.equal(calls.some((call) => call.url === OPENAI_RESPONSES_URL), false);
  });
});

test("supported current model is tried first every time; cache supplies the fallback", async (t) => {
  await withTempCache(async () => {
    const openai = openaiResponsesModel();
    const deepseek = deepseekModel();
    const ctx = createMockCtx({
      model: openai,
      availableModels: [openai, deepseek],
    });
    const order = [];
    mockFetch(t, ({ url }) => {
      if (url === OPENAI_RESPONSES_URL) {
        order.push("openai");
        return jsonResponse(
          { error: { message: "bad request from OpenAI", type: "invalid_request_error" } },
          400,
          "Bad Request",
        );
      }
      if (url === DEEPSEEK_SEARCH_URL) {
        order.push("deepseek");
        return jsonResponse({ results: [{ title: "DeepSeek fallback" }] });
      }
      return unexpected(url);
    });

    const first = await runWebSearch({ query: "current model policy" }, ctx);
    assert.equal(first.isError, undefined);
    assert.deepEqual(order, ["openai", "deepseek"]);
    assert.equal(JSON.parse(first.content[0].text).search.provider, "deepseek");
    assert.equal(first.details.attempts.length, 1);
    assert.equal(first.details.attempts[0].provider, "openai");
    assert.match(first.details.attempts[0].message, /bad request from OpenAI/);
    assert.deepEqual(readCache().search, {
      provider: "deepseek",
      model: "deepseek-chat",
    });

    order.length = 0;
    const second = await runWebSearch({ query: "current model policy again" }, ctx);
    assert.equal(second.isError, undefined);
    // The supported current model stays first. The remembered DeepSeek
    // fallback follows it instead of replacing it.
    assert.deepEqual(order, ["openai", "deepseek"]);
    assert.equal(second.details.attempts.length, 1);
    assert.equal(JSON.parse(second.content[0].text).search.provider, "deepseek");
    assert.deepEqual(readCache().search, {
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });
});

test("provider-set changes invalidate the old cache and select the new priority provider", async (t) => {
  await withTempCache(async (temp) => {
    const openai = openaiResponsesModel();
    const deepseek = deepseekModel();
    const availableModels = [openai];
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels,
    });
    const calls = mockFetch(t, ({ url }) => {
      if (url === OPENAI_RESPONSES_URL) {
        return sseResponse(openaiSearchEvents("before change", "Old cache"));
      }
      if (url === DEEPSEEK_SEARCH_URL) {
        return jsonResponse({ results: [{ title: "New priority provider" }] });
      }
      return unexpected(url);
    });

    const first = await runWebSearch({ query: "before change" }, ctx);
    assert.equal(first.isError, undefined);
    const before = readCache();
    assert.deepEqual(before.search, { provider: "openai", model: "gpt-5.1" });
    assert.equal(before.fingerprint, fingerprintAvailableModels(ctx));

    availableModels.push(deepseek);
    calls.length = 0;

    const second = await runWebSearch({ query: "after change" }, ctx);
    assert.equal(second.isError, undefined);
    const output = JSON.parse(second.content[0].text);
    assert.equal(output.search.provider, "deepseek");
    assert.deepEqual(calls.map((call) => call.url), [DEEPSEEK_SEARCH_URL]);

    const after = readCache();
    assert.deepEqual(after.search, {
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.equal(after.fingerprint, fingerprintAvailableModels(ctx));
    assert.deepEqual(JSON.parse(readFileSync(temp.path, "utf8")), after);
  });
});

test("all providers failing returns a tool error listing every attempt", async (t) => {
  await withTempCache(async () => {
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels: [openaiResponsesModel(), deepseekModel()],
    });
    mockFetch(t, ({ url }) => {
      if (url === OPENAI_RESPONSES_URL) {
        return jsonResponse({ error: { message: "openai exploded" } }, 500, "Internal Server Error");
      }
      if (url === DEEPSEEK_SEARCH_URL) {
        return jsonResponse({ error: { message: "deepseek exploded" } }, 500, "Internal Server Error");
      }
      return unexpected(url);
    });

    const result = await runWebSearch({ query: "nothing works" }, ctx);
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /^Failed: Web search failed\./);
    assert.match(text, /deepseek\/deepseek-chat/);
    assert.match(text, /openai\/gpt-5\.1/);
    assert.match(text, /deepseek exploded/);
    assert.match(text, /openai exploded/);
    assert.deepEqual(
      result.details.attempts.map((attempt) => attempt.provider).sort(),
      ["deepseek", "openai"],
    );
    assert.equal(result.details.attempts.every((attempt) => attempt.phase === "search"), true);
  });
});

test("URL-only requests use DeepSeek Fetch and return the raw payload", async (t) => {
  await withTempCache(async () => {
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels: [deepseekModel()],
    });
    const page = {
      title: "Fetched page",
      content: "Raw page content",
      provider_extra: { preserved: true },
    };
    const calls = mockFetch(t, ({ url, body }) => {
      if (url === DEEPSEEK_FETCH_URL) {
        assert.deepEqual(body, { url: "https://example.com/page" });
        return jsonResponse(page);
      }
      return unexpected(url);
    });

    const result = await runWebSearch({ urls: ["https://example.com/page"] }, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      fetched: [
        {
          url: "https://example.com/page",
          provider: "deepseek",
          model: "deepseek-chat",
          data: page,
        },
      ],
    });
    assert.deepEqual(calls.map((call) => call.url), [DEEPSEEK_FETCH_URL]);
    const cache = readCache();
    assert.equal(cache.search, undefined);
    assert.deepEqual(cache.fetch, { provider: "deepseek", model: "deepseek-chat" });
  });
});

test("search and URL analysis may use different providers", async (t) => {
  await withTempCache(async () => {
    const openai = openaiResponsesModel();
    const deepseek = deepseekModel();
    const ctx = createMockCtx({
      model: openai,
      availableModels: [openai, deepseek],
    });
    const query = "mixed provider query";
    const call = openaiSearchCall(query);
    const fetchedPage = { title: "DeepSeek page", content: "DeepSeek content" };
    const calls = mockFetch(t, ({ url, body }) => {
      if (url === OPENAI_RESPONSES_URL) {
        assert.deepEqual(body, {
          model: "gpt-5.1",
          input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
          tools: [{ type: "web_search" }],
          include: ["web_search_call.action.sources", "web_search_call.results"],
          stream: true,
          store: false,
        });
        return sseResponse(openaiSearchEvents(query));
      }
      if (url === DEEPSEEK_FETCH_URL) {
        assert.deepEqual(body, { url: "https://example.com/page" });
        return jsonResponse(fetchedPage);
      }
      return unexpected(url);
    });

    const result = await runWebSearch(
      { query, urls: ["https://example.com/page"] },
      ctx,
    );
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.deepEqual(output.search, {
      provider: "openai",
      model: "gpt-5.1",
      answer: "OpenAI answer",
      results: [call],
      citations: [],
      searchQueries: [query],
    });
    assert.deepEqual(output.fetched, [
      {
        url: "https://example.com/page",
        provider: "deepseek",
        model: "deepseek-chat",
        data: fetchedPage,
      },
    ]);
    assert.deepEqual(calls.map((request) => request.url), [
      OPENAI_RESPONSES_URL,
      DEEPSEEK_FETCH_URL,
    ]);
    const cache = readCache();
    assert.deepEqual(cache.search, { provider: "openai", model: "gpt-5.1" });
    assert.deepEqual(cache.fetch, { provider: "deepseek", model: "deepseek-chat" });
  });
});

test("per-URL fetch fallback moves only the failed URL to the next provider", async (t) => {
  await withTempCache(async () => {
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels: [deepseekModel(), ollamaCloudModel()],
    });
    const okUrl = "https://example.com/ok";
    const failedUrl = "https://example.com/blocked";
    const deepseekCalls = [];
    const ollamaCalls = [];

    mockFetch(t, ({ url, body }) => {
      if (url === DEEPSEEK_FETCH_URL) {
        deepseekCalls.push(body.url);
        if (body.url === okUrl) {
          return jsonResponse({ title: "DeepSeek OK", content: "DeepSeek body" });
        }
        return jsonResponse({ error: { message: "DeepSeek blocked this URL" } }, 403);
      }
      if (url === OLLAMA_FETCH_URL) {
        ollamaCalls.push(body.url);
        return jsonResponse({
          title: "Ollama fallback",
          content: "Ollama body",
          links: ["https://example.com/next"],
        });
      }
      return unexpected(url);
    });

    const result = await runWebSearch({ urls: [okUrl, failedUrl] }, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text).fetched, [
      {
        url: okUrl,
        provider: "deepseek",
        model: "deepseek-chat",
        data: { title: "DeepSeek OK", content: "DeepSeek body" },
      },
      {
        url: failedUrl,
        provider: "ollama",
        model: "gpt-oss:120b",
        data: {
          title: "Ollama fallback",
          content: "Ollama body",
          links: ["https://example.com/next"],
        },
      },
    ]);
    assert.deepEqual(deepseekCalls, [okUrl, failedUrl]);
    assert.deepEqual(ollamaCalls, [failedUrl]);
    assert.equal(result.details.fetchedCount, 2);
    assert.deepEqual(result.details.fetchProviders, ["deepseek", "ollama"]);
  });
});

test("DeepSeek results are preserved exactly: duplicates, tracking params, .zip, and unknown fields", async (t) => {
  await withTempCache(async () => {
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels: [deepseekModel()],
    });
    const rawResults = [
      {
        rerank_score: 0.99,
        title: "First copy",
        url: "https://example.com/article?utm_source=newsletter&utm_medium=email",
        snippet: "First snippet",
        summary: "First summary",
        content: "First content",
        site_name: "Example",
        date: "2026-01-02",
        unknown_field: { nested: ["raw", 1, true] },
      },
      {
        rerank_score: 0.51,
        title: "Second copy of the same URL",
        url: "https://example.com/article?utm_source=newsletter&utm_medium=email",
        snippet: "Deliberately duplicated URL",
      },
      {
        rerank_score: 0.12,
        title: "Zip archive",
        url: "https://example.com/files/bundle.zip?utm_campaign=download",
        site_name: "Files",
      },
    ];
    mockFetch(t, ({ url }) => {
      if (url === DEEPSEEK_SEARCH_URL) return jsonResponse({ results: rawResults });
      return unexpected(url);
    });

    const result = await runWebSearch({ query: "raw preservation" }, ctx);
    assert.equal(result.isError, undefined);
    const output = JSON.parse(result.content[0].text);
    assert.deepEqual(output.search.results, rawResults);
    assert.equal(output.search.results.length, 3);
    assert.equal(result.details.resultCount, 3);
    assert.doesNotMatch(result.content[0].text, /## Sources/);
    assert.doesNotMatch(result.content[0].text, /Additional Search Results/);
    assert.doesNotMatch(result.content[0].text, /Additional results/);
  });
});

test("oversized output is truncated at the configured character limit", async (t) => {
  await withTempCache(async () => {
    const ctx = createMockCtx({
      model: unsupportedLocalModel(),
      availableModels: [deepseekModel()],
    });
    const hugeContent = "x".repeat(MAX_OUTPUT_CHARS + 5_000);
    mockFetch(t, ({ url }) => {
      if (url === DEEPSEEK_SEARCH_URL) {
        return jsonResponse({
          results: [{ title: "Huge", content: hugeContent }],
        });
      }
      return unexpected(url);
    });

    const result = await runWebSearch({ query: "huge output" }, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.truncated, true);
    assert.ok(Array.from(result.content[0].text).length <= MAX_OUTPUT_CHARS);
    assert.ok(result.content[0].text.endsWith("[Truncated]"));
    assert.match(result.content[0].text, /^\{\n {2}"query": "huge output",/);
  });
});

test("extension registers one tool, adds no system-prompt hooks, and returns undefined", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);

  const pi = createMockPi();
  pi.setActiveTools(["read"]);
  assert.equal(piBetterWebSearch(pi), undefined);
  assert.equal(pi.tools.size, 1);

  const tool = pi.tools.get(WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.name, WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.description, "Search the web or analyze specified URLs.");
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(tool.prepareLoadout, undefined);
  assert.deepEqual(
    [...pi.handlers.keys()].sort(),
    ["before_agent_start", "model_select", "session_start", "session_tree"],
  );

  const ctx = createMockCtx({
    model: unsupportedLocalModel(),
    availableModels: [deepseekModel()],
  });
  const handler = pi.handlers.get("before_agent_start")[0];
  assert.equal(handler({ type: "before_agent_start" }, ctx), undefined);
  assert.equal(pi.tools.size, 1);
  assert.ok(pi.getActiveTools().includes(WEB_SEARCH_TOOL_NAME));
  assert.equal(handler({ type: "before_agent_start" }, ctx), undefined);
  assert.equal(pi.tools.size, 1);
});

test("lib contains no forbidden result post-processing helpers", () => {
  const forbidden = [
    "sanitize",
    "normalizeSearchUrl",
    "isLikelyJunkSearchUrl",
    "deriveSources",
    "normalizeCitedSources",
    "applyCitations",
    "applyIndexCitations",
    "applyTextCitations",
    "preserveInlineCitations",
    "mergeSearchResultMetadata",
    "collectAdditionalSearchResults",
    "appendSources",
    "appendAdditionalResults",
    "appendUrlStatus",
    "resolveGoogleGroundingRedirectUrls",
    "titleFromUrl",
  ];
  const pattern = new RegExp(`\\b(?:${forbidden.join("|")})\\b`);
  const files = readdirSync(new URL("../lib/", import.meta.url), {
    recursive: true,
    encoding: "utf8",
  }).filter((file) => file.endsWith(".ts"));

  for (const file of files) {
    const source = readFileSync(new URL(`../lib/${file.replaceAll("\\", "/")}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, pattern, file);
  }
});
