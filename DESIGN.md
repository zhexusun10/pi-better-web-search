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
5. **Description/schema semantics**: Both descriptions start with
   `Search the live web and return the most relevant URLs and content.`
   Subsequent guidance must match exposed capabilities: mention fetch only when
   URLs are supported. Explain appropriate search use, source verification/citation
   and optional evidence-driven refinement.
   Field descriptions prefer natural-language retrieval intent and make
   clear that `urls` can be used alone and together with `query`.
6. **System prompt**: Do not modify pi's system prompt. Do not add
   `promptSnippet`, `promptGuidelines`, `prepareLoadout`, system-prompt handlers,
   providers, MCP servers, or any other tool. The only registered tool is
   `web_search`; `/web-search-provider` configures user routing preferences.
   Do not install, register or ship skills. Keep vendor development references
   outside agent skill-discovery directories; description/schema are the only
   model-facing search usage guidance provided by this extension.
7. **DeepSeek**: Add support for DeepSeek's native Search/Fetch API. The provider
   node implements the network calls described in section 10.

## 2. Ownership map

| Path | Owner | Status in this node |
| --- | --- | --- |
| `package.json`, `tsconfig.json`, `.gitignore`, `DESIGN.md` | scaffold | complete |
| `extensions/index.ts` | extension | single tool registration, commands and exposure sync |
| `lib/candidates.ts` | routing | discovery, ordering, exposure, standalone API identities |
| `lib/search.ts` | orchestration | validation, fallback, independent partial success, output |
| `lib/health.ts` | routing | per-phase provider/model failure cooldowns |
| `lib/providers/types.ts`, `index.ts` | shared contract | adapters and capabilities |
| `lib/providers/http.ts`, `sse.ts` | shared primitives | bounded errors, JSON and cancellable streams |
| `lib/providers/dedicated-http.ts` | standalone transport | auth, key validation, redaction, Retry-After |
| `lib/providers/deepseek.ts`, `ollama.ts` | native retrieval | Search/Fetch; DeepSeek also standalone |
| `lib/providers/exa.ts`, `keenable.ts`, `perplexity.ts` | dedicated retrieval | exact native API requests |
| `lib/providers/google.ts`, `openai.ts`, `anthropic.ts` | model-backed search | provider protocols, including xAI |
| `lib/auth.ts`, `families.ts` | provider resolution | registry auth, environment fallback, family detection |
| `lib/credentials.ts`, `secret-input.ts`, `login-command.ts` | terminal credentials | masked entry, separate atomic locked store |
| `lib/preferences.ts`, `provider-command.ts`, `api-command.ts`, `dedicated-config.ts` | settings | per-phase preferences and API toggles |
| `lib/cache.ts` | routing memory | success hints and discovery fingerprint |
| `lib/schema.ts` | tool contract | query-only / query+urls descriptions and schemas |
| `lib/format.ts`, `truncate-json.ts` | output | raw JSON wrapper and structured character guard |
| `lib/render.ts`, `routes.ts` | terminal | actual API routes, progress and partial failures |
| `tests/` | test suite | complete: provider, primitive, exposure, integration |

The reference checkout `pi-web-search/` is read-only and must not be edited.
The implementation was checked against the published npm package
`pi-web-search@1.7.0` because the repository's gitlink was empty. The contract
below is authoritative for this package.

## 3. Runtime invariants and non-goals

- Register one tool only: `web_search`.
- Terminal commands: `/pi-better-web-search login|logout|status`,
  `/web-search-api [deepseek|exa|keenable|perplexity]`, and
  `/web-search-provider [search|fetch]`.
  No keyboard shortcuts, providers, MCP servers, prompt snippets, prompt
  guidelines, loadout hooks, or system-prompt mutation.
- No separate `url_context` tool. URL analysis is an optional `urls` field on
  `web_search`.
- No non-essential runtime dependencies. The package uses TypeBox, pi APIs, and
  Node built-ins.
- Write erasable TypeScript only (Node 24 type stripping): no enums, namespaces,
  or parameter properties. Use `.ts` extensions in relative imports.
- Tests are plain `.mjs` and import `.ts` modules directly.

