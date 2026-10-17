import test from "node:test";
import assert from "node:assert/strict";
import { googleAdapter } from "../lib/providers/google.ts";
import { createMockCtx, googleModel, withEnv } from "./helpers.mjs";

function sse(events) {
  return events
    .map((event) => {
      const name = event.event ? `event: ${event.event}\n` : "";
      const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      return `${name}data: ${data}\n\n`;
    })
    .join("");
}

function jsonResponse(body, { status = 200, statusText = "", contentType = "application/json", headers = {} } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: {
      "content-type": contentType,
      ...headers,
    },
  });
}

function sseResponse(events, init) {
  return jsonResponse(sse(events), { ...init, contentType: "text/event-stream" });
}

function makeCtx(model, auth = { ok: true, apiKey: "test-api-key" }) {
  return createMockCtx({ model, auth });
}

test("googleAdapter advertises Gemini search and URL support", () => {
  assert.equal(googleAdapter.family, "google");
  assert.equal(googleAdapter.label, "Google");
  assert.equal(googleAdapter.supportsSearch, true);
  assert.equal(googleAdapter.supportsUrls, true);
  assert.equal(typeof googleAdapter.fetch, "function");
});

test("search falls back to the GEMINI_API_KEY environment variable", async (t) => {
  await withEnv({ GEMINI_API_KEY: "env-gemini-key" }, async () => {
    let captured;
    t.mock.method(globalThis, "fetch", async (url, init = {}) => {
      captured = { url, init };
      return sseResponse([
        {
          data: {
            candidates: [{
              content: { parts: [{ text: "Fallback auth accepted" }] },
              groundingMetadata: { webSearchQueries: ["fallback query"] },
            }],
          },
        },
      ]);
    });

    const model = googleModel({ id: "gemini-test" });
    const result = await googleAdapter.search(
      makeCtx(model, { ok: true }),
      model,
      "Search with fallback auth",
      undefined,
    );

    assert.equal(captured.init.headers["x-goog-api-key"], "env-gemini-key");
    assert.equal(result.answer, "Fallback auth accepted");
  });
});

test("search sends an exact google_search SSE request and returns raw grounding data", async (t) => {
  const groundingMetadata = {
    webSearchQueries: ["OpenAI docs"],
    groundingChunks: [{
      web: {
        title: "OpenAI docs",
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
      },
    }],
    groundingSupports: [{
      segment: { text: "Gemini grounded answer", endIndex: 22 },
      groundingChunkIndices: [0],
    }],
  };
  const calls = [];

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === "HEAD") {
      return new Response("", {
        status: 302,
        headers: { location: "https://platform.openai.com/docs" },
      });
    }
    return sseResponse([
      { data: { candidates: [{ content: { parts: [{ text: "Gemini grounded " }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: "answer" }] } }] } },
      { data: { candidates: [{ groundingMetadata }] } },
    ]);
  });

  const model = googleModel({
    id: "gemini-test",
    provider: "proxy-provider",
    baseUrl: "https://example.test/gemini/v1beta",
  });
  const result = await googleAdapter.search(
    makeCtx(model),
    model,
    "Search OpenAI docs",
    undefined,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].url,
    "https://example.test/gemini/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    contents: [{ role: "user", parts: [{ text: "Search OpenAI docs" }] }],
    tools: [{ google_search: {} }],
  });
  assert.equal(calls[0].init.headers["x-goog-api-key"], "test-api-key");

  assert.equal(result.answer, "Gemini grounded answer");
  assert.doesNotMatch(result.answer, /\[\d+\]/);
  assert.deepEqual(result.groundingMetadata, groundingMetadata);
  assert.deepEqual(result.results, groundingMetadata.groundingChunks);
  assert.deepEqual(result.citations, groundingMetadata.groundingSupports);
  assert.deepEqual(result.searchQueries, ["OpenAI docs"]);
  assert.equal(result.results[0].web.uri.includes("grounding-api-redirect"), true);
});

test("search accepts snake_case grounding metadata without rewriting it", async (t) => {
  const groundingMetadata = {
    web_search_queries: ["snake query"],
    grounding_chunks: [{ web: { title: "Snake", uri: "https://snake.test/page" } }],
    grounding_supports: [{ segment: { text: "Snake answer" }, grounding_chunk_indices: [0] }],
  };

  t.mock.method(globalThis, "fetch", async () => sseResponse([
    {
      data: {
        candidates: [{
          content: { parts: [{ text: "Snake answer" }] },
          grounding_metadata: groundingMetadata,
        }],
      },
    },
  ]));

  const model = googleModel({ id: "gemini-test" });
  const result = await googleAdapter.search(makeCtx(model), model, "Snake query", undefined);

  assert.deepEqual(result.groundingMetadata, groundingMetadata);
  assert.deepEqual(result.results, groundingMetadata.grounding_chunks);
  assert.deepEqual(result.citations, groundingMetadata.grounding_supports);
  assert.deepEqual(result.searchQueries, ["snake query"]);
  assert.equal(result.answer, "Snake answer");
});

