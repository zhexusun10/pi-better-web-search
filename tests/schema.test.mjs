import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  buildWebSearchSchema,
  buildWebSearchToolDescription,
  MAX_URL_LENGTH,
  MAX_URLS,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_QUERY_ONLY_DESCRIPTION,
} from "../lib/schema.ts";
import { parseWebSearchInput, runWebSearch, validateUrl } from "../lib/search.ts";
import { deepseekAdapter, DEEPSEEK_MAX_URL_LENGTH } from "../lib/providers/deepseek.ts";
import { createMockCtx, deepseekModel } from "./helpers.mjs";

const page = "https://example.com/page";

test("query-only schema never advertises unavailable URL or fetch operations", () => {
  const schema = buildWebSearchSchema({ allowUrls: false });
  assert.deepEqual(Object.keys(schema.properties), ["query"]);
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.properties.query.description, /triggers a web search/);
  assert.doesNotMatch(schema.properties.query.description, /\burls?\b|fetch|omit/i);
  assert.equal(Value.Check(schema, { query: "search" }), true);
  assert.equal(Value.Check(schema, { urls: [page] }), false);
  assert.equal(Value.Check(schema, { query: "search", urls: [page] }), false);
});

test("URL-capable descriptions distinguish independent search from URL-only fetching", () => {
  const schema = buildWebSearchSchema({ allowUrls: true });
  assert.deepEqual(Object.keys(schema.properties), ["query", "urls"]);
  assert.equal(schema.required, undefined);
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.properties.query.description, /separate web search/);
  assert.match(schema.properties.query.description, /Omit it when only fetching the supplied URLs\./);
  assert.match(schema.properties.urls.description, /HTTP\/HTTPS/);
  assert.match(schema.properties.urls.description, /alone without query/);
  assert.match(schema.properties.urls.description, /query.*separate web search/);
  assert.equal(schema.properties.urls.items.minLength, 1);
  assert.equal(schema.properties.urls.items.maxLength, MAX_URL_LENGTH);
  assert.equal(schema.properties.urls.minItems, 1);
  assert.equal(schema.properties.urls.maxItems, MAX_URLS);
  for (const input of [{ query: "search" }, { urls: [page] }, { query: "search", urls: [page] }]) {
    assert.equal(Value.Check(schema, input), true);
    assert.equal(parseWebSearchInput(input).ok, true);
  }
});

test("both variants keep the two-parameter contract and avoid incompatible top-level unions", () => {
  for (const allowUrls of [false, true]) {
    const schema = buildWebSearchSchema({ allowUrls });
    assert.equal(schema.anyOf, undefined);
    assert.equal(schema.oneOf, undefined);
    assert.equal(schema.properties.query.maxLength, undefined);
    assert.equal(buildWebSearchToolDescription({ allowUrls }), allowUrls ? WEB_SEARCH_DESCRIPTION : WEB_SEARCH_QUERY_ONLY_DESCRIPTION);
    // DeepSeek's 128-character query limit must not become a global limit.
    assert.equal(Value.Check(schema, { query: "q".repeat(129) }), true);
  }
  // The inclusive query-or-URLs requirement intentionally remains a runtime check.
  assert.equal(Value.Check(buildWebSearchSchema({ allowUrls: true }), {}), true);
  assert.equal(parseWebSearchInput({}).ok, false);
  assert.equal(parseWebSearchInput({ query: "   " }).ok, false);
});

test("tool descriptions teach evidence-aware use without advertising unavailable fetch", () => {
  const searchOnly = buildWebSearchToolDescription({ allowUrls: false });
  const withUrls = buildWebSearchToolDescription({ allowUrls: true });
  assert.notEqual(searchOnly, withUrls);
  assert.doesNotMatch(searchOnly, /\bfetch\b|specified URLs/i);
  assert.ok(withUrls.endsWith("Search excerpts may lack context; fetch relevant pages when needed to verify important details and cite the source URLs used. If the evidence is insufficient or conflicting, refine the query and search again."));
  assert.ok(searchOnly.endsWith("Search excerpts may lack context; verify important details against original sources when possible and cite the source URLs used. If the evidence is insufficient or conflicting, refine the query and search again."));
  for (const description of [searchOnly, withUrls]) {
    assert.equal(description.split(". ")[0], "Search the live web and return the most relevant URLs and content");
    assert.match(description, /current information, fact-checking, and documentation lookup/);
    assert.match(description, /excerpts may lack context/);
    assert.match(description, /cite the source URLs used/);
    assert.match(description, /If the evidence is insufficient or conflicting, refine the query and search again\./);
    assert.doesNotMatch(description, /Exa|Keenable|Python|API key|objective|at least twice/i);
  }
});