## 4. Provider families

`lib/families.ts` exposes:

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

`lib/providers/types.ts`:

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
  providerError?: string;
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

`lib/providers/index.ts` exports all adapters and:

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

The routing/orchestration logic lives in `lib/candidates.ts`, `lib/search.ts`,
and `extensions/index.ts`. Use the primitives as follows.

### 6.1 Usable interfaces

A "usable search interface" is a configured standalone API or an available
lightweight chat model whose adapter supports search and whose provider has
credentials. Standalone Perplexity, Keenable, Exa and DeepSeek do not require
model registration or tiers; internal routing identities are not API model ids.
Model-backed routes strictly allow OpenAI `luna`, Claude `haiku`, and `flash`
for other brands, including DeepSeek/Ollama credential candidates. In pi 1.3.0,
`ctx.modelRegistry.getAvailable()` is the primary authenticated-model source;
`ctx.modelRegistry.hasConfiguredAuth(model)` can be used for an explicit check.
A "usable fetch interface" is the same, additionally requiring
`adapter.supportsUrls` and an adapter `fetch` function.

The current model is usable when `isSupportedSearchModel(ctx.model)` is true and
its adapter supports search and its brand's lightweight tier matches. It may
participate even if it is
not in `getAvailable()`, because it is the active authenticated conversation
model.

### 6.2 Exposure

Expose `web_search` when at least one of these is true:

- the current model is a supported lightweight search model; or
- at least one authenticated available lightweight model maps to a family
  adapter with `supportsSearch`; or
- a standalone API is usable with a saved/environment key or explicitly
  consented Keenable public access.

Otherwise keep it hidden. To hide an already registered tool, remove
`web_search` from the active set with `pi.setActiveTools(...)`; pi has no
unregister API. Do not register any other tool.

The `urls` field is hidden unless at least one usable interface (current or
fallback) supports URL fetching. The schema is generated by
`buildWebSearchSchema({ allowUrls })`. Re-register the same `web_search` name
with the appropriate schema when discovery changes (pi replaces a same-name tool
definition). Keep the tool inactive until the new active set is applied. Avoid
`promptSnippet`, `promptGuidelines`, and `prepareLoadout`.

Re-evaluate on `session_start`, `session_tree`, `model_select`, and
`before_agent_start`, and immediately after login or API configuration changes. These handlers must not alter the system prompt.

### 6.3 Deterministic search order

Insert the explicit search provider preference first, if authenticated,
lightweight, and supported, then use this automatic order. Persist provider ids
in `better-web-search-settings.json` independently of the success cache (override
with `PI_BETTER_WEB_SEARCH_SETTINGS`). The terminal command offers separate
search/fetch pickers and Auto to clear either preference. Cancel leaves settings
unchanged. Fingerprint changes and fallback successes never overwrite these
choices; unavailable preferences are ignored until eligible again. A usable
explicit preference gets the first attempt even after health failure or a prior
Retry-After; it never excludes other fallback candidates.

Configured Keenable → Exa → Perplexity → standalone DeepSeek come after the
explicit preference, before native model hints. Health cooldowns reorder only
remaining automatic model routes, not explicit or standalone priorities. Dedicated
APIs bypass model ranking, but retain attempt caps, fallback and Retry-After
(the explicit preference bypasses previous Retry-After for its first request). Credentials are saved separately
from settings/cache; `/pi-better-web-search login` uses only local masked input.
Standalone DeepSeek shares dedicated HTTP Retry-After and key validation; native
model/proxy credentials keep their own resolution path.

Native automatic order, skipping unavailable or unsupported entries:

1. The newest eligible lightweight model of the current provider, not
   necessarily the conversation model.
2. The cached search provider when the fingerprint is current, reselecting its
   newest eligible lightweight model rather than pinning the cached model id.
3. Adapter families in `ADAPTERS` insertion order. For each family, choose one
   eligible model deterministically. Brand order comes first (DeepSeek,
   OpenAI, Claude, Gemini/Gemma, other gateway brands). Compare numeric versions
   newest first inside each brand's required lightweight tier. Claude accepts
   dotted and dashed minors and ignores date suffixes. Gateway models follow
   their brand's tier/version rules, independent of the API family. Ties fall
   back to the lexicographic `provider/id@baseUrl` order. Never fall back to a
   non-lightweight tier, even when no lightweight model works.
