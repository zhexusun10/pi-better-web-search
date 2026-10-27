# pi-better-web-search - Design and Handoff

> Internal design notes for maintainers. The public architecture overview is
> [`docs/architecture.md`](docs/architecture.md).

This package adds exactly one model-callable tool, `web_search`, with
provider-native search, cross-provider fallback, optional URL fetching, and raw
provider results. The package implements the provider network calls, exposure
manager, preference cache, and orchestrator described below.

## 1. Product requirements (hard requirements)

1. **Exposure**: Do not expose `web_search` to a model that does not support a
   provider-native web-search interface. Exception: if the user is logged in or
   has an API key for any compatible provider, expose the tool and automatically
   use that provider's search API even when the current conversation model is
   unsupported. If neither the current model nor any authenticated provider
   supports search, keep the tool hidden.
2. **Automatic fallback and memory**: If the current model does not support
   search, automatically try compatible authenticated provider interfaces in a
   deterministic order. On provider errors, continue to the next interface until
   one succeeds. Remember the successful search interface (and separately the
   successful URL-fetch interface) in a small JSON cache under pi's agent dir,
   and try it first next time. If the user adds or removes providers, logins, or
   API keys, re-evaluate instead of blindly using the old cache. If all attempts
   fail, return a clear tool error.
3. **URL field**: Hide the `urls` field when no usable interface supports URL
   fetching; expose it when at least one does. The schema is logically
   `{ query?: string; urls?: string[] }`; `urls` may be used alone. Do not use a
   top-level `anyOf` (provider compatibility); enforce "at least one of
   query/urls" at runtime. `urls` max 20.
4. **Raw results only**: Do not post-process provider search results. No dedupe,
   URL normalization, junk-URL filtering, re-ranking, summarizing,
   citation-marker insertion, appended "Sources"/"Additional results" sections,
   redirect resolution, or source derivation. Trust the provider output. Return
   raw provider data in a JSON wrapper; only when the final output exceeds the
   character guard may fields or entries be structurally truncated.
5. **Description/schema semantics**: The tool description must start exactly
   `Search the web or analyze specified URLs.` Property descriptions must make
   clear that `urls` can be used alone and together with `query`.
6. **System prompt**: Do not modify pi's system prompt. Do not add
   `promptSnippet`, `promptGuidelines`, `prepareLoadout`, system-prompt handlers,
   commands, providers, MCP servers, or any other tool. The only registered tool
   is `web_search`.
7. **DeepSeek**: Add support for DeepSeek's native Search/Fetch API. The provider
   node implements the network calls described in section 10.

## 2. Ownership map

| Path | Owner | Status in this node |
| --- | --- | --- |
| `package.json`, `tsconfig.json`, `.gitignore`, `DESIGN.md` | scaffold | complete |
| `src/index.ts` | orchestrator-exposure | complete: single tool registration and sync |
| `src/candidates.ts` | orchestrator-exposure | complete: discovery, ordering, exposure |
| `src/search.ts` | orchestrator-exposure | complete: validation, fallback, cache, output |
| `src/providers/types.ts` | shared contract | complete |
| `src/providers/index.ts` | shared contract | complete |
| `src/providers/http.ts` | shared primitive | complete |
| `src/providers/sse.ts` | shared primitive | complete |
| `src/providers/deepseek.ts` | DeepSeek provider node | complete: native Search/Fetch |
| `src/providers/ollama.ts` | Ollama provider node | complete |
| `src/providers/google.ts` | Google provider node | complete |
| `src/providers/openai.ts` | OpenAI provider node | complete, including `xaiAdapter` |
| `src/providers/anthropic.ts` | Anthropic provider node | complete |
| `src/auth.ts` | shared primitive | complete |
| `src/families.ts` | shared primitive | complete |
| `src/cache.ts` | shared primitive | complete |
| `src/schema.ts` | shared primitive | complete |
| `src/format.ts` | shared primitive | complete |
| `tests/` | test suite | complete: provider, primitive, exposure, integration |

The reference checkout `pi-web-search/` is read-only and must not be edited.
The implementation was checked against the published npm package
`pi-web-search@1.7.0` because the repository's gitlink was empty. The contract
below is authoritative for this package.

