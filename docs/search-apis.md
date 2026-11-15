# Dedicated search APIs

The extension still exposes exactly one model-facing tool, `web_search`, with
`query` / `urls`. Standalone services do not need a pi chat model or a
luna/haiku/flash model id. No SDK or MCP dependency is required: the adapters use
Node's native fetch, existing cancellation, timeout, error and fallback helpers.

This release brings the **three leading independent providers in the
[Artificial Analysis snapshot](https://artificialanalysis.ai/agents/search-api)**
into pi: **Keenable Pro (83), Exa auto (80), and Perplexity medium (80)**, alongside
native DeepSeek Search/Fetch. The no-search baseline is **33**; integrated OpenAI
Web Search scores **74**. See the [original screenshot](../assets/search-index.png)
(15 Nov 2026 snapshot) and [benchmark methodology](https://artificialanalysis.ai/methodology/search-api).

## Interfaces

| Provider | Search | Fetch | Optional environment fallback |
|---|---|---|---|
| DeepSeek | `POST https://api.deepseek.com/v1/tools/search` | `POST https://api.deepseek.com/v1/tools/fetch` | `DEEPSEEK_API_KEY` |
| Perplexity | `POST https://api.perplexity.ai/search` | **No** | `PERPLEXITY_API_KEY` |
| Keenable | `POST https://api.keenable.ai/v1/search` | `GET https://api.keenable.ai/v1/fetch` | `KEENABLE_API_KEY` or explicit public access |
| Exa | `POST https://api.exa.ai/search` | `POST https://api.exa.ai/contents` | `EXA_API_KEY` |

### DeepSeek: native Search/Fetch

Terminal login works without a pi chat model. Both native endpoints use the
resolved saved/environment key as a Bearer credential, and neither sends a
model name. Extension-saved keys are not silently forwarded to arbitrary
custom model gateways. It shares credential-specific `Retry-After` across search and fetch, and rejects
malformed header keys before HTTP. Existing pi model/provider authentication is unchanged.

### Perplexity: standard Search API only

The request is exactly:

```json
{ "query": "your query", "search_type": "web", "max_results": 10 }
```

Authorization is `Bearer <PERPLEXITY_API_KEY>`. **Fast search is not used.**
There is no `effort`, `preset`, `model`, `tools`, conversation state or generated
answer. Neither Agent nor Orchestrator APIs are called. The whole response,
including `results`, `id`, `server_time` and unknown fields, is returned inside
`search` without rewriting the results.

Perplexity alone exposes a query-only schema. Configure Keenable or an existing
URL-capable provider to add `urls`; a combined call can search with Perplexity
and fetch with another provider. A search success is preserved if fetch fails.

Create a key at https://console.perplexity.ai and save it through
`/pi-better-web-search login`. `PERPLEXITY_API_KEY` is an optional fallback. Never paste a key into chat. If a key is
exposed, rotate it in the console. Missing credentials never trigger an
unauthenticated Perplexity request.

### Keenable: pro search and live fetch

Search sends `{ "query": "...", "mode": "pro", "max_results": 10 }`, not the
fast `realtime` mode. Fetch uses GET with URL-encoded `url` and `live=true`,
without an LLM extraction `prompt`. Response objects and metadata are preserved.
Keyed requests use `X-API-Key: <KEENABLE_API_KEY>`.

Without a key, explicit public access uses `/v1/search/public` and
`/v1/fetch/public` with `X-Keenable-Title: pi-better-web-search`. It is **off by
default**. The terminal asks for consent before enabling it: queries, URLs and
results are sent to Keenable under its public data policy and IP rate limits.
Do not send secrets or personal data. Get a production key at
https://docs.keenable.ai/api-keys. An invalid/expired key never silently
switches a request to public access. Each adapter request rechecks public
consent, including later requests in a URL batch. A key disappearing or logout
between search and fetch cannot silently enable public access; completed search
results/pages remain available while unresolved URLs follow normal fallback.

Target errors (404, extraction failure, target-blocked/private-URL 403 codes)
are per-URL failures. Auth, balance, rate limits and provider transport failures
stop that provider's batch while preserving completed pages for fallback.

### Exa: search highlights and full-text fetch

With `X-API-Key: <EXA_API_KEY>`, search sends the user-approved request:

```json
{
  "query": "your query",
  "numResults": 10,
  "contents": { "highlights": true }
}
```

`type` is omitted (server default `auto`). The complete response, including
`requestId`, raw `results`/highlights, `costDollars`, `searchTime` and unknown
fields, is preserved. There is no chat model, SDK, Answer/Agent API or generated
objective. The model-facing contract stays `query` / `urls`; other advanced
options remain off. See the [skill comparison and decision table](search-skills.md).

URL-only calls use `POST /contents` without performing a search:

```json
{ "urls": ["https://example.com/page"], "text": true }
```

Unlike search, extraction options belong at the top level of `/contents`.
Full text is used for known-page fetch, without also requesting highlights or
summary. No forced live crawl, freshness filter or extraction budget is added.
A combined `query` + `urls` call performs both operations independently.

Fetch batches the requested URLs, inspects per-URL `statuses` even on HTTP 200,
and returns each successful raw document unchanged as `fetched[].data`. Error
statuses match either `id` or `url`, including canonical redirect URLs. Error
redaction retains the credential actually sent if login rotates it in flight.
Result identity/URL matching handles reordered responses, omitted pages, redirects with
an original `id`, and repeated input URLs; documents are never paired by array
index. A failed status or missing page text produces a per-URL error. Only
unresolved URLs proceed to another fetch provider, without discarding successful
pages. Global HTTP/transport errors use the shared cooldown/fallback handling.

Create a key at https://dashboard.exa.ai/api-keys and save it with
`/pi-better-web-search login` → Exa. Alternatively set it in the environment of
the process that starts pi; the extension does not automatically load `.env`.
For example, in PowerShell, prompt locally without echoing the key:

```powershell
$key = Read-Host "EXA_API_KEY" -AsSecureString
$env:EXA_API_KEY = [System.Net.NetworkCredential]::new("", $key).Password
Remove-Variable key
pi
```

This sets the key for that terminal and child processes, not permanently. Do
not paste it into chat or commit it. Restart pi if its parent process did not
inherit the variable. Missing credentials never trigger an Exa HTTP request;
explicit enable still requires a key. No real key is bundled with this project.

## Terminal login and configuration

```text
/pi-better-web-search login
```

Choose one of **DeepSeek, Exa, Keenable, or Perplexity** from the four-provider menu,
then type/paste a key into the masked input and press Enter. Esc/Ctrl+C cancels
without changing files. Saved keys take precedence over environment variables;
login enables that API and resyncs the tool immediately, without restarting pi
or switching the conversation model. No billable validation request is sent.
The actual key never enters chat, command arguments, UI output or ordinary
settings. Secret entry is local TUI only, not RPC or print mode.

`/pi-better-web-search status` reports presence only. Re-running login replaces
one saved key without losing the others. `/pi-better-web-search logout` confirms
removal and disables that standalone API; it does not remove environment or
pi conversation-provider credentials. Keenable does not silently switch to
public mode on logout or if a keyed login's credential file disappears. Public
access must be enabled separately with privacy consent. Manual search/fetch
provider choices are preserved.

Keys are stored in `<pi agent dir>/better-web-search-auth.json`, overridable
with `PI_BETTER_WEB_SEARCH_AUTH`. The store is **local plaintext, not encrypted**;
new files use mode 0600 and new parent directories 0700 where supported, with
Windows relying on the user profile's ACLs. Atomic writes and a cross-process
lock protect replacements; a corrupt file is never overwritten by login.
Do not commit/share this file or its backups. No OS keychain dependency is used.

`/web-search-api [deepseek|exa|keenable|perplexity]` remains the enable/disable
menu. It shows readiness and **key presence/source only**, never key values:

- **Automatic**: enable if a saved or environment key is present (the default).
- **Enable**: explicitly enable; non-public APIs still need their keys. Keenable
  can use public access after a privacy confirmation.
- **Disable**: exclude this standalone API even if its key exists.
- **Show setup instructions**: login command, console link and environment name.

Cancelling leaves settings unchanged. Saving immediately resyncs tool exposure
and URL support, without switching the conversation model. If the tool was
manually deactivated, that choice is respected.

`/web-search-provider [search|fetch]` continues to select a preferred provider
per phase, including the configured standalone APIs. Perplexity is absent from
the fetch picker; Keenable and Exa support both phases. Auto resets only that phase's preference.

## Priority and fallback

Search order:

1. Explicit `/web-search-provider search` preference, if usable.
2. Configured Keenable, Exa, Perplexity, then standalone DeepSeek.
3. Existing current-provider, success-cache, native-family and sibling routing.

Fetch follows the same policy: Keenable, Exa, then standalone DeepSeek precede
automatic native routing; Perplexity does not support fetch. Both provider pickers remain preferences, not locks. Search and fetch each allow one initial attempt and up to six fallback attempts. A successful empty search is valid.
The existing partial-success policy applies across dedicated and native APIs.

There are no hidden HTTP retries. `Retry-After` seconds and HTTP dates defer
subsequent requests to that service/credential **across search and fetch**;
other providers can run immediately. An explicit preference bypasses a previous
Retry-After for its first request. Automatic model routes remain subject to health
cooldowns, but those cooldowns never displace the explicit or standalone priorities.
If fallback cannot satisfy the requested operation, the agent receives the
provider's bounded, credential-redacted error body and original `Retry-After`
header. An active standalone backoff also reports its remaining time. Native
provider HTTP errors include the header, but the extension does not enforce a
native-provider backoff or sleep on the agent's behalf.
A 401 needs a corrected key; a 402 needs
credits and is not retried in the same attempt; a 429 is rate limiting. A
credential change does not reuse another credential's Retry-After state.

## Persisted settings

`<pi agent dir>/better-web-search-settings.json` (or
`PI_BETTER_WEB_SEARCH_SETTINGS`) stores only choices/toggles:

```json
{
  "version": 1,
  "search": "perplexity",
  "fetch": "keenable",
  "apis": { "perplexity": true, "keenable": true, "exa": true, "deepseek": true, "keenableKeyRequired": true }
}
```

Keys are stored only in the separate credential file described above, never in
ordinary settings/cache. API availability and credential source join the cache
fingerprint, without credentials or credential hashes. Internal cache/health
identities (`perplexity/search`, `keenable/search-fetch`, `exa/search-fetch`,
`deepseek/search-fetch`) are
**not inference models**, are not registered with pi, and are never sent to the APIs. Terminal
routes show actual endpoints instead.

## Verification

```bash
npm run check
npm test
npm run verify:package
npm run test:live:search-apis -- all
```

The opt-in live test sends only a public example query and URL, prints HTTP
status/response shape, and skips Perplexity/Exa if neither saved nor environment
keys are available. It tests
Keenable's public endpoints if no Keenable key is present. It stops a provider
on failure rather than immediately retrying a 429. API calls may consume quota.

Sources: [Perplexity Search](https://docs.perplexity.ai/api-reference/search-post),
[pricing](https://docs.perplexity.ai/docs/getting-started/pricing),
[rate limits](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers),
[Keenable Search](https://docs.keenable.ai/api-reference/search),
[Fetch](https://docs.keenable.ai/api-reference/fetch),
[errors](https://docs.keenable.ai/errors),
[Exa search reference](https://exa.ai/docs/reference/search),
[Exa contents reference](https://exa.ai/docs/reference/get-contents),
[Exa integration skill](https://github.com/exa-labs/agent-skills/tree/main/skills/build-with-exa).
