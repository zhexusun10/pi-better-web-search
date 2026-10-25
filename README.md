# pi-better-web-search

**One tool. Every provider. Raw results.**

A [pi](https://pi.dev) extension that adds exactly one model-callable tool:
`web_search`. It uses provider-native search APIs, analyzes URLs when a usable
provider supports it, automatically falls back across authenticated providers,
and returns provider data as-is.

[![CI](https://github.com/zhexusun10/pi-better-web-search/actions/workflows/ci.yml/badge.svg)](https://github.com/zhexusun10/pi-better-web-search/actions/workflows/ci.yml)
[![npm](https://img.shields.io/badge/npm-v0.1.5-blue)](https://www.npmjs.com/package/pi-better-web-search)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Pi 1.3](https://img.shields.io/badge/Pi-1.3-blue.svg)](https://pi.dev)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](https://nodejs.org)

[简体中文](docs/README.zh-CN.md) · [Architecture](docs/architecture.md) · [Providers](docs/providers.md) · [Testing](docs/testing.md) · [Source](extensions/index.ts)

![pi-better-web-search architecture](https://raw.githubusercontent.com/zhexusun10/pi-better-web-search/main/assets/architecture.svg)

```bash
pi install npm:pi-better-web-search
```

Then start a new pi process, or run `/reload` in an existing session.

GitHub and local installations also work:

```bash
pi install git:github.com/zhexusun10/pi-better-web-search
pi install ./path/to/pi-better-web-search
```

> Do not load this package together with `pi-web-search`. Both register a tool
> named `web_search`, and the second registration replaces the first.

Requirements: **pi 1.3+** and **Node.js 22.19+**.

## What it fixes

`pi-better-web-search` started as an extraction of the `web_search` tool from
`pi-web-search`, then changed the parts that made it unreliable:

- **One tool, not two.** There is no separate `url_context` tool. URL analysis
  is the optional `urls` field on `web_search`.
- **Correct exposure.** The tool is hidden when the current model has no
  compatible search interface and no compatible provider is authenticated. A
  login or API key for any supported provider is enough to expose it.
- **Automatic fallback.** If the current model cannot search, or a provider
  call fails, the extension tries other authenticated provider interfaces until
  one succeeds.
- **Remembered interfaces.** The successful search and fetch providers are
  cached under pi's agent directory. The next call uses the remembered
  interface when the current model cannot search.
- **Fresh discovery.** Adding or removing a provider, login, API key, or
  available model changes the cache fingerprint, so old preferences are not
  blindly reused.
- **Dynamic URL field.** `urls` is exposed only when at least one usable
  provider supports URL analysis. `urls` can be used alone or with `query`.
- **Raw results.** Provider data is returned in a JSON wrapper without
  deduplication, URL normalization, junk filtering, re-ranking, summarization,
  citation-marker insertion, or appended Sources sections. Only a final
  character guard truncates oversized output.
- **Correct semantics.** The tool description is exactly
  `Search the web or analyze specified URLs.` The schema makes clear that
  `urls` does not require `query`.
- **No system prompt changes.** The extension does not add prompt snippets,
  guidelines, loadout hooks, commands, providers, MCP servers, or other tools.
- **Native DeepSeek Search/Fetch.** DeepSeek uses the documented
  `/v1/tools/search` and `/v1/tools/fetch` endpoints with Bearer auth.

## Tool semantics

The runtime schema is logically:

```ts
{
  query?: string;
  urls?: string[];
}
```

- `query` searches the web. Search operators such as `site:`, quotes, `AND`,
  `OR`, and `-term` are passed through unchanged (only outer whitespace is
  trimmed).
- `urls` analyzes the listed pages. URLs can be used **alone** or together with
  `query`. A query plus URLs performs a search and then analyzes the URLs.
- At most **20** URLs may be supplied.
- At least one non-empty `query` or one valid URL is required. This rule is
  enforced at runtime rather than with a top-level `anyOf`, for compatibility
  with all model providers.
- The `urls` field is hidden when no usable interface supports URL analysis. In
  that configuration `query` is required.
- Search and URL analysis may use different providers in the same call.

Invalid input with no usable query or URL, a missing URL-capable provider for
supplied URLs, or a call where every search/URL-only provider fails returns a
tool error (`isError: true`) instead of silently dropping work. Individual
invalid URLs alongside valid work are reported in the `fetched` entries.

## Provider support

`pi-better-web-search` natively supports **10 distinct provider classes** (plus Anthropic Messages), automatically detecting authenticated credentials and routing each call through native provider protocols:

| # | Provider Class | Web Search | URL Analysis | Native Protocol & Endpoint |
|:---:|---|:---:|:---:|---|
| 1 | **DeepSeek** | Yes | Yes | Native REST `/v1/tools/search` & `/v1/tools/fetch` |
| 2 | **Google Gemini** | Yes | Yes | `google-generative-ai` SSE `google_search` grounding & `url_context` |
| 3 | **Google Antigravity** | Yes | Yes | Antigravity enterprise Vertex endpoint & wrapper body |
| 4 | **Ollama Cloud** | Yes | Yes | Hosted REST `/api/web_search` & `/api/web_fetch` (`ollama.com`) |
| 5 | **OpenAI** | Yes | No | Official Responses API `web_search` tool (`openai-responses`) |
| 6 | **Azure OpenAI** | Yes | No | Azure Responses API (`azure-openai-responses`) |
| 7 | **OpenAI Codex** | Yes | No | Specialized `/codex/responses` with Codex account tokens & headers |
| 8 | **GitHub Copilot** | Yes | No | Responses routing with Copilot auth tokens & proxy endpoints |
| 9 | **OpenCode** | Yes | No | Responses routing with Pi session tracking headers |
| 10 | **xAI (Grok)** | Yes | No | Grok dialect Responses API (`web_search_call.action.sources`) |
| * | **Anthropic Messages** | Yes | No | Messages API `web_search_20260209` tool & Claude Code OAuth |

URL analysis is only exposed when at least one usable interface supports it.
For example, a current OpenAI model with only OpenAI credentials gets a
query-only schema, while the same session with DeepSeek, Ollama Cloud, or Google
credentials also gets `urls`.

Provider detection follows the authenticated model's provider/API:

1. `deepseek` provider (DeepSeek native search/fetch)
2. Antigravity or Google Generative AI (Google Gemini & Google Antigravity)
3. Ollama Cloud (`ollama-cloud` provider or exact `ollama.com` host)
4. xAI with `openai-responses` (xAI Grok)
5. OpenAI-compatible Responses APIs (OpenAI, Azure OpenAI, OpenAI Codex, GitHub Copilot, OpenCode)
6. Anthropic Messages (Claude)

See [Providers](docs/providers.md) for request shapes, auth quirks, and URL
support per family.

## Automatic selection and fallback

For a search:

1. The current conversation model is tried first when its provider family
   supports web search.
2. A remembered successful provider from the preference cache is tried next
   when the cache fingerprint is current.
3. The remaining provider families are tried in this fixed order:
   **DeepSeek → Ollama → Google → OpenAI → xAI → Anthropic**.
4. Within a family, models are ordered by capability tier first (cheapest
   available tier wins) and then by version number, newest first. OpenAI tiers
   are `luna → sol → astra` and Claude tiers are
   `haiku → sonnet → opus → fable`; other families have no named tiers and are
   ordered purely by version. Ties are deterministic.
5. Alternate models from other providers are tried round-robin, so a provider
   that rejects one specific model can still serve a sibling. Only the current
   model's provider id is excluded; a different provider id in the same family
   is still tried. A provider-wide failure (auth, balance, network, timeout,
   malformed request) skips the rest of that provider; a model-specific
   failure keeps trying sibling models.

URL fetching uses the same idea, but considers only providers that implement
URL fetching.

The current model is always tried first when it supports search. The cache does
not replace a supported current model; it mainly lets an unsupported current
model use a remembered compatible provider immediately on later calls.

If a provider errors, the extension records the attempt and moves to the next
interface. Aborts stop immediately. Each attempt has a timeout (60 seconds by
default, configurable with `PI_BETTER_WEB_SEARCH_TIMEOUT_MS`). If every attempt
fails, the tool returns an error whose message lists the attempted
provider/model pairs and their errors. For a URL-only call, the error also
reports the per-URL failures.

### Cache fingerprint invalidation

The preference cache is stamped with a fingerprint of all authenticated chat
models known to pi, derived from sorted `provider/model@baseUrl` values. Adding
or removing a provider, login, API key, or available model changes the
fingerprint. A changed fingerprint means:

- the old cached provider is **not** used as the first choice;
- provider discovery starts again from the current model and family priority;
- the cache is rewritten only after the next successful search/fetch;
- stale, unverified preferences are not carried into the new fingerprint.

A cache entry is only a hint. Credentials are resolved again on every call, and
the referenced provider must still be available and support the operation.

## Cache

Default path:

```text
~/.pi/agent/better-web-search.json
```

The path respects pi's `PI_CODING_AGENT_DIR` setting. Override it directly with:

```bash
export PI_BETTER_WEB_SEARCH_CACHE=/path/to/better-web-search.json
```

Example contents:

```json
{
  "version": 1,
  "fingerprint": "0123456789abcdef0123456789abcdef",
  "search": { "provider": "deepseek", "model": "deepseek-chat" },
  "fetch": { "provider": "ollama-cloud", "model": "gpt-oss:120b" }
}
```

Only provider and model identifiers plus the fingerprint are stored. API keys,
OAuth tokens, and other credentials are never written to this file.

To clear the remembered preferences, delete the file:

```bash
rm ~/.pi/agent/better-web-search.json
```

A missing, unreadable, or corrupt cache is treated as empty and never breaks a
tool call.

## Raw provider results

Provider data is returned in a JSON wrapper without cleanup. A search looks like
this:

```json
{
  "query": "the query",
  "search": {
    "answer": "provider text when available",
    "results": "the provider's raw results",
    "citations": "the provider's raw citations",
    "searchQueries": ["provider query"],
    "groundingMetadata": "raw provider metadata"
  },
  "fetched": [
    {
      "url": "https://example.com",
      "data": "the provider's raw fetch payload"
    }
  ]
}
```

- Duplicate URLs are not deduplicated.
- Tracking parameters and junk-looking URLs are not normalized or filtered.
- Results are not re-ranked or summarized.
- Citation markers are not inserted, and no "Sources" or "Additional results"
  sections are appended.
- Redirects are not resolved and sources are not derived.
- Unknown provider fields are preserved.

The only transformation is a final output-size guard. The model-facing JSON is
truncated to **64,000 characters** by default and marked with `[Truncated]`;
`details.truncated` is set to `true`. Change the limit with:

```bash
export PI_BETTER_WEB_SEARCH_MAX_CHARS=100000
```

Truncation is Unicode code-point safe. The guard is intentionally applied after
the raw JSON is assembled so normal-sized provider payloads are not altered.

## Exposure rules

`web_search` is exposed when either:

- the current conversation model supports a provider-native search interface;
  or
- at least one authenticated available model maps to a supported provider
  family.

For an unsupported current model with no compatible login or API key, the tool
stays hidden (removed from the active tool set). The extension never calls an
unauthenticated provider. When the set of available providers or credentials
changes, the extension re-evaluates and re-registers the same `web_search` name
with the appropriate schema variant.

## DeepSeek native Search/Fetch API

This package supports DeepSeek's native search and fetch APIs. The older
project's Anthropic-compatible DeepSeek chat route is **replaced** by this
native API; DeepSeek models are routed to it even when their underlying chat API
is Anthropic Messages compatible.

```text
POST https://api.deepseek.com/v1/tools/search
POST https://api.deepseek.com/v1/tools/fetch
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

Search uses `query`, `count: 10`, and `need_content: true`. The raw `results`
array is returned unchanged, including `rerank_score`, `title`, `url`,
`snippet`, `summary`, `content`, `site_name`, `site_icon`, `date`, `authority`,
and any unknown fields.

Fetch sends `{ "url": "..." }` and preserves the raw `{ title, content }`
response. URLs must be at most 8192 characters, use HTTP/HTTPS, include a host,
and omit credentials.

DeepSeek errors use the OpenAI-compatible error shape. Search errors and global
fetch errors switch providers; `403` and `404` fetch failures are reported
against the individual URL so the orchestrator can retry only that URL elsewhere.

See [Providers](docs/providers.md#deepseek) for the full request, response, and
error details.

## Security and privacy

- Credentials are resolved through pi's model registry on each call. The
  extension does not store API keys or OAuth tokens.
- The cache stores only provider/model identifiers and a fingerprint.
- Search queries and requested URLs are sent to the selected provider's API.
- The extension has no telemetry, analytics, or third-party service of its own.
- A call may use an authenticated provider other than the current conversation
  model, which can incur usage on that provider.
- Provider error text and tool results can contain request identifiers or page
  content. Redact them before sharing logs or session exports.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Verified

- **116 unit and integration tests** covering exposure, schema variants,
  provider request shapes, SSE parsing, raw-result preservation, fallback,
  cache invalidation, URL handling, truncation, and abort behavior.
- **Real DeepSeek Search/Fetch run** with a real API key: 10 raw search results,
  summaries and content, valid fetch payloads for normal pages, and documented
  errors for 404 and invalid URLs.
- **Real pi process end-to-end run**: a mock unsupported current model plus
  DeepSeek credentials exposed `web_search`, called it, auto-switched to the
  native DeepSeek API, returned 10 raw results, and answered with the tool
  result attached.
- Other provider families are covered by unit/integration tests with mocked
  requests and streams; live credentials for every provider are not required.

The opt-in live DeepSeek test is reproducible from a repository checkout:

```bash
DEEPSEEK_API_KEY=... npm run test:live:deepseek
```

## Compatibility

- **pi 1.3+**. The extension uses the current extension tool and model registry
  APIs.
- **Node.js 22.19+**. Pi loads the TypeScript extension directly; there is no
  compile step.
- Pi provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and
  `typebox` as host packages. They are declared as peer dependencies and are
  not bundled.
- Upstream provider API changes may require adapter updates. Unknown provider
  fields are preserved rather than rewritten.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
npm run build
```

`npm run build` runs the checks and tests, verifies the npm file list, and packs
`dist/pi-better-web-search-0.1.0.tgz`. Nothing is published automatically.

The test suite uses plain `.mjs` files that import the `.ts` sources directly.
It mocks `globalThis.fetch`, uses a temporary cache file, and exercises
exposure, fallback, cache invalidation, raw-result preservation, truncation,
URL handling, and provider switching.

See [Testing](docs/testing.md) for live-provider tests and the real pi
end-to-end procedure. See [Publishing](docs/publishing.md) for the release
checklist.

## Contributing

Use English for issues, pull requests, and primary documentation. Chinese
translations are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
changing provider behavior, exposure rules, or output handling.

The extension keeps one invariant above all others: **trust the provider's
result**. Do not add cleanup that rewrites, filters, re-ranks, summarizes, or
reconstructs provider data.

## License

MIT. An independent community package, not an official Pi product.

The `web_search` extraction is derived from the MIT-licensed
[`pi-web-search`](https://github.com/ttttmr/pi-web-search) project. The
repository structure and documentation conventions are inspired by
[`pi-trim`](https://github.com/zhexusun10/pi-trim).