## 3. Runtime invariants and non-goals

- Register one tool only: `web_search`.
- No commands, keyboard shortcuts, providers, MCP servers, prompt snippets,
  prompt guidelines, loadout hooks, or system-prompt mutation.
- No separate `url_context` tool. URL analysis is an optional `urls` field on
  `web_search`.
- No non-essential runtime dependencies. The package uses TypeBox, pi APIs, and
  Node built-ins.
- Write erasable TypeScript only (Node 24 type stripping): no enums, namespaces,
  or parameter properties. Use `.ts` extensions in relative imports.
- Tests are plain `.mjs` and import `.ts` modules directly.

## 4. Provider families

`src/families.ts` exposes:

- `getProviderFamily(model)`: returns a `ProviderFamily` or `undefined`.
- `isSupportedSearchModel(model)`: chat model plus an adapter with
  `supportsSearch`.
- `isChatModel(model)`: `!model.type || model.type === "chat"`.
- `describeModel(model)`: `${id} (${provider}/${api})`.
- `getAdapterForModel(model)`, `getAdapterForFamily(family)`.
- `isRestFamily(family)`: true for `deepseek` and `ollama`.

Detection order is fixed:

1. `model.provider === "deepseek"` -> `deepseek`
2. `model.provider === "antigravity" || model.api === "antigravity"` -> `google`
3. `model.api === "google-generative-ai"` -> `google`
4. Ollama Cloud: `model.provider === "ollama-cloud"` or URL hostname exactly
   `ollama.com` -> `ollama`
5. `model.provider === "xai" && model.api === "openai-responses"` -> `xai`
6. `model.api` is `openai-responses`, `azure-openai-responses`, or
   `openai-codex-responses` -> `openai`
7. `model.api === "anthropic-messages"` -> `anthropic`
8. Otherwise `undefined`

The `ADAPTERS` object insertion order is part of the deterministic fallback
contract: `deepseek`, `ollama`, `google`, `openai`, `xai`, `anthropic`.

## 5. Adapter contract

`src/providers/types.ts`:

```ts
export const PROVIDER_FAMILIES = ["deepseek", "ollama", "google", "openai", "xai", "anthropic"] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export interface ProviderSearchResult {
  answer?: string;
  results?: unknown;
  citations?: unknown;
  searchQueries?: string[];
  groundingMetadata?: unknown;
  urlContextMetadata?: unknown;
}

export interface ProviderFetchEntry {
  url: string;
  data?: unknown;
  error?: string;
}

export interface ProviderFetchResult {
  entries: ProviderFetchEntry[];
}

export interface ProviderAdapter {
  family: ProviderFamily;
  label: string;
  supportsSearch: boolean;
  supportsUrls: boolean;
  search(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    signal: AbortSignal | undefined,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<ProviderSearchResult>;
  fetch?(
    ctx: ExtensionContext,
    model: Model<Api>,
    urls: string[],
    query: string | undefined,
    signal: AbortSignal | undefined,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<ProviderFetchResult>;
}
```

`src/providers/index.ts` exports all adapters and:

```ts
export const ADAPTERS: Record<ProviderFamily, ProviderAdapter>;
```

Capabilities are final and must not change in provider nodes:

| Adapter | Family | Search | URLs | `fetch` |
| --- | --- | --- | --- | --- |
| `deepseekAdapter` | `deepseek` | yes | yes | yes |
| `ollamaAdapter` | `ollama` | yes | yes | yes |
| `googleAdapter` | `google` | yes | yes | yes |
| `openaiAdapter` | `openai` | yes | no | absent |
| `xaiAdapter` | `xai` | yes | no | absent |
| `anthropicAdapter` | `anthropic` | yes | no | absent |

All current stub methods throw `new Error("<Name> adapter not implemented")`.
Provider nodes replace only the implementation bodies and any private helpers;
the exported adapter names, families, labels, and capability flags stay stable.

Adapters receive the already-authenticated candidate `model`. A provider node
must resolve credentials itself with `resolveAuth` / `buildRequestHeaders`, honor
the signal, and return raw provider data. It must not call other adapters and
must not retry the same provider after an error.

## 6. Exposure, candidate discovery, and fallback

