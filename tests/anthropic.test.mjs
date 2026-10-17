import test from "node:test";
import assert from "node:assert/strict";

import { anthropicAdapter } from "../lib/providers/anthropic.ts";
import { anthropicModel, createMockCtx } from "./helpers.mjs";

const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 10,
  allowed_callers: ["direct"],
};

function sse(events) {
  return events
    .map(({ event, data }) => {
      const name = event ? `event: ${event}\n` : "";
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      return `${name}data: ${payload}\n\n`;
    })
    .join("");
}

function sseResponse(events, init = {}) {
  return new Response(sse(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

function jsonResponse(body, { status = 200, statusText = "", headers = {} } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json", ...headers },
  });
}

function bodyOf(init) {
  return JSON.parse(init.body);
}

function citation(url, citedText = "cited text") {
  return {
    type: "web_search_result_location",
    cited_text: citedText,
    title: "OpenAI docs",
    url,
    encrypted_index: "abc",
  };
}

test("anthropicAdapter advertises Anthropic search without URL fetching", () => {
  assert.equal(anthropicAdapter.family, "anthropic");
  assert.equal(anthropicAdapter.label, "Anthropic");
  assert.equal(anthropicAdapter.supportsSearch, true);
  assert.equal(anthropicAdapter.supportsUrls, false);
  assert.equal(anthropicAdapter.fetch, undefined);
});

test("search sends an exact API-key request and preserves explicit headers", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    captured = { url, init };
    return sseResponse([
      {
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "API key accepted" },
        },
      },
      {
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "citations_delta", citation: citation("https://platform.openai.com/docs") },
        },
      },
    ]);
  });

  const model = anthropicModel({
    id: "claude-test",
    provider: "opencode",
    baseUrl: "https://example.test/api/v1",
    maxTokens: 30_000,
    headers: { "x-model-header": "model" },
  });
  const ctx = createMockCtx({
    model,
    auth: {
      ok: true,
      apiKey: "sk-ant-api03-test",
      headers: { "x-auth-header": "auth" },
    },
    sessionId: "session-1",
  });

  const result = await anthropicAdapter.search(ctx, model, "Search OpenAI docs", undefined);

  assert.equal(captured.url, "https://example.test/api/v1/messages");
  assert.equal(captured.init.method, "POST");
  assert.deepEqual(bodyOf(captured.init), {
    model: "claude-test",
    max_tokens: 8_192,
    messages: [{ role: "user", content: "Search OpenAI docs" }],
    tools: [WEB_SEARCH_TOOL],
    stream: true,
  });
  assert.equal(bodyOf(captured.init).system, undefined);

  const headers = captured.init.headers;
  assert.equal(headers["x-api-key"], "sk-ant-api03-test");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(headers["x-model-header"], "model");
  assert.equal(headers["x-auth-header"], "auth");
  assert.equal(headers["x-opencode-session"], "session-1");
  assert.equal(headers["x-opencode-client"], "pi");
  assert.equal(result.answer, "API key accepted");
});

test("search sends Claude Code OAuth headers and the provider-level system prompt", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    captured = { url, init };
    return sseResponse([
      {
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "OAuth accepted" },
        },
      },
      {
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "citations_delta", citation: citation("https://example.test/source") },
        },
      },
    ]);
  });

  const model = anthropicModel({
    id: "claude-test",
    baseUrl: "https://api.anthropic.com",
    maxTokens: 4_096,
    headers: { "X-Custom": "yes" },
  });
  const ctx = createMockCtx({
    model,
    auth: {
      ok: true,
      apiKey: "sk-ant-oat01-test",
      headers: { "anthropic-beta": "custom-beta" },
    },
  });

  const result = await anthropicAdapter.search(ctx, model, "Search with OAuth", undefined);

  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  const body = bodyOf(captured.init);
  assert.deepEqual(body.system, [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ]);
  assert.equal(body.max_tokens, 1_365);
  assert.deepEqual(body.tools, [WEB_SEARCH_TOOL]);
  assert.deepEqual(body.messages, [{ role: "user", content: "Search with OAuth" }]);
  assert.equal(body.stream, true);

  const headers = captured.init.headers;
  assert.equal(headers.Authorization, "Bearer sk-ant-oat01-test");
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(
    headers["anthropic-beta"],
    "custom-beta,claude-code-20250219,oauth-2025-04-20",
  );
  assert.equal(headers["user-agent"], "claude-cli/2.1.280");
  assert.equal(headers["x-app"], "cli");
  assert.equal(headers["X-Custom"], "yes");
  assert.equal(result.answer, "OAuth accepted");
});

