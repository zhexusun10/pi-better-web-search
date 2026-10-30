import assert from "node:assert/strict";
import test from "node:test";

import { formatSuccess, MAX_OUTPUT_CHARS } from "../lib/format.ts";
import { formatJsonWithinLimit } from "../lib/truncate-json.ts";

const chars = (text) => Array.from(text).length;
const marker = "[truncated]";
const markerLine = `\n${marker}`;

function checkedFormat(output, limit) {
  const result = formatJsonWithinLimit(output, limit);
  assert.ok(chars(result.text) <= limit, `output exceeds ${limit} code points`);
  if (result.truncated && limit >= marker.length + 3) {
    assert.ok(result.text.endsWith(markerLine));
    const parsed = JSON.parse(result.text.slice(0, -markerLine.length));
    return { ...result, parsed };
  }
  if (result.truncated && limit >= marker.length) {
    assert.equal(result.text, marker);
    return result;
  }
  return { ...result, parsed: JSON.parse(result.text) };
}

test("the default 96,000-character limit preserves results above the old limit", async () => {
  const original = process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
  try {
    delete process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
    const module = await import("../lib/format.ts?default-limit-test");
    assert.equal(module.MAX_OUTPUT_CHARS, 96_000);

    const prettyBaseLength = chars(JSON.stringify({ query: "" }, null, 2));
    for (const length of [64_001, 80_000, 95_999, 96_000]) {
      const output = { query: "x".repeat(length - prettyBaseLength) };
      const result = module.formatSuccess(output, { attempts: [] });
      assert.equal(chars(result.content[0].text), length);
      assert.equal(result.content[0].text, JSON.stringify(output, null, 2));
      assert.equal(result.details.truncated, undefined);
    }

    const compactBaseLength = chars(JSON.stringify({ query: "" }));
    const output = { query: "x".repeat(96_001 - compactBaseLength) };
    const result = module.formatSuccess(output, { attempts: [] });
    assert.equal(chars(result.content[0].text), 96_000);
    assert.ok(result.content[0].text.endsWith(markerLine));
    assert.equal(result.details.truncated, true);
    const parsed = JSON.parse(result.content[0].text.slice(0, -markerLine.length));
    assert.ok(output.query.startsWith(parsed.query));
  } finally {
    if (original === undefined) delete process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
    else process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS = original;
  }
});

