# Providers

The extension selects a provider family from the authenticated model's
provider id, API id, and base URL. Each adapter owns one family's request shape,
authentication, stream parsing, and error behavior.

| Family | Detection | Search | URL analysis | Interface |
| --- | --- | --- | --- | --- |
| DeepSeek | provider `deepseek` | Yes | Yes | Native `/v1/tools/search`, `/v1/tools/fetch` |
| Ollama | provider `ollama-cloud` or host `ollama.com` | Yes | Yes | `/api/web_search`, `/api/web_fetch` |
| Google | api `google-generative-ai`, provider/api `antigravity` | Yes | Yes | `google_search`, `url_context` |
| OpenAI | api `openai-responses`, `azure-openai-responses`, `openai-codex-responses` | Yes | No | Responses `web_search` |
| xAI | provider `xai` with `openai-responses` | Yes | No | Responses `web_search` |
| Anthropic | api `anthropic-messages` | Yes | No | Messages `web_search` |

A model whose API is `openai-completions` is not search-capable unless it is
served by DeepSeek or Ollama Cloud. A local Ollama daemon is not supported;
Ollama Cloud uses the hosted REST API.

## DeepSeek

DeepSeek uses the documented native Search/Fetch API rather than the older
Anthropic-compatible chat route.

### Authentication and base URL

```text
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

Credentials come from pi's model registry/login flow or `DEEPSEEK_API_KEY`. The
adapter starts from the resolved model/auth base URL and removes a trailing
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

- `query` is 1–128 Unicode characters, not all whitespace. Search operators are
  passed through unchanged.
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

The request uses `tools: [{ "type": "web_search" }]`, `stream: true`, and
`store: false`. Endpoint resolution appends `/responses`, or
`/codex/responses` for Codex models. Codex requests add the account id header,
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

1. Add a family to `src/providers/types.ts` if it is genuinely new.
2. Create `src/providers/<family>.ts` exporting a `ProviderAdapter`.
3. Register it in `src/providers/index.ts`.
4. Add family detection in `src/families.ts`.
5. Add tests for request shape, auth/header preservation, raw result
   preservation, search evidence, errors, aborts, and URL behavior.
6. Update this document, `README.md`, and `CHANGELOG.md`.

Keep provider results raw. If the provider returns an answer, keep it as the
provider returned it. If it returns result objects, preserve their fields and
order. Do not add a normalization layer.