4. Prefer unrepresented provider ids, then alternate models from every
   provider, including the current model's provider, round-robin across
   families. A provider-wide failure skips its remaining candidates. Apply
   cooldowns to the full discovery set and cap actual search attempts at 12.
   Brand ranking applies only to already-supported APIs; built-in OpenCode Go
   DeepSeek completions models are not Responses search candidates.

On success, write `{ provider: model.provider, model: model.id }` as
`cache.search` and update `cache.fingerprint`. Preserve a cached `fetch` ref
only when the fingerprint was already current (or that fetch interface was
revalidated in the same call); a stale, unverified ref must not inherit the new
fingerprint. On a provider error, append a `WebSearchAttempt` and continue. A
provider-wide failure (auth, balance, rate limit, network failure, timeout, or
malformed request header) marks the provider id as failed. A model-specific
failure, including an explicit model-access 403, keeps trying siblings. On
abort, stop immediately. Failures are remembered per phase and move automatic
native model routes behind healthy model routes for a 60-second to 10-minute
exponential cooldown, without displacing explicit or standalone priorities. Further
failures during the same cooldown do not extend it; a failed probe after expiry
increases it. A successful operation clears the failure. Search failure must
not prevent independently requested fetch work. Return bounded whole-call
errors only if no requested operation succeeds; otherwise retain successful
data and report the search failure in `search.error`. Routing stays in
`details.attempts`.

### 6.4 Deterministic fetch order

If `urls` is present and URL fetching is allowed, insert the explicit fetch
provider preference first under the same eligibility/auth rules as search,
then configured Keenable → Exa → standalone DeepSeek (Perplexity is search-only),
then this native automatic order:

1. The newest eligible lightweight URL-capable model of the current provider.
2. The newest eligible lightweight URL-capable model of the cached fetch
   provider when the fingerprint is current.
3. Adapter families in `ADAPTERS` insertion order with `supportsUrls`.
4. Alternate URL-capable models from every provider, mirroring search order.
   Cap actual fetch attempts at 6; preserve partial URL successes when a
   provider transport error interrupts a batch.

A search and a fetch may use different providers. Keep provider/model routing
metadata in `details`, not in the model-facing output. Preserve per-URL errors
reported by a provider. If URLs were supplied but no fetch interface exists,
report it in each `fetched[].error` when search succeeded; return a whole-call
error only when there is no successful search or URL fetch. Do not silently
drop failed work or replace successful data with an error. On a successful fetch, write the successful
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

`lib/schema.ts` exports:

- `WEB_SEARCH_TOOL_NAME = "web_search"`
- `WEB_SEARCH_DESCRIPTION`: search/fetch description with usage/evidence guidance
- `WEB_SEARCH_QUERY_ONLY_DESCRIPTION`: search-only counterpart without fetch
- `MAX_URLS = 20`
- `MAX_URL_LENGTH = 8192`
- `TSchema`
- `buildWebSearchSchema({ allowUrls })`
- `buildWebSearchToolDescription({ allowUrls })`

Schema variants:

- `allowUrls: false`: object with required `query` (string, minLength 1).
- `allowUrls: true`: object with optional `query` (string, minLength 1) and
  optional `urls` (array of strings, minItems 1, maxItems 20). Each URL string
  has minLength 1 and maxLength 8192, measured in Unicode code points.

Both variants set `additionalProperties: false`; runtime parsing must reject
unknown arguments too. Neither variant has a top-level `anyOf`. The tool
description is `WEB_SEARCH_DESCRIPTION` when URLs are usable, otherwise
`WEB_SEARCH_QUERY_ONLY_DESCRIPTION`. Only the URL-capable variant's query
field mentions omitting query for URL-only fetching. Query-only descriptions
must not advertise unavailable fetch. Both URL-capable field descriptions
explain that supplying query additionally triggers a separate web search.
Prefer natural-language retrieval queries with relevant time scope and
source preferences; keywords/operators remain valid. Describe refinement as
optional when evidence is insufficient, not an automatic or fixed search chain.
Do not impose a global numeric query limit based on the skills: the 128-code-point
limit belongs only to DeepSeek's adapter, and Exa's 4096-character objective bound
is not a query bound.