test("complete JSON at and just below the configured boundary is never truncated", () => {
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

test("truncation reserves room for one final marker at the compact boundary", () => {
  const limit = 256;
  const emptyLength = chars(JSON.stringify({ query: "" }));
  const output = { query: "x".repeat(limit + 1 - emptyLength) };
  assert.equal(chars(JSON.stringify(output)), limit + 1);
  const result = checkedFormat(output, limit);
  assert.equal(result.truncated, true);
  assert.equal(chars(result.text), limit);
  assert.ok(result.text.startsWith('{"query":"'));
  assert.equal(result.text.match(/\[truncated\]/g)?.length, 1);
  assert.ok(output.query.startsWith(result.parsed.query));
  assert.ok(result.parsed.query.length < output.query.length);
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
  const result = checkedFormat(output, 96_000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith('{"query":"find sources",'));
  assert.equal(result.text.match(/\[truncated\]/g)?.length, 1);
  assert.deepEqual(Object.keys(result.parsed), ["query", "search", "fetched"]);
  assert.equal(result.parsed.search.results.length, 10);
  assert.deepEqual(result.parsed.fetched.map((entry) => entry.url), urls);
  assert.equal(result.parsed.fetched[7].error, "blocked");
  for (const [index, entry] of result.parsed.search.results.entries()) {
    assert.equal(entry.title, `result-${index}`);
    assert.equal(entry.url, `https://example.com/result-${index}`);
    assert.ok(entry.content.length > 100);
    assert.ok(entry.content.length < output.search.results[index].content.length);
    assert.ok(output.search.results[index].content.startsWith(entry.content));
  }
  for (const [index, entry] of result.parsed.fetched.entries()) {
    if (index === 7) continue;
    assert.equal(entry.data.title, `page-${index}`);
    assert.ok(entry.data.content.length > 100);
    assert.ok(entry.data.content.length < output.fetched[index].data.content.length);
    assert.ok(output.fetched[index].data.content.startsWith(entry.data.content));
  }
});

test("long result URLs are either complete or the entire entry is omitted", () => {
  const url = `https://example.com/${"x".repeat(220)}`;
  const output = { query: "q", search: { results: [{ title: "test", url, content: "c".repeat(1_000) }] } };

  const fits = checkedFormat(output, 400);
  assert.equal(fits.truncated, true);
  assert.equal(fits.parsed.search.results[0].url, url);
  assert.equal(fits.parsed.search.results[0].title, "test");
  assert.ok(output.search.results[0].content.startsWith(fits.parsed.search.results[0].content));

  const cannotFit = checkedFormat(output, 300);
  assert.equal(cannotFit.truncated, true);
  assert.deepEqual(cannotFit.parsed.search.results, []);
  assert.ok(!cannotFit.text.includes(url.slice(0, 100)));
});

test("protected link and identity fields remain complete at varied budgets", () => {
  const first = {
    title: "title-".repeat(80),
    name: "name-".repeat(40),
    id: "id-".repeat(40),
    pageTitle: "page-".repeat(25),
    site_name: "site-".repeat(25),
    url: `https://example.com/${"u".repeat(250)}`,
    uri: `https://example.com/${"i".repeat(200)}`,
    href: `../${"h".repeat(160)}`,
    link: `/${"l".repeat(150)}`,
    permalink: `/${"p".repeat(140)}`,
    website: `/${"w".repeat(130)}`,
    source_url: `/${"s".repeat(120)}`,
    retrievedUrl: `/${"r".repeat(110)}`,
    file_uri: `/${"f".repeat(100)}`,
    canonicalURL: `/${"k".repeat(90)}`,
    source_HREF: `/${"h".repeat(80)}`,
    requested_URI: `/${"j".repeat(70)}`,
    unknownField: `https://example.com/${"z".repeat(100)}`,
    unknownS3: `s3://example/${"z".repeat(100)}`,
    unknownScheme: `git+ssh://example/${"z".repeat(100)}`,
    content: "body".repeat(2_000),
  };
  const second = { title: "second", url: "https://example.com/second", content: "short" };
  const output = { query: "q", search: { results: [first, second] } };
  let sawOmission = false;
  let sawFirst = false;
  for (const limit of [300, 1_000, 2_000, 3_000, 4_000, 6_000]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    const entries = result.parsed.search?.results ?? [];
    if (entries.length === 0) sawOmission = true;
    else {
      sawFirst = true;
      for (const [key, value] of Object.entries(first)) {
        if (key === "content") assert.ok(value.startsWith(entries[0].content ?? ""));
        else assert.equal(entries[0][key], value, `${key} was shortened or omitted`);
      }
      if (entries.length > 1) assert.deepEqual(entries[1], second);
    }
  }
  assert.ok(sawOmission);
  assert.ok(sawFirst);
});

test("nested provider citations and link arrays retain only complete values in order", () => {
  const urls = Array.from({ length: 4 }, (_, i) => `https://example.com/${i}/${"x".repeat(180)}`);
  const links = ["/relative/" + "a".repeat(150), urls[0], "../page/" + "b".repeat(150)];
  const output = {
    query: "q",
    search: {
      results: urls.map((uri, index) => ({ web: { uri, title: `result-${index}` }, content: "x".repeat(1_000) })),
      citations: urls.map((url, index) => ({ url_citation: { url, title: `citation-${index}` } })),
    },
    fetched: [{ url: urls[0], data: { links, content: "y".repeat(5_000) } }],
  };
  let sawResults = false;
  let sawCitations = false;
  let sawLinks = false;
  for (const limit of [300, 600, 1_000, 2_000, 4_000, 8_000]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    const entries = result.parsed.search?.results ?? [];
    for (const [index, entry] of entries.entries()) {
      sawResults = true;
      assert.deepEqual(entry.web, output.search.results[index].web);
    }
    const citations = result.parsed.search?.citations ?? [];
    for (const [index, citation] of citations.entries()) {
      sawCitations = true;
      assert.deepEqual(citation, output.search.citations[index]);
    }
    const fetched = result.parsed.fetched ?? [];
    for (const entry of fetched) {
      assert.equal(entry.url, urls[0]);
      if (entry.data?.links?.length) {
        sawLinks = true;
        assert.deepEqual(entry.data.links, links.slice(0, entry.data.links.length));
      }
    }
  }
  assert.ok(sawResults && sawCitations && sawLinks);
});

test("singular URL arrays and nested identity objects are not partially rewritten", () => {
  const urls = [`/${"a".repeat(250)}`, `../${"b".repeat(250)}`];
  const sourceLinks = [`/${"c".repeat(200)}`, `/${"d".repeat(200)}`];
  const output = { fetched: [{
    url: "https://example.com/",
    data: { url: urls, SOURCE_LINKS: sourceLinks, content: "x".repeat(3_000) },
  }] };
  let sawArray = false;
  for (const limit of [150, 300, 600, 1_000, 2_000]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    const data = result.parsed.fetched?.[0]?.data;
    if (data?.url?.length) {
      sawArray = true;
      assert.deepEqual(data.url, urls.slice(0, data.url.length));
    }
    if (data?.SOURCE_LINKS?.length) {
      sawArray = true;
      assert.deepEqual(data.SOURCE_LINKS, sourceLinks.slice(0, data.SOURCE_LINKS.length));
    }
  }
  assert.ok(sawArray);

  const nestedUrl = { value: `/${"e".repeat(300)}` };
  const nested = { search: { results: [{ title: "entry", url: nestedUrl, content: "x".repeat(2_000) }] } };
  const small = checkedFormat(nested, 250);
  assert.deepEqual(small.parsed.search.results, []);
  const large = checkedFormat(nested, 600);
  assert.deepEqual(large.parsed.search.results[0].url, nestedUrl);
});

test("URLs embedded in truncated prose are never cut in the middle", () => {
  for (const scheme of ["https://example.com/", "ftp://example.com/", "s3://bucket/", "git+ssh://host/", "mailto:", "doi:", "www.example.com/"]) {
    const url = `${scheme}${"x".repeat(160)}`;
    const query = `prefix ${url} suffix ${"y".repeat(2_000)}`;
    const output = { query };
    const start = query.indexOf(url);
    const end = start + url.length;
    let sawRemovedUrl = false;
    let sawCompleteUrl = false;
    for (const limit of [40, 60, 80, 100, 150, 200, 250, 300]) {
      const result = checkedFormat(output, limit);
      assert.equal(result.truncated, true);
      const visible = result.parsed.query ?? "";
      assert.ok(query.startsWith(visible));
      assert.ok(visible.length <= start || visible.length >= end, `${scheme} was cut at limit ${limit}`);
      if (visible.length === start) sawRemovedUrl = true;
      if (visible.includes(url)) sawCompleteUrl = true;
    }
    assert.ok(sawRemovedUrl && sawCompleteUrl);
  }
});

test("URLs near the default limit remain intact and oversized entries are not re-ranked", () => {
  const url = `https://example.com/${"x".repeat(93_000)}`;
  const output = { query: "q", search: { results: [
    { title: "first", url, content: "c".repeat(10_000) },
    { title: "second", url: "https://example.com/second" },
  ] } };
  const result = checkedFormat(output, 96_000);
  assert.equal(result.truncated, true);
  assert.equal(result.parsed.search.results[0].url, url);
  assert.equal(result.parsed.search.results[0].title, "first");
  assert.equal(result.parsed.search.results[1].url, "https://example.com/second");

  const oversizedUrl = `${url}${"z".repeat(5_000)}`;
  const oversized = checkedFormat({
    query: "q",
    search: { results: [{ title: "first", url: oversizedUrl }, output.search.results[1]] },
  }, 96_000);
  assert.equal(oversized.truncated, true);
  assert.deepEqual(oversized.parsed.search.results, []);
  assert.ok(!oversized.text.includes("https://example.com/"));
});

test("varied budgets preserve every retained result's nested identifiers", () => {
  const output = { query: "q", search: { results: Array.from({ length: 8 }, (_, i) => ({
    title: `title-${i}`,
    id: `id-${i}`,
    web: { uri: `https://example.com/${i}/${"😀x".repeat(40 + i)}`, name: `source-${i}` },
    content: "body".repeat(1_000),
  })) } };
  let retained = 0;
  let omitted = 0;
  for (let limit = 150; limit <= 4_000; limit += 47) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    const entries = result.parsed.search?.results ?? [];
    if (entries.length < output.search.results.length) omitted += 1;
    for (const [index, entry] of entries.entries()) {
      retained += 1;
      assert.equal(entry.title, output.search.results[index].title);
      assert.equal(entry.id, output.search.results[index].id);
      assert.deepEqual(entry.web, output.search.results[index].web);
      if (entry.content !== undefined) assert.ok(output.search.results[index].content.startsWith(entry.content));
    }
  }
  assert.ok(retained > 0 && omitted > 0);
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
  assert.ok(output.fetched[1].data.content.startsWith(result.parsed.fetched[1].data.content));
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
  const result = checkedFormat(output, 96_000);
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
      assert.ok(content.startsWith(visible));
    }
  }
});

