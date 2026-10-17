import test from "node:test";
import assert from "node:assert/strict";

import { openaiAdapter, xaiAdapter } from "../src/providers/openai.ts";
import {
  createMockCtx,
  createModel,
  openaiResponsesModel,
  xaiModel,
} from "./helpers.mjs";

const OPENAI_CODEX_TOKEN = [
  "eyJhbGciOiJub25lIn0",
  "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0In0sIm5vdGUiOiLguJrguLHguI3guIrguLU_MTAifQ",
  "signature",
].join(".");

function sse(events) {
  return events.map(({ event, data }) => {
    const name = event ? `event: ${event}\n` : "";
    return `${name}data: ${JSON.stringify(data)}\n\n`;
  }).join("");
}

function makeResponse(events, init = {}) {
  return new Response(sse(events), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    headers: { "content-type": "text/event-stream", ...(init.headers ?? {}) },
  });
}

function searchCall(id, query, sources = [], status = "completed") {
  return {
    type: "web_search_call",
    id,
    status,
    action: { type: "search", query, queries: [query], sources },
  };
}

function citation(url, title = "result") {
  return {
    type: "url_citation",
    start_index: 0,
    end_index: 4,
    url_citation: { title, url },
  };
}

function completed(calls, annotations = [], text = "") {
  return {
    type: "response.completed",
    response: {
      output: [
        ...calls,
        {
          type: "message",
          content: [{ type: "output_text", text, annotations }],
        },
      ],
    },
  };
}

test("adapters expose the final OpenAI and xAI identities", () => {
  assert.deepEqual(
    {
      family: openaiAdapter.family,
      label: openaiAdapter.label,
      supportsSearch: openaiAdapter.supportsSearch,
      supportsUrls: openaiAdapter.supportsUrls,
      fetch: typeof openaiAdapter.fetch,
    },
    { family: "openai", label: "OpenAI", supportsSearch: true, supportsUrls: false, fetch: "undefined" },
  );
  assert.deepEqual(
    {
      family: xaiAdapter.family,
      label: xaiAdapter.label,
      supportsSearch: xaiAdapter.supportsSearch,
      supportsUrls: xaiAdapter.supportsUrls,
      fetch: typeof xaiAdapter.fetch,
    },
    { family: "xai", label: "xAI", supportsSearch: true, supportsUrls: false, fetch: "undefined" },
  );
});

test("OpenAI Responses sends the raw web search request and returns raw provider data", async (t) => {
  const first = searchCall("ws_first", "OpenAI docs", [
    { type: "url", title: "First", url: "https://first.example/" },
    { type: "url", title: "First duplicate", url: "https://first.example/" },
  ]);
  first.action.queries = ["OpenAI docs", "OpenAI docs"];
  const second = searchCall("ws_second", "OpenAI docs", [
    { type: "url", title: "First duplicate", url: "https://first.example/" },
  ]);
  const firstCitation = citation("https://first.example/", "First");
  const secondCitation = citation("https://second.example/", "Second");

  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return makeResponse([
      {
        data: {
          type: "response.output_item.added",
          item: {
            type: "web_search_call",
            id: "ws_first",
            status: "in_progress",
            action: { type: "search", query: "stale query" },
          },
        },
      },
      { data: { type: "response.web_search_call.searching", item_id: "ws_first" } },
      { data: { type: "response.output_text.delta", delta: "OpenAI answer" } },
      { data: { type: "response.output_text.annotation.added", annotation: firstCitation } },
      { data: { type: "response.output_item.done", item: first } },
      { data: { type: "response.web_search_call.completed", item_id: "ws_first" } },
      { data: { type: "response.output_item.done", item: second } },
      { data: completed([first, second], [secondCitation], "OpenAI answer") },
    ]);
  });

  const model = openaiResponsesModel();
  const result = await openaiAdapter.search(
    createMockCtx({ model, auth: { ok: true, apiKey: "test-key" } }),
    model,
    "OpenAI docs",
    undefined,
  );

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers.authorization, "Bearer test-key");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.accept, "text/event-stream");
  assert.deepEqual(request.body, {
    model: "gpt-5.1",
    input: [{ role: "user", content: [{ type: "input_text", text: "OpenAI docs" }] }],
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources", "web_search_call.results"],
    stream: true,
    store: false,
  });
  assert.equal(Object.hasOwn(request.body, "reasoning"), false);
  assert.equal(Object.hasOwn(request.body, "instructions"), false);
  assert.equal(Object.hasOwn(request.body, "tool_choice"), false);
  assert.equal(Object.hasOwn(request.body, "parallel_tool_calls"), false);

  assert.equal(result.answer, "OpenAI answer");
  assert.deepEqual(result.results, [first, second]);
  assert.deepEqual(result.citations, [firstCitation, secondCitation]);
  assert.deepEqual(result.searchQueries, ["OpenAI docs", "OpenAI docs", "OpenAI docs"]);
  assert.equal(Object.hasOwn(result, "sources"), false);
  assert.equal(result.results[0].action.sources.length, 2);
});