The orchestrator-exposure node owns this logic in `src/candidates.ts`,
`src/search.ts`, and `src/index.ts`. Use the primitives as follows.

### 6.1 Usable interfaces

A "usable search interface" is an available chat model whose family adapter has
`supportsSearch` and whose provider has working credentials. In pi 1.3.0,
`ctx.modelRegistry.getAvailable()` is the primary authenticated-model source;
`ctx.modelRegistry.hasConfiguredAuth(model)` can be used for an explicit check.
A "usable fetch interface" is the same, additionally requiring
`adapter.supportsUrls` and an adapter `fetch` function.

The current model is usable when `isSupportedSearchModel(ctx.model)` is true and
its adapter supports search. The current model may be used directly even if it is
not in `getAvailable()`, because it is the active authenticated conversation
model.

### 6.2 Exposure

Expose `web_search` when at least one of these is true:

- the current model is a supported search model; or
- at least one authenticated available model maps to a family adapter with
  `supportsSearch`.

Otherwise keep it hidden. To hide an already registered tool, remove
`web_search` from the active set with `pi.setActiveTools(...)`; pi has no
unregister API. Do not register any other tool.

The `urls` field is hidden unless at least one usable interface (current or
fallback) supports URL fetching. The schema is generated by
`buildWebSearchSchema({ allowUrls })`. Re-register the same `web_search` name
with the appropriate schema when discovery changes (pi replaces a same-name tool
definition). Keep the tool inactive until the new active set is applied. Avoid
`promptSnippet`, `promptGuidelines`, and `prepareLoadout`.

Re-evaluate on `session_start`, `session_tree`, and `model_select`. Re-evaluating
on `turn_start` is also safe and catches login/API-key changes before the next
model request. These handlers must not alter the system prompt.

### 6.3 Deterministic search order

Use this order, skipping unavailable or unsupported entries:

1. The current model, if its family supports search.
2. The cached search `ProviderRef` when the cache fingerprint is current, the
   referenced model still exists, is available, and supports search.
3. Adapter families in `ADAPTERS` insertion order. For each family, choose one
   available chat model deterministically. Models are ordered by capability
   tier first (cheapest tier wins) and then by version number, newest first:
   OpenAI tiers are `luna → sol → astra` and Claude tiers are
   `haiku → sonnet → opus → fable`; other families have no named tiers. Ties
   fall back to the lexicographic `provider/id@baseUrl` order.
4. Alternate models from every provider except the current model's provider
   id, round-robin across families so each family gets a second chance before
   any family gets a third. A different provider id in the same family (for
   example `openai` vs `openai-codex`) is still tried. This recovers from
   provider accounts that reject a specific model (legacy ids, account tiers)
   while serving a sibling.

On success, write `{ provider: model.provider, model: model.id }` as
`cache.search` and update `cache.fingerprint`. Preserve a cached `fetch` ref
only when the fingerprint was already current (or that fetch interface was
revalidated in the same call); a stale, unverified ref must not inherit the new
fingerprint. On a provider error, append a `WebSearchAttempt` and continue. A
provider-wide failure (401/403/429, insufficient balance, network failure,
timeout, or a malformed request header) marks the provider id as failed so the
same provider is not retried with another model; a model-specific failure (an
unsupported, missing, or rejected model) keeps trying sibling models. On
abort, stop immediately and propagate the abort instead of trying more
providers. If every attempt fails, return `formatError` with a message that
includes the attempted interfaces and the last significant error.

### 6.4 Deterministic fetch order

If `urls` is present and URL fetching is allowed:

1. The current model, if its adapter supports URLs.
2. The cached fetch `ProviderRef` when the fingerprint is current and the model
   is still a usable fetch interface.
3. Adapter families in `ADAPTERS` insertion order with `supportsUrls`.
4. Alternate URL-capable models from every family except the current model's
   family, round-robin across families, mirroring the search order.

A search and a fetch may use different providers. Keep provider/model routing
metadata in `details`, not in the model-facing output. Preserve per-URL errors
reported by a provider. If
URLs were supplied but no fetch interface exists, return a clear tool error; do
not silently drop the URLs. On a successful fetch, write the successful
`cache.fetch` ref and fingerprint using the same stale-ref rules as search.