test("query guidance prefers natural language without imposing brevity or a global query limit", () => {
  for (const allowUrls of [false, true]) {
    const schema = buildWebSearchSchema({ allowUrls });
    const description = schema.properties.query.description;
    assert.match(description, /^Web search query\./);
    assert.doesNotMatch(description, /\bconcise\b/i);
    assert.match(description, /Prefer natural language describing the needed information/);
    assert.match(description, /relevant time scope and source preferences/);
    assert.doesNotMatch(description, /128|4096|must use natural language/i);
    assert.equal(schema.properties.query.maxLength, undefined);
    for (const query of ["site:example.com v4 flash", "latest official release notes", "q".repeat(4097)]) {
      assert.equal(Value.Check(schema, { query }), true);
      assert.equal(parseWebSearchInput({ query }).query, query);
    }
  }
  assert.match(buildWebSearchSchema({ allowUrls: true }).properties.urls.description, /read known pages or verify search results/);
});

test("schema and runtime reject unknown fields instead of silently accepting routing controls", () => {
  for (const key of ["model", "provider", "mode", "limit", "objective", "numResults", "contents", "category", "constructor", "__proto__", ""]) {
    const input = { query: "search", [key]: "extra" };
    for (const allowUrls of [false, true]) {
      assert.equal(Value.Check(buildWebSearchSchema({ allowUrls }), input), false, key);
    }
    const parsed = parseWebSearchInput(input);
    assert.equal(parsed.ok, false, key);
    assert.match(parsed.error, /Unknown argument/);
    assert.ok(parsed.error.includes(JSON.stringify(key)));
  }
  const nullPrototype = Object.assign(Object.create(null), { urls: [page], mode: "fetch" });
  assert.equal(parseWebSearchInput(nullPrototype).ok, false);
});

test("unknown arguments fail before provider discovery or HTTP requests", async (t) => {
  const ctx = createMockCtx({ model: deepseekModel() });
  t.mock.method(ctx.modelRegistry, "getAvailable", () => assert.fail("must not discover providers"));
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("must not fetch"));
  const result = await runWebSearch({ query: "search", model: "deepseek-v9-pro" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown argument "model"/);
  assert.deepEqual(result.details.attempts, []);
  assert.equal(fetch.mock.callCount(), 0);
});

test("URL count, type and basic string bounds reject invalid standalone inputs", () => {
  const schema = buildWebSearchSchema({ allowUrls: true });
  for (const urls of [[], Array(MAX_URLS + 1).fill(page), [42], [""], ["x".repeat(MAX_URL_LENGTH + 1)]]) {
    assert.equal(Value.Check(schema, { urls }), false);
    assert.equal(parseWebSearchInput({ urls }).ok, false);
  }
  assert.equal(parseWebSearchInput({ query: "search", urls: [] }).ok, false);
  assert.equal(Value.Check(schema, { urls: Array(MAX_URLS).fill(page) }), true);
  assert.equal(parseWebSearchInput({ urls: Array(MAX_URLS).fill(page) }).ok, true);
});

test("schema, parser and native DeepSeek agree on ASCII and Unicode URL length boundaries", async (t) => {
  const schema = buildWebSearchSchema({ allowUrls: true });
  const ctx = createMockCtx({ model: deepseekModel() });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).url);
    return new Response(JSON.stringify({ content: "page" }));
  });
  assert.equal(DEEPSEEK_MAX_URL_LENGTH, MAX_URL_LENGTH);
  const prefix = "https://example.com/";
  for (const character of ["x", "😀"]) {
    const url = prefix + character.repeat(MAX_URL_LENGTH - prefix.length);
    const overlong = url + character;
    assert.equal(Value.Check(schema, { urls: [url] }), true);
    assert.equal(Value.Check(schema, { urls: [overlong] }), false);
    assert.equal(validateUrl(url), undefined);
    assert.match(validateUrl(overlong), /8192/);
    assert.equal(parseWebSearchInput({ urls: [url] }).ok, true);
    assert.equal(parseWebSearchInput({ urls: [overlong] }).ok, false);
    const result = await deepseekAdapter.fetch(ctx, ctx.model, [url, overlong], undefined, undefined);
    assert.deepEqual(result.entries[0].data, { content: "page" });
    assert.match(result.entries[1].error, /8192/);
  }
  assert.equal(sent.length, 2);
});

test("URL validation still rejects unsafe schemes and credentials without dropping valid work", () => {
  const input = { urls: [page, "ftp://example.com/file", "https://user:pass@example.com/private"] };
  const parsed = parseWebSearchInput(input);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.urls, [page]);
  assert.equal(parsed.urlErrors.length, 2);
  assert.match(parsed.urlErrors[0].error, /http or https/);
  assert.match(parsed.urlErrors[1].error, /username or password/);
});
