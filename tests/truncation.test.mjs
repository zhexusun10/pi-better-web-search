import assert from "node:assert/strict";
import test from "node:test";

import { formatSuccess, MAX_OUTPUT_CHARS } from "../lib/format.ts";
import { formatJsonWithinLimit } from "../lib/truncate-json.ts";

const chars = (text) => Array.from(text).length;

function checkedFormat(output, limit) {
  const result = formatJsonWithinLimit(output, limit);
  assert.ok(chars(result.text) <= limit, `output exceeds ${limit} code points`);
  const parsed = JSON.parse(result.text);
  return { ...result, parsed };
}

test("complete JSON at and just below the default boundary is never truncated", () => {
  const baseLength = chars(JSON.stringify({ query: "" }, null, 2));
  for (const targetLength of [MAX_OUTPUT_CHARS - 13, MAX_OUTPUT_CHARS - 12, MAX_OUTPUT_CHARS - 1, MAX_OUTPUT_CHARS]) {
    const output = { query: "x".repeat(targetLength - baseLength) };
    const result = formatSuccess(output, { attempts: [] });
    assert.equal(chars(result.content[0].text), targetLength);
    assert.equal(result.details.truncated, undefined);
    assert.equal(result.content[0].text, JSON.stringify(output, null, 2));
  }
});

test("the limit counts emoji as one code point rather than two UTF-16 units", () => {
  const baseLength = chars(JSON.stringify({ query: "" }, null, 2));
  const output = { query: "😀".repeat(MAX_OUTPUT_CHARS - baseLength) };
  const result = formatSuccess(output, { attempts: [] });
  assert.equal(chars(result.content[0].text), MAX_OUTPUT_CHARS);
  assert.ok(result.content[0].text.length > MAX_OUTPUT_CHARS);
  assert.equal(result.details.truncated, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), output);
});

test("compact JSON avoids truncation when only indentation exceeds the budget", () => {
  const output = { query: "q", search: { results: [{ title: "first" }, { title: "second" }] } };
  const compact = JSON.stringify(output);
  const result = checkedFormat(output, chars(compact));
  assert.equal(result.truncated, false);
  assert.equal(result.text, compact);
  assert.deepEqual(result.parsed, output);
});

test("structured truncation shares space across searches and 20 fetched URLs", () => {
  const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/page-${i}`);
  const output = {
    query: "find sources",
    search: {
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `result-${i}`,
        url: `https://example.com/result-${i}`,
        content: "search".repeat(2_000),
      })),
    },
    fetched: urls.map((url, i) => i === 7
      ? { url, error: "blocked" }
      : { url, data: { title: `page-${i}`, content: "page".repeat(3_000) } }),
  };
  const result = checkedFormat(output, 64_000);
  assert.equal(result.truncated, true);
  assert.equal(result.parsed._truncation.truncated, true);
  assert.equal(result.parsed._truncation.originalChars, chars(JSON.stringify(output, null, 2)));
  assert.equal(result.parsed.search.results.length, 10);
  assert.deepEqual(result.parsed.fetched.map((entry) => entry.url), urls);
  assert.equal(result.parsed.fetched[7].error, "blocked");
  for (const [index, entry] of result.parsed.search.results.entries()) {
    assert.equal(entry.title, `result-${index}`);
    assert.equal(entry.url, `https://example.com/result-${index}`);
    assert.ok(entry.content.length > 100);
    assert.match(entry.content, /…\[truncated\]$/);
  }
  for (const [index, entry] of result.parsed.fetched.entries()) {
    if (index === 7) continue;
    assert.equal(entry.data.title, `page-${index}`);
    assert.ok(entry.data.content.length > 100);
    assert.match(entry.data.content, /…\[truncated\]$/);
    assert.ok(result.parsed._truncation.affectedPaths.includes(`$.fetched[${index}].data.content`));
  }
});

test("small siblings stay complete and unused space is redistributed", () => {
  const output = {
    fetched: [
      { url: "https://example.com/short", data: { content: "short" } },
      { url: "https://example.com/long", data: { content: "long".repeat(5_000) } },
    ],
  };
  const result = checkedFormat(output, 2_000);
  assert.equal(result.truncated, true);
  assert.equal(result.parsed.fetched[0].data.content, "short");
  assert.ok(result.parsed.fetched[1].data.content.length > 1_000);
  assert.ok(result.parsed._truncation.affectedPaths.includes("$.fetched[1].data.content"));
  assert.ok(!result.parsed._truncation.affectedPaths.includes("$.fetched[0].data.content"));
});