### 6.5 Cache freshness

Read the cache on every tool call and compute the current fingerprint.
`isFreshDiscovery(cache, fingerprint)` is true when they differ. When the cache
is stale:

- Do not use cached search/fetch refs as first choices.
- Rediscover from the current authenticated model set.
- Do not clear or rewrite the cache merely because discovery changed. On the
  next successful search/fetch, write the new ref and the new fingerprint. Do
  not carry an unvalidated stale ref into the new fingerprint; preserve a ref
  only if it was already fresh or was revalidated during this call.

A cache ref is a hint, never an authorization bypass. Always resolve credentials
again and verify the ref still maps to a supported, available model.

### 6.6 Runtime input validation

The "at least one of query/urls" rule is not encoded with a top-level `anyOf`.
The orchestrator validates at runtime:

- At least one non-empty `query` or at least one `urls` entry is required.
- `urls`, when present, must contain 1 to `MAX_URLS` (20) entries.
- `urls` alone skips search and performs fetch only.
- `query` alone performs search only.
- `query` plus `urls` performs the search and the fetch.

Return `formatError` when there is no valid query or URL. Invalid individual URL
entries alongside valid work are reported as per-URL errors. Provider-specific
URL validation belongs in the provider node.

## 7. Schema and description

`src/schema.ts` exports:

- `WEB_SEARCH_TOOL_NAME = "web_search"`
- `WEB_SEARCH_DESCRIPTION = "Search the web or analyze specified URLs."`
- `MAX_URLS = 20`
- `TSchema`
- `buildWebSearchSchema({ allowUrls })`
- `buildWebSearchToolDescription({ allowUrls })`

Schema variants:

- `allowUrls: false`: object with required `query` (string, minLength 1).
- `allowUrls: true`: object with optional `query` (string, minLength 1) and
  optional `urls` (array of strings, minItems 1, maxItems 20).

Neither variant has a top-level `anyOf`. The tool description is exactly
`WEB_SEARCH_DESCRIPTION` for both variants. The `query` property description
mentions combining with `urls`; the `urls` description explicitly says it can be
used alone or together with `query`.

## 8. Output and formatting

`src/format.ts` defines:

```ts
// Positive, finite integer from PI_BETTER_WEB_SEARCH_MAX_CHARS, default 64,000.
export const MAX_OUTPUT_CHARS: number;

export interface WebSearchOutput {
  query?: string;
  search?: {
    answer?: string;
    results?: unknown;
    citations?: unknown;
    searchQueries?: string[];
    groundingMetadata?: unknown;
    urlContextMetadata?: unknown;
  };
  fetched?: Array<{
    url: string;
    data?: unknown;
    error?: string;
  }>;
}

export interface WebSearchAttempt {
  phase: "search" | "fetch";
  provider: string;
  model: string;
  message: string;
}

export interface WebSearchDetails {
  provider?: string;
  model?: string;
  fetchProviders?: string[];
  attempts: WebSearchAttempt[];
  resultCount?: number;
  fetchedCount?: number;
  truncated?: boolean;
  error?: string;
}
```

Model-facing content is JSON only:

```json
{
  "query": "optional query",
  "search": {
    "answer": "provider text when available",
    "results": "raw provider results",
    "citations": "raw provider citations",
    "searchQueries": ["provider query"],
    "groundingMetadata": "raw provider metadata",
    "urlContextMetadata": "raw provider metadata"
  },
  "fetched": [
    {
      "url": "https://example.com",
      "data": "raw provider fetch payload"
    }
  ]
}
```

Rules:

- Pass `results`, `citations`, `groundingMetadata`, `urlContextMetadata`, and
  fetch `data` through unchanged when within the limit. Do not normalize,
  dedupe, filter, rank, summarize, resolve redirects, or derive sources.
- `formatSuccess(output, details)` first uses two-space JSON; if necessary it
  tries compact JSON without data loss. If compact JSON exceeds
  `MAX_OUTPUT_CHARS`, `lib/truncate-json.ts` allocates space across sibling
  fields and array entries, preserving identifiers where possible and keeping
  the result valid JSON. Shortened strings get `…[truncated]` where space
  permits. A top-level `_truncation` records the original indented size and
  affected paths; `details.truncated = true` reports actual data loss. An
  extremely small limit may only fit the details flag. The cap counts Unicode
  code points, not tokens; there is no continuation cache.