## 8. Output and formatting

`lib/format.ts` defines:

```ts
// Positive, finite integer from PI_BETTER_WEB_SEARCH_MAX_CHARS, default 96,000.
export const MAX_OUTPUT_CHARS: number;

export interface WebSearchOutput {
  query?: string;
  search?: {
    error?: string; // Search failed while fetching succeeded.
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
  fields and array entries. Recognized link and identity fields stay whole;
  entries or branches that cannot fit are omitted rather than returning partial
  links, and text cuts do not leave partial URL tokens. Provider order is not
  changed. The JSON portion remains valid and is followed by a single
  `[truncated]` line; no output-size truncation metadata or per-string markers
  are added. The complete text is therefore not valid JSON.
  `details.truncated = true` reports actual data
  loss. When truncation is needed with limits of 11–13 characters, return only
  the marker; smaller limits return a minimal JSON value instead. The cap counts
  Unicode code points, not tokens; there is no continuation cache.
- `formatError(message, details)` normally returns `Failed: <message>` and
  `isError: true`, bounded by `MAX_OUTPUT_CHARS` with a marker when truncated.
  Query-length errors omit the prefix and provider name, beginning directly
  with `Search query is too long`. HTTP error bodies and individual attempt
  messages are bounded separately.
- `resultCount` and `fetchedCount` are metadata only. Do not use them to rewrite
  provider output.

## 9. Cache format and fingerprint

`lib/cache.ts`:

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
  "search": { "provider": "deepseek", "model": "deepseek-v4-flash" },
  "fetch": { "provider": "ollama-cloud", "model": "qwen-4-flash" }
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

`lib/auth.ts`:

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

`lib/providers/http.ts`:

- `HttpError` carries `status` and optional raw `body`.
- `readJson(response)` parses JSON and throws a descriptive `HttpError` on
  invalid JSON.
- `responseError(response, label)` returns an `HttpError` whose message includes
  status and, when present, an OpenAI-compatible `error.message`.
- `errorMessage(error)` and `isAbortError(error, signal?)` normalize errors.

`lib/providers/sse.ts` is adapted from
`pi-web-search/src/providers/sse.ts`. `readSseEvents(response, signal, onEvent)`
parses SSE `event:` / `data:` frames, skips malformed JSON and `[DONE]`, supports
multi-line data, propagates abort, and stops early when the callback returns
`true`.

## 12. DeepSeek native Search/Fetch API

The DeepSeek adapter in `lib/providers/deepseek.ts` replaces the
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

- `query` is required and must be 1-128 Unicode characters. The adapter rejects
  an overlong query before credential resolution or network access. Return the
  actual length, the limit, and an instruction to shorten and retry; do not
  truncate the query, fall back to another search provider, or record a health
  failure. Independently requested URL fetching still runs and can succeed.
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

Tests use native TypeScript type stripping on supported Node versions and import `lib/*.ts`
directly. Keep TypeScript erasable and keep explicit `.ts` relative import
extensions.

## 15. Handoff checklist

1. Verify `lib/candidates.ts` for authenticated and standalone candidate discovery,
   fingerprint freshness, deterministic ordering, and exposure decisions.
2. Verify `lib/search.ts` for runtime validation, search/fetch attempts,
   cache writes, raw output assembly, truncation, and clear aggregate errors.
3. Keep `extensions/index.ts` to a single `web_search` registration. Use a
   direct tool that is activated or hidden through `pi.setActiveTools`, and
   re-register the schema variant when URL support changes. Do not add prompt
   snippets, guidelines, loadout hooks, system-prompt handlers, providers, or
   another tool. Keep login, API configuration and provider-preference commands
   terminal-only; never accept API keys in command arguments.
4. Provider nodes replace the five stub modules. Keep exported adapter names,
   capability flags, raw-result behavior, and no-retry semantics.
5. Re-run `npm test` and `npx tsc --noEmit`.