test("stream search items replace the previous raw item for the same call id", async (t) => {
  const added = searchCall("ws_merge", "first query", [{ type: "url", url: "https://first.example/" }], "searching");
  const done = searchCall("ws_merge", "latest query", [{ type: "url", url: "https://latest.example/" }]);
  const failed = searchCall("ws_failed", "failed query", [], "failed");

  t.mock.method(globalThis, "fetch", async () => makeResponse([
    { data: { type: "response.output_item.added", item: added } },
    { data: { type: "response.output_item.done", item: done } },
    { data: completed([done, failed]) },
  ]));

  const model = openaiResponsesModel();
  const result = await openaiAdapter.search(
    createMockCtx({ model }),
    model,
    "merge queries",
    undefined,
  );

  assert.deepEqual(result.results, [done, failed]);
  assert.deepEqual(result.searchQueries, ["latest query", "failed query"]);
  assert.equal(result.citations.length, 0);
});

test("Codex Responses uses Codex routing, account headers, and stops at completion", async (t) => {
  const call = searchCall("ws_codex", "Codex web search");
  let request;
  let cancelled = false;
  let timeout;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse([
          { data: { type: "response.web_search_call.in_progress", item_id: "ws_codex" } },
          { data: { type: "response.output_text.delta", delta: "Codex answer" } },
          { data: { type: "response.web_search_call.completed", item_id: "ws_codex" } },
          { data: { type: "response.done", response: { output: [call] } } },
        ])));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const model = createModel({
    id: "gpt-5.5",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  });

  try {
    const result = await Promise.race([
      openaiAdapter.search(
        createMockCtx({ model, auth: { ok: true, apiKey: OPENAI_CODEX_TOKEN } }),
        model,
        "Search with Codex",
        undefined,
      ),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex stream did not stop")), 500);
      }),
    ]);

    assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(request.headers.authorization, `Bearer ${OPENAI_CODEX_TOKEN}`);
    assert.equal(request.headers["chatgpt-account-id"], "acct_test");
    assert.equal(request.headers.originator, "codex_cli_rs");
    assert.equal(Object.keys(request.headers).some((key) => key.toLowerCase() === "openai-beta"), false);
    assert.deepEqual(request.body, {
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "Search with Codex" }] }],
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      stream: true,
      store: false,
      instructions: "Answer the user's request using web search when needed.",
      text: { verbosity: "low" },
      tool_choice: "required",
      parallel_tool_calls: true,
    });
    assert.equal(Object.hasOwn(request.body, "reasoning"), false);
    assert.equal(result.answer, "Codex answer");
    assert.deepEqual(result.results, [call]);
    assert.deepEqual(result.searchQueries, ["Codex web search"]);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeout);
  }
});

test("Codex Responses preserves explicit model and auth headers", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers };
    return makeResponse([
      { data: { type: "response.output_text.delta", delta: "Headers preserved" } },
      { data: completed([searchCall("ws_headers", "headers query")]) },
    ]);
  });

  const model = createModel({
    id: "gpt-5.5",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    headers: {
      Authorization: "Bearer explicit-auth",
      Originator: "custom-originator",
      accept: "application/x-test-stream",
    },
  });
  const ctx = createMockCtx({
    model,
    auth: {
      ok: true,
      headers: {
        "ChatGPT-Account-ID": "explicit-account",
        "openai-beta": "custom-beta",
      },
    },
  });

  const result = await openaiAdapter.search(ctx, model, "headers", undefined);

  assert.equal(request.headers.authorization, "Bearer explicit-auth");
  assert.equal(request.headers["chatgpt-account-id"], "explicit-account");
  assert.equal(request.headers.originator, "custom-originator");
  assert.equal(request.headers.accept, "application/x-test-stream");
  assert.equal(request.headers["openai-beta"], "custom-beta");
  assert.equal(result.answer, "Headers preserved");
});