test("array entries preserve order without extra metadata even when some are omitted", () => {
  const output = {
    search: {
      results: Array.from({ length: 150 }, (_, i) => ({ title: `item-${i}`, content: "x".repeat(1_000) })),
    },
  };
  for (const limit of [300, 20_000]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    assert.equal(result.text.match(/\[truncated\]/g)?.length, 1);
    assert.ok(result.parsed.search.results.length > 0);
    if (limit === 300) assert.ok(result.parsed.search.results.length < output.search.results.length);
    else assert.equal(result.parsed.search.results.length, output.search.results.length);
    for (const [index, entry] of result.parsed.search.results.entries()) {
      assert.equal(entry.title, `item-${index}`);
      if (entry.content !== undefined) {
        assert.ok(output.search.results[index].content.startsWith(entry.content));
      }
    }
  }
});

test("very small budgets prioritize a complete marker when possible", () => {
  const output = { query: "large".repeat(1_000) };
  for (const limit of [1, 2, 10, 11, 12, 13, 14, 18, 19, 33, 34, 80, 100, 150]) {
    const result = checkedFormat(output, limit);
    assert.equal(result.truncated, true);
    if (limit < marker.length) assert.ok(!result.text.includes(marker));
    else if (limit < marker.length + 3) assert.equal(result.text, marker);
    else assert.ok(result.text.endsWith(markerLine));
  }
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => formatJsonWithinLimit(output, invalid), RangeError);
  }
});

