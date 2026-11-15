# Providers

Two paths, one tool: **standalone Keenable, Exa, Perplexity and DeepSeek APIs**,
plus native model-provider search. Standalone APIs need only a saved/environment
key; see [setup and exact requests](search-apis.md).

For native model routes, the extension selects an adapter from the authenticated
model's provider id, API id, and base URL. We support **10 native provider classes
plus Anthropic Messages**, each with its own request shape, authentication,
stream parsing, and error behavior:

| # | Provider Class | Detection | Search | URL Analysis | Interface & Endpoint |
|:---:|---|---|:---:|:---:|---|
| 1 | **DeepSeek** | provider `deepseek` | Yes | Yes | Native REST `/v1/tools/search`, `/v1/tools/fetch` |
| 2 | **Google Gemini** | api `google-generative-ai` | Yes | Yes | SSE `google_search`, `url_context` |
| 3 | **Google Antigravity** | provider/api `antigravity` | Yes | Yes | Antigravity enterprise Vertex endpoint & wrapper |
| 4 | **Ollama Cloud** | provider `ollama-cloud` or host `ollama.com` | Yes | Yes | Hosted REST `/api/web_search`, `/api/web_fetch` |
| 5 | **OpenAI** | api `openai-responses` | Yes | No | Responses API `web_search` |
| 6 | **Azure OpenAI** | api `azure-openai-responses` | Yes | No | Azure Responses API `/responses` |
| 7 | **OpenAI Codex** | api `openai-codex-responses` | Yes | No | Codex `/codex/responses` & account tokens |
| 8 | **GitHub Copilot** | Copilot provider/token with Responses | Yes | No | Copilot Responses with token routing & proxy endpoints |
| 9 | **OpenCode** | OpenCode provider with Responses | Yes | No | Responses API with Pi session tracking headers |
| 10 | **xAI (Grok)** | provider `xai` or model `grok*` with Responses | Yes | No | Grok dialect Responses (`action.sources`) |
| * | **Anthropic Messages** | api `anthropic-messages` | Yes | No | Messages API `web_search_20260209` tool & OAuth |

A model whose API is `openai-completions` is not search-capable unless it is
served by the native DeepSeek provider or Ollama Cloud. In particular, the
built-in `opencode-go` DeepSeek models use `openai-completions`; brand ranking
does not make them Responses-compatible or expose them as search candidates.
A local Ollama daemon is not supported; Ollama Cloud uses the hosted REST API.
Pi virtual models (`pi-virtual`) are not directly supported: their routed
concrete model is not known to this extension. The normal fallback can still
select another authenticated concrete model.

## Dedicated retrieval APIs

[DeepSeek, Perplexity, Keenable and Exa](search-apis.md) support independent
saved terminal-login keys with environment fallbacks, without requiring a
conversation model. Run `/pi-better-web-search login` to select a provider and
save a key in a masked local terminal dialog. Standalone DeepSeek uses the
official native endpoints; existing pi model-provider authentication is unchanged. Perplexity uses only
`POST /search` with `search_type: "web"` (never fast), no strength/model
parameters, and no Fetch. Keenable uses pro search and live GET Fetch, with
optional explicitly enabled public endpoints. Exa searches with `numResults: 10`
and nested `contents.highlights: true`, and fetches URLs via `POST /contents`
with top-level `text: true`. Exa HTTP-200 responses are checked for per-URL
failures; only unresolved URLs proceed to fallback.

Configured **Keenable → Exa → Perplexity → standalone DeepSeek** precede
automatic model routing (fetch skips Perplexity); explicit per-phase preferences
still win and fallback remains enabled. Health cooldowns reorder automatic
native routes only, not the explicit or standalone priorities. Search responses
and each fetched raw document are preserved. These services do not participate in model-tier ranking.
The [skill comparison](search-skills.md) explains the approved Exa options and
why no additional model-facing parameter or prompt injection was added.

## Model eligibility