test("Codex Responses rejects missing credentials and invalid account tokens", async (t) => {
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetched = true;
    return makeResponse([]);
  });

  const model = createModel({
    id: "gpt-5.5",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  });

  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model, auth: { ok: true } }), model, "q", undefined),
    /No OAuth credential configured for openai-codex model/,
  );
  assert.equal(fetched, false);

  await assert.rejects(
    openaiAdapter.search(
      createMockCtx({ model, auth: { ok: true, apiKey: "not-a-jwt" } }),
      model,
      "q",
      undefined,
    ),
    /Failed to extract ChatGPT account ID from openai-codex credentials/,
  );
  assert.equal(fetched, false);
});

test("Azure-like Responses base URLs append /responses", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return makeResponse([
      { data: completed([searchCall("ws_azure", "azure query")]) },
    ]);
  });

  const model = createModel({
    id: "gpt-5.6-terra",
    provider: "azure-openai",
    api: "azure-openai-responses",
    baseUrl: "https://example-resource.cognitiveservices.azure.com/openai/v1/",
  });

  const result = await openaiAdapter.search(
    createMockCtx({ model, auth: { ok: true, apiKey: "entra-token" } }),
    model,
    "Azure query",
    undefined,
  );

  assert.equal(request.url, "https://example-resource.cognitiveservices.azure.com/openai/v1/responses");
  assert.equal(request.headers.authorization, "Bearer entra-token");
  assert.equal(request.body.model, "gpt-5.6-terra");
  assert.equal(result.answer, "");
});

test("GitHub Copilot uses credential-specific and legacy proxy base URLs", async (t) => {
  const requestedUrls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrls.push(url);
    return makeResponse([
      { data: completed([searchCall(`ws_${requestedUrls.length}`, "copilot query")]) },
    ]);
  });

  const model = createModel({
    id: "gpt-5.6-sol",
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
  });

  await openaiAdapter.search(
    createMockCtx({
      model,
      auth: {
        ok: true,
        apiKey: "copilot-token",
        baseUrl: "https://api.business.githubcopilot.com",
      },
    }),
    model,
    "Copilot query",
    undefined,
  );

  for (const proxyEndpoint of [
    "proxy.business.githubcopilot.com",
    "proxy.individual.githubcopilot.com",
  ]) {
    await openaiAdapter.search(
      createMockCtx({
        model,
        auth: {
          ok: true,
          apiKey: `tid=test;proxy-ep=${proxyEndpoint};exp=9999999999`,
        },
      }),
      model,
      "Copilot query",
      undefined,
    );
  }

  assert.deepEqual(requestedUrls, [
    "https://api.business.githubcopilot.com/responses",
    "https://api.business.githubcopilot.com/responses",
    "https://api.individual.githubcopilot.com/responses",
  ]);
});

test("GitHub Copilot rejects unsafe legacy proxy endpoints", async (t) => {
  const requestedUrls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrls.push(url);
    return makeResponse([
      { data: completed([searchCall("ws_unsafe", "unsafe proxy")]) },
    ]);
  });

  const model = createModel({
    id: "gpt-5.6-sol",
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
  });

  for (const token of [
    "tid=test;exp=9999999999",
    "tid=test;proxy-ep=evil.example.com;exp=9999999999",
    "tid=test;proxy-ep=proxy.business.githubcopilot.com.evil.example;exp=9999999999",
    "tid=test;proxy-ep=proxy.business.githubcopilot.com/path;exp=9999999999",
    "tid=test;proxy-ep=proxy.business.githubcopilot.com;proxy-ep=proxy.individual.githubcopilot.com;exp=9999999999",
  ]) {
    await openaiAdapter.search(
      createMockCtx({ model, auth: { ok: true, apiKey: token } }),
      model,
      "Unsafe proxy",
      undefined,
    );
  }

  assert.equal(requestedUrls.length, 5);
  assert.ok(requestedUrls.every((url) => url === "https://api.individual.githubcopilot.com/responses"));
});