test("one oversized item does not crowd out complete small search results", () => {
  const output = {
    search: {
      results: [
        { title: "large", url: "https://example.com/large", content: "x".repeat(80_000) },
        ...Array.from({ length: 9 }, (_, i) => ({
          title: `small-${i}`,
          url: `https://example.com/${i}`,
          content: "short",
        })),
      ],
    },
    fetched: [{ url: "https://example.com/page", data: { content: "y".repeat(80_000) } }],
  };
  const result = checkedFormat(output, 64_000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.parsed.search.results.slice(1), output.search.results.slice(1));
  assert.ok(result.parsed.search.results[0].content.length > 10_000);
  assert.ok(result.parsed.fetched[0].data.content.length > 10_000);
});

test("JSON escaping, emoji and lone surrogates stay valid and within the limit", () => {
  const content = ('😀甲"\\\n\t\u0000' + "\ud800" + "z").repeat(1_000);
  const output = { fetched: [{ url: "https://example.com/", data: { content } }] };
  for (const limit of [180, 200, 256, 500, 1_000, 2_000, 4_000]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    const visible = result.parsed.fetched?.[0]?.data?.content;
    if (visible) {
      assert.ok(content.startsWith(visible.replace(/…(?:\[truncated\])?$/, "")));
    }
  }
});

test("omitted array entries and large numbers of changes are reported", () => {
  const output = {
    search: {
      results: Array.from({ length: 150 }, (_, i) => ({ title: `item-${i}`, content: "x".repeat(1_000) })),
    },
  };
  const many = checkedFormat(output, 20_000);
  assert.equal(many.truncated, true);
  assert.ok(many.parsed._truncation.affectedPaths.length <= 64);
  assert.equal(many.parsed._truncation.moreAffectedPaths, true);

  const tiny = checkedFormat(output, 300);
  assert.equal(tiny.truncated, true);
  assert.ok(tiny.parsed._truncation.affectedPaths.includes("$.search.results"));
  assert.ok(tiny.parsed.search.results.length < output.search.results.length);
});

test("very small configured budgets still return valid bounded JSON", () => {
  const output = { query: "large".repeat(1_000) };
  for (const limit of [1, 2, 18, 19, 33, 34, 80, 100, 150]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    if (limit >= 19) {
      assert.ok(result.parsed._truncated || result.parsed._truncation?.truncated);
    }
  }
  assert.throws(() => formatJsonWithinLimit(output, 0), RangeError);
});

test("configured limits are validated at module load", async () => {
  const original = process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
  try {
    for (const [value, expected] of [["12", 12], ["19", 19], ["0.4", 64_000], ["-1", 64_000], ["bad", 64_000]]) {
      process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS = value;
      const module = await import(`../lib/format.ts?truncation-test=${value}`);
      assert.equal(module.MAX_OUTPUT_CHARS, expected);
      const result = module.formatSuccess({ query: "x".repeat(70_000) }, { attempts: [] });
      assert.ok(chars(result.content[0].text) <= expected);
      assert.doesNotThrow(() => JSON.parse(result.content[0].text));
      assert.equal(result.details.truncated, true);
    }
  } finally {
    if (original === undefined) delete process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
    else process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS = original;
  }
});

test("unknown keys, including __proto__, cannot mutate object prototypes", () => {
  const raw = JSON.parse('{"query":"q","search":{"results":[{"__proto__":{"polluted":true},"spaced key":"' + "x".repeat(5_000) + '"}]}}');
  const result = checkedFormat(raw, 1_000);
  assert.equal(result.truncated, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result.parsed.search.results[0].__proto__, { polluted: true });
  assert.ok(result.parsed._truncation.affectedPaths.includes('$.search.results[0]["spaced key"]'));
});

test("varied nested JSON always fits and remains parseable", () => {
  let seed = 71_847;
  const random = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const alphabet = ["a", "😀", "甲", ...[0, 10, 13, 34, 92, 0xd800, 0xdc00].map((n) => String.fromCharCode(n))];
  const value = (depth) => {
    const kind = Math.floor(random() * (depth ? 7 : 4));
    if (kind === 0) return null;
    if (kind === 1) return random() < 0.5;
    if (kind === 2) return Math.floor(random() * 100_000);
    if (kind === 3) {
      let text = "";
      for (let i = 0, count = Math.floor(random() * 500); i < count; i += 1) text += pick(alphabet);
      return text;
    }
    if (kind === 4) return Array.from({ length: Math.floor(random() * 8) }, () => value(depth - 1));
    const object = Object.create(null);
    for (let i = 0, count = Math.floor(random() * 8); i < count; i += 1) {
      object[pick(["url", "title", "content", "status", "data", "__proto__", `key${i}`])] = value(depth - 1);
    }
    return object;
  };

  for (let i = 0; i < 200; i += 1) {
    const output = { query: "test", search: { results: Array.from({ length: 4 }, () => value(3)) } };
    const result = checkedFormat(output, 1 + Math.floor(random() * 4_000));
    if (!result.truncated) assert.equal(JSON.stringify(result.parsed), JSON.stringify(output));
  }
});