- `formatError(message, details)` returns exactly
  `Failed: <message>`, the supplied details, and `isError: true`.
- `resultCount` and `fetchedCount` are metadata only. Do not use them to rewrite
  provider output.

## 9. Cache format and fingerprint

`src/cache.ts`:

```ts
export interface ProviderRef { provider: string; model: string; }

export interface PreferenceCache {
  version: 1;
  fingerprint?: string;
  search?: ProviderRef;
  fetch?: ProviderRef;
}
```

Path:

```ts
getCachePath() = process.env.PI_BETTER_WEB_SEARCH_CACHE || join(getAgentDir(), "better-web-search.json")
```

Example file:

```json
{
  "version": 1,
  "fingerprint": "0123456789abcdef0123456789abcdef",
  "search": { "provider": "deepseek", "model": "deepseek-chat" },
  "fetch": { "provider": "ollama-cloud", "model": "gpt-oss:120b" }
}
```

- `readCache()` returns `{ version: 1 }` for missing, unreadable, corrupt,
  non-object, wrong-version, or invalid-field files. A file with any invalid
  optional field is discarded as a whole.
- `writeCache(cache)` creates parent directories, writes pretty JSON with a
  trailing newline, and never throws. It returns `true` on success and `false`
  on failure.
- `fingerprintAvailableModels(ctx)` hashes the sorted
  `${provider}/${id}@${baseUrl}` strings of chat models returned by
  `ctx.modelRegistry.getAvailable()`. It uses SHA-256 and keeps the first 32 hex
  characters. Non-chat models are ignored. A registry failure hashes an empty
  list.
- `isFreshDiscovery(cache, fingerprint)` is exactly
  `cache.fingerprint !== fingerprint`.

Adding or removing a login, API key, provider, or available model changes the
available set and therefore the fingerprint. A changed fingerprint means
"rediscover", not "retry the old preference blindly".

## 10. Authentication and headers

`src/auth.ts`:

- `resolveAuth(ctx, model)` calls
  `ctx.modelRegistry.getApiKeyAndHeaders(model)` inside try/catch.
- On success with no `apiKey` and no auth header
  (`authorization`, `x-api-key`, or `x-goog-api-key`), it falls back to
  `getEnvApiKey(model.provider)` from `@earendil-works/pi-ai/compat`.
- Explicit registry headers are always preserved. Null header values are dropped
  from `ResolvedAuth`, whose header values are strings.
- `baseUrlFor(model, auth)` returns `auth.baseUrl || model.baseUrl`.
- `hasEnvAuth(provider)` reports whether an env API key exists.
- Header helpers (`hasAuthHeader`, `hasHeader`, `getHeader`,
  `setHeaderIfAbsent`, `mergeHeaders`) are case-insensitive.
  `mergeHeaders` lets later sources override earlier ones and treats `null` as
  deletion.
- `buildRequestHeaders({ model, ctx, auth, base, bearer, apiKeyHeader })` merges
  base headers, OpenCode session headers, model headers, and auth headers, then
  adds `Authorization: Bearer <key>` and/or an API-key header only when absent.
  Callers add `Content-Type` / `Accept` explicitly.
- `getProviderSessionHeaders(model, ctx)` returns
  `{ "x-opencode-session": sessionId, "x-opencode-client": "pi" }` for
  `opencode` / `opencode-go` providers or an `opencode.ai` hostname, when
  `ctx.sessionManager.getSessionId()` is available.

## 11. HTTP and SSE primitives

`src/providers/http.ts`:

- `HttpError` carries `status` and optional raw `body`.
- `readJson(response)` parses JSON and throws a descriptive `HttpError` on
  invalid JSON.
- `responseError(response, label)` returns an `HttpError` whose message includes
  status and, when present, an OpenAI-compatible `error.message`.
- `errorMessage(error)` and `isAbortError(error, signal?)` normalize errors.