test("search returns raw search result blocks, citation deltas, and duplicate queries", async (t) => {
  const resultBlockOne = {
    type: "web_search_tool_result",
    tool_use_id: "srv_1",
    content: [
      {
        type: "web_search_result",
        title: "OpenAI docs",
        url: "https://platform.openai.com/docs/guides/tools-web-search",
        page_age: null,
        encrypted_content: "x",
      },
      {
        type: "web_search_result",
        title: "OpenAI docs duplicate",
        url: "https://platform.openai.com/docs/guides/tools-web-search",
        page_age: "2 days",
        encrypted_content: "y",
      },
    ],
  };
  const resultBlockTwo = {
    type: "web_search_tool_result",
    tool_use_id: "srv_2",
    content: [{
      type: "web_search_result",
      title: "OpenAI docs again",
      url: "https://platform.openai.com/docs/guides/tools-web-search",
      page_age: null,
      encrypted_content: "z",
    }],
  };
  const firstCitation = citation(
    "https://platform.openai.com/docs/guides/tools-web-search",
    "OpenAI docs",
  );
  const secondCitation = { ...firstCitation };

  t.mock.method(globalThis, "fetch", async () => sseResponse([
    {
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srv_1",
          name: "web_search",
          input: { query: "OpenAI docs" },
        },
      },
    },
    {
      data: {
        type: "content_block_start",
        index: 1,
        content_block: resultBlockOne,
      },
    },
    {
      data: {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "server_tool_use",
          id: "srv_2",
          name: "web_search",
          input: { query: "OpenAI docs" },
        },
      },
    },
    {
      data: {
        type: "content_block_start",
        index: 3,
        content_block: resultBlockTwo,
      },
    },
    {
      data: {
        type: "content_block_start",
        index: 4,
        content_block: { type: "text", text: "OpenAI docs explain " },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 4,
        delta: { type: "text_delta", text: "web search." },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 4,
        delta: { type: "citations_delta", citation: firstCitation },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 4,
        delta: { type: "citations_delta", citation: secondCitation },
      },
    },
  ]));

  const model = anthropicModel({ id: "claude-test" });
  const result = await anthropicAdapter.search(
    createMockCtx({ model }),
    model,
    "Search OpenAI docs",
    undefined,
  );

  assert.equal(result.answer, "OpenAI docs explain web search.");
  assert.doesNotMatch(result.answer, /\[\d+\]/);
  assert.doesNotMatch(result.answer, /Sources|Additional results/);
  assert.deepEqual(result.results, [resultBlockOne, resultBlockTwo]);
  assert.equal(result.results.length, 2);
  assert.equal(
    result.results[0].content[0].url,
    result.results[0].content[1].url,
    "duplicate result URLs must not be deduped",
  );
  assert.deepEqual(result.citations, [firstCitation, secondCitation]);
  assert.equal(result.citations.length, 2);
  assert.deepEqual(result.searchQueries, ["OpenAI docs", "OpenAI docs"]);
});

test("search extracts queries from streamed server_tool_use input without duplicating them", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    {
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srv_stream",
          name: "web_search",
          input: {},
        },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"Streamed ' },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'query"}' },
      },
    },
    { data: { type: "content_block_stop", index: 0 } },
    {
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srv_stream",
          content: [{
            type: "web_search_result",
            title: "Streamed",
            url: "https://example.test/streamed",
          }],
        },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "Streamed answer" },
      },
    },
  ]));

  const model = anthropicModel({ id: "claude-test" });
  const result = await anthropicAdapter.search(
    createMockCtx({ model }),
    model,
    "Streamed query",
    undefined,
  );

  assert.deepEqual(result.searchQueries, ["Streamed query"]);
  assert.equal(result.answer, "Streamed answer");
});

test("search throws HTTP errors with status and provider message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(
    { error: { type: "overloaded_error", message: "Upstream is overloaded" } },
    { status: 503, statusText: "Service Unavailable" },
  ));

  const model = anthropicModel({ id: "claude-test" });
  await assert.rejects(
    anthropicAdapter.search(createMockCtx({ model }), model, "Search", undefined),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /Anthropic API error/);
      assert.match(error.message, /503/);
      assert.match(error.message, /Upstream is overloaded/);
      return true;
    },
  );
});

test("search throws on SSE error events", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    {
      data: {
        type: "error",
        error: { type: "overloaded_error", message: "Stream failed upstream" },
      },
    },
  ]));

  const model = anthropicModel({ id: "claude-test" });
  await assert.rejects(
    anthropicAdapter.search(createMockCtx({ model }), model, "Search", undefined),
    /Stream failed upstream/,
  );
});

test("search throws on web_search_tool_result_error blocks", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    {
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srv_error",
          content: {
            type: "web_search_tool_result_error",
            error_code: "max_uses_exceeded",
          },
        },
      },
    },
  ]));

  const model = anthropicModel({ id: "claude-test" });
  await assert.rejects(
    anthropicAdapter.search(createMockCtx({ model }), model, "Search", undefined),
    (error) => {
      assert.match(error.message, /web_search_tool_result_error/);
      assert.match(error.message, /max_uses_exceeded/);
      return true;
    },
  );
});

test("search throws the fallback marker when Anthropic answers without searching", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    {
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "An answer without a search" },
      },
    },
  ]));

  const model = anthropicModel({ id: "claude-test" });
  await assert.rejects(
    anthropicAdapter.search(createMockCtx({ model }), model, "Search", undefined),
    { message: "Anthropic did not perform a web search" },
  );
});

test("search propagates the abort signal to fetch and stream reading", async (t) => {
  const controller = new AbortController();
  controller.abort();
  let seenSignal;

  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    seenSignal = init.signal;
    return sseResponse([
      {
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "citations_delta", citation: citation("https://example.test/aborted") },
        },
      },
    ]);
  });

  const model = anthropicModel({ id: "claude-test" });
  await assert.rejects(
    anthropicAdapter.search(
      createMockCtx({ model }),
      model,
      "Abort me",
      controller.signal,
    ),
    /abort/i,
  );
  assert.equal(seenSignal, controller.signal);
});
