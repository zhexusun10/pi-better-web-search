# Architecture

`pi-better-web-search` adds one tool and keeps the provider boundary thin. The
extension owns exposure, provider selection, fallback, caching, and a small
output guard. It does not own provider result cleanup.

## Design principles

1. **One model-facing tool.** The extension registers only `web_search`.
2. **Expose only what can work.** The tool is hidden when neither the current
   model nor an authenticated compatible provider can search.
3. **Trust provider output.** Search results, citations, metadata, and fetched
   pages are returned as provider data, not rewritten into a normalized shape.
4. **Use provider-native interfaces.** Each family keeps its request shape,
   authentication quirks, and stream format.
5. **Prefer the current model, remember fallbacks.** A supported current model
   is tried first. An unsupported current model uses the remembered compatible
   provider first.
6. **Do not touch pi's system prompt.** No prompt snippets, guidelines, loadout
   hooks, commands, or extra tools.

## Runtime flow

```text
extension factory
  └─ register web_search with defaultActive: false

session_start / session_tree / model_select / before_agent_start
  └─ sync(ctx)
       ├─ resolve current candidate + authenticated available candidates
       ├─ read preference cache + available-model fingerprint
       ├─ decide expose and allowUrls
       ├─ re-register the same tool name if the schema variant changed
       └─ add/remove web_search from the active tool set

tool execute
  ├─ parse query/urls and validate input
  ├─ run search candidates until one succeeds
  ├─ run fetch candidates per URL until each URL succeeds or candidates end
  ├─ write search/fetch preferences + fingerprint on success
  └─ format raw JSON, truncate only if the character guard is exceeded
```

## Exposure

A candidate is a chat model that maps to a supported provider family and
implements a `ProviderAdapter`. The tool is exposed when:

- the current conversation model maps to a supported family; or
- `modelRegistry.getAvailable()` contains at least one supported family.

`urls` is exposed only when at least one **usable** URL-capable candidate
exists. A current model outside `getAvailable()` must prove registry or
environment authentication. This prevents advertising URL analysis based on an
unauthenticated model.

The tool is registered with `defaultActive: false`. The sync logic adds it to the
active tool set only after the exposure check passes. When the tool is
unavailable, it is removed from the active set; it remains registered under the
same name so a later login or model change can activate it again without
creating a second tool.

The sync logic also remembers an explicit user change to the active set. If the
user removes `web_search` through pi's tool UI, later model changes do not
silently re-add it.

## Candidate ordering

Search candidates:

1. The current model when it supports search.
2. The remembered search provider when the cache fingerprint is current.
3. One candidate per remaining family in this order:
   **DeepSeek → Ollama → Google → OpenAI → xAI → Anthropic**.
4. Remaining authenticated provider interfaces, up to 12 attempts.

Fetch candidates use the same shape but include only adapters with
`supportsUrls` and a `fetch` implementation. The fetch cap is 6 attempts.

Within a family, likely search-capable model IDs rank first (for example
`gpt-5`/`gpt-4.1`/`gpt-4o` for OpenAI, `gemini` for Google, `claude` for
Anthropic, `grok` for xAI). Ties are deterministic. A provider id that was
already selected is not retried with another model.

The current model is preferred when it supports search. The cache is a fallback,
not an override. When the current model is unsupported, the cached provider is
tried first, which avoids repeating discovery on every call.

## Cache and fingerprint

Default cache path:

```text
~/.pi/agent/better-web-search.json
```

Override with `PI_BETTER_WEB_SEARCH_CACHE`. The cache contains:

```ts
{
  version: 1;
  fingerprint?: string;
  search?: { provider: string; model: string };
  fetch?: { provider: string; model: string };
}
```

The fingerprint is a SHA-256 prefix over sorted
`provider/model@baseUrl` values for authenticated chat models. When the
fingerprint changes, cached preferences are ignored for that call and provider
discovery starts again. The cache is rewritten only after a successful search
or fetch. Credentials are never written.

A cache entry is resolved only against the current authenticated model list.
If the exact model is gone, another available model of the same provider id can
be used. A cached provider that is no longer available is ignored.

## Input validation

- `query` is trimmed; search operators are otherwise passed through unchanged.
- `urls` is an array of at most 20 strings.
- Each URL must be HTTP/HTTPS, have a host, omit username/password, and be at
  most 8192 characters.
- At least one non-empty query or valid URL is required.
- Invalid URLs are reported in `fetched` entries when other work is valid.
  If no valid work remains, the tool returns an error.

Search and fetch have separate candidate lists, so a search-only current model
can search while a URL-capable provider handles the URLs.

## Output

The result is a JSON wrapper:

```ts
{
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
```

Fields inside `search` and `fetched[].data` are provider data. The extension does
not deduplicate, normalize, filter, re-rank, summarize, insert citation markers,
or append source sections. The only transformation is the final character
guard: the serialized JSON is truncated at 64,000 characters by default
(`PI_BETTER_WEB_SEARCH_MAX_CHARS`) and marked with `[Truncated]`.

## Provider adapter contract

```ts
interface ProviderAdapter {
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

`search()` throws when the provider did not perform a search. `fetch()` returns
one entry per requested URL; per-URL failures go in `entry.error`. Both honor
the abort signal and resolve credentials through `lib/auth.ts`.

## File map

| Path | Responsibility |
| --- | --- |
| `extensions/index.ts` | Tool registration, exposure sync, lifecycle handlers |
| `lib/candidates.ts` | Current/available candidates, ordering, cache resolution |
| `lib/search.ts` | Input validation, search/fetch fallback, cache writes, output |
| `lib/auth.ts` | Credential resolution, header merging, env fallback |
| `lib/cache.ts` | Preference cache and model-set fingerprint |
| `lib/families.ts` | Provider family detection |
| `lib/schema.ts` | Query-only and query+urls schema variants |
| `lib/format.ts` | JSON wrapper, output guard, success/error results |
| `lib/providers/` | Provider adapters, SSE reader, HTTP helpers |

## Non-goals

- Rewriting provider answers or search results.
- Exposing a second tool or changing pi's system prompt.
- Reusing credentials for a provider the user has not authenticated.
- Retrying the same provider indefinitely on rate limits or server errors.
- Providing telemetry or a hosted search service.

For the original implementation handoff and detailed invariants, see the
internal [`DESIGN.md`](https://github.com/zhexusun10/pi-better-web-search/blob/main/DESIGN.md)
in the repository.