For model-backed interfaces, routing strictly requires OpenAI-brand `luna`, Claude-brand `haiku`, or other
brands' `flash` tier, including gateway models and DeepSeek/Ollama credential
candidates. Select the highest numeric version within the brand's eligible
tier. Current models, cache hints, and fallback cannot bypass this allowlist.
An authenticated native provider with no eligible model does not expose the
tool on its own; configured standalone APIs remain available.

## DeepSeek

DeepSeek uses the documented native Search/Fetch API rather than the older
Anthropic-compatible chat route. Neither endpoint sends a `model` parameter:
choosing a flash candidate selects credentials/base URL, not an inference
model. The terminal displays the actual Search or Fetch API endpoint rather
than a misleading pro/flash chat-model label.

### Authentication and base URL

```text
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

Standalone DeepSeek uses `/pi-better-web-search login` saved keys before
`DEEPSEEK_API_KEY`, always at the official origin. It shares dedicated API
header validation and credential-specific `Retry-After` across search/fetch.
Native model routes still use pi's model registry/login or environment auth;
extension-saved keys are never forwarded to custom gateways. For those routes,
the adapter starts from the resolved model/auth base URL and removes a trailing
`/v1`, `/anthropic`, or `/anthropic/v1` before appending the tool path. Proxy
origins and path prefixes are preserved.

### Search

```http
POST https://api.deepseek.com/v1/tools/search
```

```json
{
  "query": "DeepSeek V4 模型 发布",
  "count": 10,
  "need_content": true
}
```

- `query` is 1–128 Unicode characters, not all whitespace. Longer queries
  return a model-facing error with the actual length and the 128-character
  limit; the model should shorten the query and retry. No DeepSeek search request
  is sent, no automatic truncation or search fallback occurs, and no failure
  cooldown is recorded. Independently requested URL fetching still runs; a
  successful fetch is retained with the query-length message in `search.error`.
- `count` is within the documented 1–50 range; this package uses 10.
- `need_content` is `true`, so `content` can contain the page body. The output
  character guard protects the model context.
- `ori_question` and `localization` are optional and are not sent.
- The response is `{ "results": [...] }`. The raw `results` array is preserved,
  including `rerank_score`, `title`, `url`, `snippet`, `summary`, `content`,
  `site_name`, `site_icon`, `date`, `authority`, and unknown fields.

### Fetch

```http
POST https://api.deepseek.com/v1/tools/fetch
```

```json
{ "url": "https://example.com/page" }
```

URLs must be HTTP/HTTPS, include a host, contain no username/password, and be at
most 8192 characters. The response `{ title, content }` is stored unchanged as
the entry's `data`.

### Errors

DeepSeek uses the OpenAI-compatible error shape:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "param": null,
    "code": "..."
  }
}
```

The adapter extracts the provider message and HTTP status. Search errors and
global fetch errors stop that provider attempt and let the orchestrator switch
providers. `403` and `404` fetch responses are per-URL errors so only that URL
is retried elsewhere. Aborts propagate immediately.

## Ollama Cloud

Ollama Cloud exposes standalone REST endpoints rather than a model tool:

```text
POST {root}/api/web_search   { "query": "...", "max_results": 10 }
POST {root}/api/web_fetch    { "url": "..." }
```

`root` is the resolved base URL with a trailing `/vN` removed. Auth uses
`OLLAMA_API_KEY` or `/login ollama-cloud`. Search returns raw
`{ results: [...] }`; fetch returns raw `{ title, content, links? }`. Per-URL
fetch failures become entries; global failures switch providers.

A local Ollama daemon is out of scope. Only provider `ollama-cloud` or a model
whose base URL host is exactly `ollama.com` uses this family.

## Google Gemini / Antigravity

Search sends `google_search`; URL analysis sends `url_context`. They are
separate calls so search results and fetched pages remain separate raw values.

For `google-generative-ai`, the endpoint is:

```text
{baseUrl}/models/{modelId}:streamGenerateContent?alt=sse
```

The adapter sends `x-goog-api-key` when no auth header is present. Antigravity
uses its internal endpoint, wrapper body, project/model mapping, and platform
headers from the reference implementation.