test("search throws the fallback marker when Gemini returns no search evidence", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    { data: { candidates: [{ content: { parts: [{ text: "Ungrounded answer" }] } }] } },
  ]));

  const model = googleModel({ id: "gemini-test" });
  await assert.rejects(
    googleAdapter.search(makeCtx(model), model, "No grounding", undefined),
    (error) => {
      assert.equal(error.message, "Google Gemini did not perform a web search");
      return true;
    },
  );
});

test("search throws HTTP errors with status and provider message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(
    { error: { message: "Quota exceeded for this project" } },
    { status: 429, statusText: "Too Many Requests" },
  ));

  const model = googleModel({ id: "gemini-test" });
  await assert.rejects(
    googleAdapter.search(makeCtx(model), model, "Rate limited", undefined),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /429/);
      assert.match(error.message, /Quota exceeded/);
      return true;
    },
  );
});

test("search throws stream errors with status and message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    { data: { error: { code: 503, message: "Upstream stream unavailable" } } },
  ]));

  const model = googleModel({ id: "gemini-test" });
  await assert.rejects(
    googleAdapter.search(makeCtx(model), model, "Stream failure", undefined),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /503/);
      assert.match(error.message, /Upstream stream unavailable/);
      return true;
    },
  );
});

test("search propagates abort signals to fetch and stream reading", async (t) => {
  const controller = new AbortController();
  controller.abort();
  let seenSignal;

  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    seenSignal = init.signal;
    return sseResponse([
      {
        data: {
          candidates: [{
            content: { parts: [{ text: "Should not be read" }] },
            groundingMetadata: { webSearchQueries: ["aborted"] },
          }],
        },
      },
    ]);
  });

  const model = googleModel({ id: "gemini-test" });
  await assert.rejects(
    googleAdapter.search(makeCtx(model), model, "Abort me", controller.signal),
    /abort/i,
  );
  assert.equal(seenSignal, controller.signal);
});

test("fetch sends url_context with the URL-only default prompt and preserves per-URL statuses", async (t) => {
  const urls = [
    "https://example.com/one",
    "https://example.com/two",
    "https://example.com/missing",
  ];
  const urlContextMetadata = {
    urlMetadata: [
      {
        retrievedUrl: urls[0],
        urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
      },
      {
        retrievedUrl: urls[1],
        urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR",
      },
    ],
  };
  let captured;

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    captured = { url, init };
    return sseResponse([
      { data: { candidates: [{ content: { parts: [{ text: "Fetched page answer" }] } }] } },
      { data: { candidates: [{ urlContextMetadata }] } },
    ]);
  });

  const model = googleModel({ id: "gemini-test", baseUrl: "https://example.test/v1beta" });
  const result = await googleAdapter.fetch(
    makeCtx(model),
    model,
    urls,
    undefined,
    undefined,
  );

  assert.equal(
    captured.url,
    "https://example.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
  );
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.tools, [{ url_context: {} }]);
  assert.deepEqual(body.contents, [{
    role: "user",
    parts: [{ text: `Analyze the following URLs.\n\nURLs:\n${urls.join("\n")}` }],
  }]);

  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries[0], {
    url: urls[0],
    data: {
      answer: "Fetched page answer",
      groundingMetadata: undefined,
      urlContextMetadata,
    },
  });
  assert.deepEqual(result.entries[1], {
    url: urls[1],
    error: "URL_RETRIEVAL_STATUS_ERROR",
  });
  assert.deepEqual(result.entries[2], {
    url: urls[2],
    data: {
      answer: "Fetched page answer",
      groundingMetadata: undefined,
      urlContextMetadata,
    },
  });
  assert.equal(result.entries[0].data.urlContextMetadata, result.entries[2].data.urlContextMetadata);
});