test("non-Copilot Responses ignores proxy endpoint text and auth base URLs", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers };
    return makeResponse([
      { data: completed([searchCall("ws_non_copilot", "openai query")]) },
    ]);
  });

  const model = openaiResponsesModel({ baseUrl: "https://example.test/v1" });
  await openaiAdapter.search(
    createMockCtx({
      model,
      auth: {
        ok: true,
        apiKey: "tid=test;proxy-ep=proxy.business.githubcopilot.com;exp=9999999999",
        baseUrl: "https://api.business.githubcopilot.com",
      },
    }),
    model,
    "OpenAI query",
    undefined,
  );

  assert.equal(request.url, "https://example.test/v1/responses");
  assert.equal(request.headers.authorization.startsWith("Bearer tid=test"), true);
});

test("OpenCode Responses calls include the pi session headers", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers };
    return makeResponse([
      { data: completed([searchCall("ws_opencode", "opencode query")]) },
    ]);
  });

  const model = createModel({
    id: "gpt-5.6-luna",
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  const ctx = createMockCtx({
    model,
    auth: { ok: true, apiKey: "opencode-go-key" },
    sessionId: "session-abc",
  });

  await openaiAdapter.search(ctx, model, "OpenCode query", undefined);

  assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(request.headers["x-opencode-session"], "session-abc");
  assert.equal(request.headers["x-opencode-client"], "pi");
});

test("xAI uses the Grok dialect and preserves inline citations without adding markers", async (t) => {
  const call = searchCall("ws_xai", "Search xAI docs", [
    { type: "url", title: "xAI docs", url: "https://docs.x.ai/" },
  ]);
  const annotation = {
    type: "url_citation",
    start_index: 14,
    end_index: 40,
    title: "1",
    url: "https://docs.x.ai/",
  };

  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return makeResponse([
      { data: { type: "response.web_search_call.searching", item_id: "ws_xai" } },
      { data: { type: "response.output_item.done", item: call } },
      { data: { type: "response.output_text.delta", delta: "xAI answer[[1]](https://docs.x.ai/)" } },
      { data: { type: "response.output_text.annotation.added", annotation } },
      { data: completed([call], [annotation], "xAI answer[[1]](https://docs.x.ai/)") },
    ]);
  });

  const model = xaiModel({ id: "grok-4.6" });
  const result = await xaiAdapter.search(
    createMockCtx({ model, auth: { ok: true, apiKey: "xai-test-key" } }),
    model,
    "Search xAI docs",
    undefined,
  );

  assert.equal(request.url, "https://api.x.ai/v1/responses");
  assert.equal(request.headers.authorization, "Bearer xai-test-key");
  assert.deepEqual(request.body.input, [{ role: "user", content: "Search xAI docs" }]);
  assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
  assert.deepEqual(request.body.include, ["web_search_call.action.sources"]);
  assert.equal(request.body.include.includes("web_search_call.results"), false);
  assert.equal(Object.hasOwn(request.body, "reasoning"), false);
  assert.equal(result.answer, "xAI answer[[1]](https://docs.x.ai/)");
  assert.deepEqual(result.results, [call]);
  assert.deepEqual(result.citations, [annotation, annotation]);
  assert.deepEqual(result.searchQueries, ["Search xAI docs"]);
  assert.equal(Object.hasOwn(result, "sources"), false);
});