`src/providers/sse.ts` is adapted from
`pi-web-search/src/providers/sse.ts`. `readSseEvents(response, signal, onEvent)`
parses SSE `event:` / `data:` frames, skips malformed JSON and `[DONE]`, supports
multi-line data, propagates abort, and stops early when the callback returns
`true`.

## 12. DeepSeek native Search/Fetch API

The DeepSeek provider node owns `src/providers/deepseek.ts` and replaces the
stub. Use the authenticated DeepSeek model and API key resolved by
`resolveAuth`; do not silently send DeepSeek credentials to a different host.

Endpoints:

```text
POST https://api.deepseek.com/v1/tools/search
POST https://api.deepseek.com/v1/tools/fetch
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

Search request:

```json
{ "query": "search text", "count": 10, "need_content": true }
```

- `query` is required and must be 1-128 Unicode characters.
- `count` is 1-50; use 10.
- `need_content` is `true`.

Search response:

```json
{ "results": [ ... ] }
```

Preserve each result object exactly as returned. Known fields include
`rerank_score`, `title`, `url`, `snippet`, `summary`, `content`, `site_name`,
`site_icon`, `date`, and `authority`. Return the raw `results` array; do not
map, normalize, filter, dedupe, or summarize it.

Fetch request:

```json
{ "url": "https://example.com/page" }
```

- URL must be at most 8192 characters.
- URL must use HTTP or HTTPS, include a host, and include no username/password.

Fetch response:

```json
{ "title": "Page title", "content": "Page content" }
```

Preserve the response raw in the fetch entry's `data`.

Errors use the OpenAI-compatible shape:

```json
{ "error": { "message": "...", "type": "...", "param": null, "code": "..." } }
```

Use `responseError(response, "DeepSeek")` so the message is extracted. On any
provider error, throw to the orchestrator so it can switch providers. Do not
retry the same provider in the DeepSeek adapter. Honor the abort signal.

## 13. Source references

Reference source (read-only, do not edit):

- `pi-web-search/src/providers/sse.ts` (SSE reader basis)
- `pi-web-search/src/providers/auth.ts` (auth fallback and OpenCode header idea)
- `pi-web-search/src/providers/config.ts` (family detection basis)
- `pi-web-search/src/providers/google.ts`, `openai.ts`, `anthropic.ts`,
  `ollama.ts` (provider request/stream reference; not all behavior is retained)
- `pi-web-search/src/format.ts`, `web_search.ts`, `index.ts` (anti-patterns:
  post-processing, appended source sections, separate `url_context`)
- `../pi/packages/coding-agent/src/core/extensions/types.ts` (extension, tool,
  context, and event contracts)
- `../pi/packages/coding-agent/src/core/model-registry.ts` (auth and available
  model APIs)
- `../pi/packages/coding-agent/docs/extensions.md` (extension lifecycle, tools,
  exposure, active tool set)

In this checkout the reference sources were obtained from npm
`pi-web-search@1.7.0` and `@earendil-works/pi-*@1.3.0` because the repository
`pi-web-search/` gitlink was empty.

## 14. Testing commands

```bash
npm install
npm test
npx tsc --noEmit
```

The test script is `node --test tests/*.test.mjs`. To run only this node's
primitive tests:

```bash
node --test tests/primitives.test.mjs
```

Tests run under Node 24 native TypeScript type stripping and import `src/*.ts`
directly. Keep TypeScript erasable and keep explicit `.ts` relative import
extensions.

## 15. Handoff checklist

1. Implement `src/candidates.ts` for authenticated candidate discovery,
   fingerprint freshness, deterministic ordering, and exposure decisions.
2. Implement `src/search.ts` for runtime validation, search/fetch attempts,
   cache writes, raw output assembly, truncation, and clear aggregate errors.
3. Replace `src/index.ts` with the single `web_search` registration. Use a
   direct tool that is activated or hidden through `pi.setActiveTools`, and
   re-register the schema variant when URL support changes. Do not add prompt
   snippets, guidelines, loadout hooks, system-prompt handlers, commands,
   providers, or another tool.
4. Provider nodes replace the five stub modules. Keep exported adapter names,
   capability flags, raw-result behavior, and no-retry semantics.
5. Re-run `npm test` and `npx tsc --noEmit`.