test("configured limits are validated at module load", async () => {
  const original = process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
  try {
    const cases = [
      ["1", 1], ["10", 10], ["11", 11], ["12", 12], ["13", 13], ["14", 14], ["19", 19],
      ["64000", 64_000], ["96000", 96_000], ["96000.75", 96_000],
      ["", 96_000], ["0", 96_000], ["0.4", 96_000], ["-1", 96_000],
      ["Infinity", 96_000], ["bad", 96_000],
    ];
    for (const [value, expected] of cases) {
      process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS = value;
      const module = await import(`../lib/format.ts?truncation-test=${value}`);
      assert.equal(module.MAX_OUTPUT_CHARS, expected);
      const result = module.formatSuccess({ query: "x".repeat(100_000) }, { attempts: [] });
      const text = result.content[0].text;
      assert.ok(chars(text) <= expected);
      if (expected < marker.length) assert.doesNotThrow(() => JSON.parse(text));
      else if (expected < marker.length + 3) assert.equal(text, marker);
      else {
        assert.ok(text.endsWith(markerLine));
        assert.doesNotThrow(() => JSON.parse(text.slice(0, -markerLine.length)));
      }
      assert.equal(result.details.truncated, true);
    }
  } finally {
    if (original === undefined) delete process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS;
    else process.env.PI_BETTER_WEB_SEARCH_MAX_CHARS = original;
  }
});

test("serialized root values from toJSON are handled within the budget", () => {
  const array = checkedFormat({ toJSON: () => ["x".repeat(500), "small"] }, 80);
  assert.equal(array.truncated, true);
  assert.ok(Array.isArray(array.parsed));
  assert.equal(array.parsed[1], "small");
  assert.ok("x".repeat(500).startsWith(array.parsed[0]));

  const scalar = checkedFormat({ toJSON: () => 1.2345678901234567 }, 14);
  assert.equal(scalar.truncated, true);
  assert.deepEqual(scalar.parsed, {});
});

test("unknown keys, including __proto__, cannot mutate object prototypes", () => {
  const raw = JSON.parse('{"query":"q","search":{"results":[{"__proto__":{"polluted":true},"spaced key":"' + "x".repeat(5_000) + '"}]}}');
  const result = checkedFormat(raw, 1_000);
  assert.equal(result.truncated, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result.parsed.search.results[0].__proto__, { polluted: true });
  assert.ok("x".repeat(5_000).startsWith(result.parsed.search.results[0]["spaced key"]));
});

test("provider fields and marker-like text are not confused with truncation metadata", () => {
  const output = {
    _truncation: { source: "provider" },
    query: "q",
    search: { results: [{ raw: "[truncated]", content: "x".repeat(5_000) }] },
  };
  const result = checkedFormat(output, 1_000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.parsed._truncation, { source: "provider" });
  assert.equal(result.parsed.search.results[0].raw, "[truncated]");
  assert.ok(output.search.results[0].content.startsWith(result.parsed.search.results[0].content));
});

test("varied nested JSON always fits and its JSON portion remains parseable", () => {
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