test("compat.webSearchDialect overrides default dialect detection", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return makeResponse([
      { data: completed([searchCall(`ws_${bodies.length}`, "dialect query")]) },
    ]);
  });

  const gateway = {
    provider: "custom-gateway",
    api: "openai-responses",
    baseUrl: "https://gateway.example.com/v1",
  };
  const openaiShape = {
    input: [{ role: "user", content: [{ type: "input_text", text: "q" }] }],
    include: ["web_search_call.action.sources", "web_search_call.results"],
  };
  const grokShape = {
    input: [{ role: "user", content: "q" }],
    include: ["web_search_call.action.sources"],
  };
  const cases = [
    ["gateway grok id opted out", openaiAdapter, createModel({ ...gateway, id: "grok-4.6", compat: { webSearchDialect: "openai" } }), openaiShape],
    ["native xai opted out", xaiAdapter, xaiModel({ id: "grok-4.6", compat: { webSearchDialect: "openai" } }), openaiShape],
    ["non-Grok id opted in", openaiAdapter, createModel({ ...gateway, id: "gpt-6-astra", compat: { webSearchDialect: "grok" } }), grokShape],
    ["prefixed id opted in", openaiAdapter, createModel({ ...gateway, id: "x-ai/grok-4", compat: { webSearchDialect: "grok" } }), grokShape],
    ["prefixed id is not matched by default", openaiAdapter, createModel({ ...gateway, id: "x-ai/grok-4" }), openaiShape],
    ["grok substring is not matched by default", openaiAdapter, createModel({ ...gateway, id: "grokking-model" }), openaiShape],
    ["unknown override is ignored", openaiAdapter, createModel({ ...gateway, id: "grok-4.6", compat: { webSearchDialect: "bogus" } }), grokShape],
  ];

  for (const [label, adapter, model, expected] of cases) {
    const result = await adapter.search(
      createMockCtx({ model, auth: { ok: true, apiKey: "test-key" } }),
      model,
      "q",
      undefined,
    );
    assert.deepEqual(
      { input: bodies.at(-1).input, include: bodies.at(-1).include },
      expected,
      label,
    );
    assert.equal(result.answer, "", label);
  }
});

test("no-search streams throw a clear provider-specific error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => makeResponse([
    { data: { type: "response.output_text.delta", delta: "Answer without searching" } },
    { data: { type: "response.completed", response: { output: [] } } },
  ]));

  const openai = openaiResponsesModel();
  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model: openai }), openai, "no search", undefined),
    /OpenAI did not perform a web search/,
  );

  const xai = xaiModel({ id: "grok-4.6" });
  await assert.rejects(
    xaiAdapter.search(createMockCtx({ model: xai }), xai, "no search", undefined),
    /xAI did not perform a web search/,
  );
});

test("citation-only streams are accepted as search evidence", async (t) => {
  const annotation = citation("https://citation.example/");
  t.mock.method(globalThis, "fetch", async () => makeResponse([
    { data: { type: "response.output_text.delta", delta: "Citation only" } },
    { data: { type: "response.output_text.annotation.added", annotation } },
    { data: { type: "response.completed", response: { output: [] } } },
  ]));

  const model = openaiResponsesModel();
  const result = await openaiAdapter.search(
    createMockCtx({ model }),
    model,
    "citation only",
    undefined,
  );

  assert.equal(result.answer, "Citation only");
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.citations, [annotation]);
  assert.deepEqual(result.searchQueries, []);
});

test("all-failed search calls throw", async (t) => {
  t.mock.method(globalThis, "fetch", async () => makeResponse([
    {
      data: {
        type: "response.completed",
        response: {
          output: [
            searchCall("ws_failed_1", "failed one", [], "failed"),
            searchCall("ws_failed_2", "failed two", [], "failed"),
          ],
        },
      },
    },
  ]));

  const model = openaiResponsesModel();
  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model }), model, "failed search", undefined),
    /OpenAI web search failed/,
  );
});

test("HTTP and SSE errors are surfaced", async (t) => {
  let requestIndex = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requestIndex++;
    if (requestIndex === 1) {
      return new Response(JSON.stringify({ error: { message: "bad search request" } }), {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      });
    }
    if (requestIndex === 2) {
      return makeResponse([
        { data: { type: "error", error: { message: "SSE error message" } } },
      ]);
    }
    return makeResponse([
      { data: { type: "response.failed", response: { error: { message: "response failed message" } } } },
    ]);
  });

  const model = openaiResponsesModel();
  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model }), model, "HTTP error", undefined),
    /OpenAI API error \(400 Bad Request\): bad search request/,
  );
  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model }), model, "SSE error", undefined),
    /SSE error message/,
  );
  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model }), model, "failed response", undefined),
    /response failed message/,
  );
});

test("abort signals are passed to fetch and stop the stream", async (t) => {
  const controller = new AbortController();
  let receivedSignal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    receivedSignal = init.signal;
    controller.abort();
    return makeResponse([
      { data: { type: "response.output_text.delta", delta: "should not be read" } },
      { data: completed([searchCall("ws_abort", "abort query")]) },
    ]);
  });

  const model = openaiResponsesModel();
  await assert.rejects(
    openaiAdapter.search(createMockCtx({ model }), model, "abort", controller.signal),
    /aborted/i,
  );
  assert.equal(receivedSignal, controller.signal);
});