test("fetch uses the query plus URLs prompt and accepts snake_case URL metadata", async (t) => {
  const urls = ["https://example.com/a", "https://example.com/b"];
  const urlContextMetadata = {
    url_metadata: [
      { retrieved_url: urls[0], url_retrieval_status: "URL_RETRIEVAL_STATUS_SUCCESS" },
      { retrieved_url: urls[1], url_retrieval_status: "URL_RETRIEVAL_STATUS_SUCCESS" },
    ],
  };
  let captured;

  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    captured = init;
    return sseResponse([
      { data: { candidates: [{ content: { parts: [{ text: "Compare " }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: "result" }] } }] } },
      { data: { candidates: [{ url_context_metadata: urlContextMetadata }] } },
    ]);
  });

  const model = googleModel({ id: "gemini-test" });
  const result = await googleAdapter.fetch(
    makeCtx(model),
    model,
    urls,
    "Compare these pages",
    undefined,
  );

  const body = JSON.parse(captured.body);
  assert.deepEqual(body.tools, [{ url_context: {} }]);
  assert.equal(
    body.contents[0].parts[0].text,
    `Compare these pages\n\nURLs:\n${urls.join("\n")}`,
  );
  assert.equal(result.entries.length, 2);
  for (const entry of result.entries) {
    assert.equal(entry.error, undefined);
    assert.equal(entry.data.answer, "Compare result");
    assert.deepEqual(entry.data.urlContextMetadata, urlContextMetadata);
  }
  assert.equal(result.entries[0].data.urlContextMetadata.url_metadata[0].retrieved_url, urls[0]);
});

test("fetch keeps YouTube file_data handling for google-generative-ai", async (t) => {
  const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const pageUrl = "https://example.com/page";
  let captured;

  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    captured = init;
    return sseResponse([
      {
        data: {
          candidates: [{
            content: { parts: [{ text: "Video and page summary" }] },
            urlContextMetadata: {
              urlMetadata: [
                { retrievedUrl: youtubeUrl, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
                { retrievedUrl: pageUrl, urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
              ],
            },
          }],
        },
      },
    ]);
  });

  const model = googleModel({ id: "gemini-test" });
  const result = await googleAdapter.fetch(
    makeCtx(model),
    model,
    [youtubeUrl, pageUrl],
    "Summarize these",
    undefined,
  );

  const body = JSON.parse(captured.body);
  assert.deepEqual(body.tools, [{ url_context: {} }]);
  assert.equal(body.contents[0].parts.length, 2);
  assert.deepEqual(body.contents[0].parts[0], {
    file_data: { file_uri: youtubeUrl, mime_type: "video/mp4" },
  });
  assert.deepEqual(body.contents[0].parts[1], {
    text: `Summarize these\n\nURLs:\n${pageUrl}`,
  });
  assert.deepEqual(result.entries.map((entry) => entry.url), [youtubeUrl, pageUrl]);
});

test("fetch throws when the model returns no answer and no metadata", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    { data: { candidates: [{ content: { parts: [] } }] } },
  ]));

  const model = googleModel({ id: "gemini-test" });
  await assert.rejects(
    googleAdapter.fetch(
      makeCtx(model),
      model,
      ["https://example.com/empty"],
      "Analyze",
      undefined,
    ),
    /no answer or URL context metadata/i,
  );
});

test("fetch throws global HTTP failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse(
    { error: { message: "URL context is unavailable" } },
    { status: 500, statusText: "Internal Server Error" },
  ));

  const model = googleModel({ id: "gemini-test" });
  await assert.rejects(
    googleAdapter.fetch(
      makeCtx(model),
      model,
      ["https://example.com/fail"],
      "Analyze",
      undefined,
    ),
    (error) => {
      assert.equal(error.status, 500);
      assert.match(error.message, /URL context is unavailable/);
      return true;
    },
  );
});

test("antigravity uses its fixed endpoint, JSON credential extraction, and wrapper body", async (t) => {
  let captured;

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    captured = { url, init };
    return sseResponse([
      {
        data: {
          candidates: [{
            content: { parts: [{ text: "Antigravity answer" }] },
            groundingMetadata: { webSearchQueries: ["antigravity search"] },
          }],
        },
      },
    ]);
  });

  const model = googleModel({
    id: "gemini-3.7-flash",
    provider: "antigravity",
    api: "antigravity",
    baseUrl: "https://ignored.test",
    headers: { "X-Custom-Header": "preserved" },
  });
  const auth = {
    ok: true,
    apiKey: JSON.stringify({ token: "antigravity-token", projectId: "project-123" }),
  };
  const result = await googleAdapter.search(makeCtx(model, auth), model, "Antigravity query", undefined);

  assert.equal(
    captured.url,
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer antigravity-token");
  assert.equal(captured.init.headers["x-goog-api-key"], undefined);
  assert.equal(captured.init.headers["X-Custom-Header"], "preserved");
  assert.equal(typeof captured.init.headers["Client-Metadata"], "string");
  assert.match(captured.init.headers["User-Agent"], /^antigravity\/hub\/2\.8\.0 /);

  assert.deepEqual(JSON.parse(captured.init.body), {
    project: "project-123",
    model: "gemini-3.7-flash-medium",
    request: {
      contents: [{ role: "user", parts: [{ text: "Antigravity query" }] }],
      tools: [{ google_search: {} }],
    },
    requestType: "AGENT",
    userAgent: "antigravity",
  });
  assert.equal(result.answer, "Antigravity answer");
});