The search result includes raw `groundingMetadata` chunks, support citations,
and search queries. The fetch result includes the provider answer plus raw
`urlContextMetadata`. The adapter does not resolve vertex redirects, inject
citation markers, sanitize URLs, deduplicate sources, or derive a source list.
For `google-generative-ai`, YouTube URLs are passed as `file_data` parts; other
URLs remain in the text prompt.

## OpenAI / Azure / Codex / Copilot / OpenCode

Supported APIs:

- `openai-responses`
- `azure-openai-responses`
- `openai-codex-responses`

The `openai` provider uses the Responses API with either pi's **Sign in with
ChatGPT** OAuth credentials or an OpenAI API key (`OPENAI_API_KEY` or pi's
registry). Pi resolves and refreshes OAuth credentials; the resulting access
token is sent as a Bearer token. `openai-codex` uses a separate legacy ChatGPT
OAuth flow and Codex endpoint. Search availability depends on the account,
subscription, model and OpenAI service.

The request uses `tools: [{ "type": "web_search" }]`, `stream: true`, and
`store: false`. For reasoning models, the request uses the lowest effort
supported by the model metadata, independently of the conversation's thinking
level; native xAI does not send this setting. Endpoint resolution appends
`/responses`, or `/codex/responses` for Codex models. Codex requests add the account id header,
`originator: codex_cli_rs`, instructions, low verbosity, required tool choice,
and parallel tool calls.

GitHub Copilot uses the credential-specific base URL when pi provides one, with
a compatibility fallback for older proxy tokens. OpenCode requests include the
pi session headers.

The adapter returns raw `web_search_call` items and raw `url_citation`
annotations. It does not insert citation markers, derive sources, deduplicate
results, or normalize URLs. If the provider answers without a search call or
citation, the adapter throws so the orchestrator can fall back.

## xAI Grok

xAI uses the Responses transport with the Grok dialect:

- `input` is a message array with string content.
- `include` is only `web_search_call.action.sources`; Grok rejects
  `web_search_call.results`.
- Native `xai` models and model IDs beginning with `grok` use this dialect.
- `compat.webSearchDialect` can override detection with `"grok"` or
  `"openai"` for gateway-hosted models.

The adapter returns the answer, raw web search calls, raw annotations, and
extracted search queries. It does not rewrite the answer or citations.

## Anthropic Messages

The Anthropic adapter posts to `/v1/messages` (or `/messages` when the base URL
already ends in `/v1`) with:

```json
{
  "tools": [
    {
      "type": "web_search_20260209",
      "name": "web_search",
      "max_uses": 10,
      "allowed_callers": ["direct"]
    }
  ]
}
```

API-key auth uses `x-api-key`. OAuth credentials containing `sk-ant-oat` use
Bearer auth, the Claude Code beta headers, and the Claude Code user agent/system
prompt required by Anthropic's OAuth endpoint. That system prompt belongs to the
nested provider call; it does not modify pi's system prompt.

Raw `server_tool_use`, `web_search_tool_result`, and citation delta objects are
returned. A `web_search_tool_result_error` throws so the orchestrator can switch
providers. Search-only; no URL analysis.

## URL analysis support

Only DeepSeek, Ollama Cloud, and Google Gemini/Antigravity implement `fetch`.
OpenAI, xAI, and Anthropic are search-only.

The `urls` schema field is exposed when any usable candidate supports URL
analysis. Search and URL analysis can use different providers in one call. Each
URL is retried with the next URL-capable provider if the first provider returns
a per-URL error.

## Adding a provider

1. Add a family to `lib/providers/types.ts` if it is genuinely new.
2. Create `lib/providers/<family>.ts` exporting a `ProviderAdapter`.
3. Register it in `lib/providers/index.ts`.
4. Add family detection in `lib/families.ts`.
5. Add tests for request shape, auth/header preservation, raw result
   preservation, search evidence, errors, aborts, and URL behavior.
6. Update this document, `README.md`, and `CHANGELOG.md`.

Keep provider results raw. If the provider returns an answer, keep it as the
provider returned it. If it returns result objects, preserve their fields and
order. Do not add a normalization layer.
