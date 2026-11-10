# Changelog

## 0.1.11

- Increase the default timeout to 120 seconds per search and URL fetch attempt
  for all providers. Provider errors still trigger fallback immediately, and
  `PI_BETTER_WEB_SEARCH_TIMEOUT_MS` can override the default.

## 0.1.10

- Verify against Pi 1.5.2 and document support for the OpenAI ChatGPT OAuth
  login as well as OpenAI API keys and legacy Codex OAuth.
- Use the lowest model-supported reasoning effort for OpenAI Responses search,
  independently of the conversation's thinking level, as in pi-web-search.
- Document that Pi virtual models are not directly supported.

## 0.1.9

- Preserve provider diversity and apply cooldowns before limiting actual search
  and fetch attempts, so skipped siblings cannot crowd out healthy providers.
- Reject DeepSeek search queries over 128 Unicode characters with a generic,
  actionable `Search query is too long` error instead of silently shortening
  them or trying a fallback.
- Distinguish model-access 403 errors from provider-wide failures, and track
  URL-fetch transport failures while preserving partial successes.
- Count concurrent failures during one cooldown as a single outage; increase
  backoff only when a subsequent attempt after expiry also fails.
- Bound HTTP error bodies, individual attempt messages, and model-facing error
  text. Fix Claude version parsing when a date follows the major version.
- Clarify that brand ranking only covers supported APIs, and test OpenCode Go
  against the actual pi model catalog rather than a fabricated API assignment.

## 0.1.8

- Shorten overlong DeepSeek search queries at a word boundary before sending
  them to the provider. DeepSeek rejects queries above 128 Unicode characters,
  so concurrent agent search batches with long queries previously failed with
  the generic unavailable error while shorter sibling calls succeeded. The
  original query remains in the model-facing output.
- Return the provider errors when every search attempt fails, instead of
  replacing them with the generic unavailable message. For example, an OpenAI
  timeout and a DeepSeek validation error are now both visible to the model.
- Remember provider-wide and model-specific failures per search/fetch phase and
  move the failed provider or model behind healthy candidates on later calls.
  The cooldown is exponential (60s to 10 minutes) and is cleared by a
  successful call. Configure with `PI_BETTER_WEB_SEARCH_FAILURE_COOLDOWN_MS`;
  set it to `0` to disable.
- Surface provider error text without prepending provider/model labels to the
  model-facing message.
- Rank GPT and Claude models by version number first, newest first; capability
  tier is now only a tiebreaker for the same version. Add the
  OpenAI `terra` tier between `luna` and `sol`. This prevents an older
  `gpt-5.6-luna` from outranking newer `gpt-6.1-sol`/`gpt-6.1-terra` models.
  `gpt-6-luna` now outranks `gpt-5.6-luna`.
- Order model brands inside a provider family as DeepSeek, OpenAI, Claude,
  Gemini/Gemma, then other gateway brands. For non-tiered brands, order model
  variants as `flash → base → pro` before comparing versions.
- Alternate fallback now includes sibling models from the current model's
  provider id. A provider-wide failure still skips that provider, while a
  model-specific failure can use a newer sibling instead of jumping to another
  provider.

## 0.1.7

- Keep recognized URL/URI/link and title/name/ID fields intact when truncating;
  omit entries that cannot fit rather than returning partial links. Preserve
  provider order and drop incomplete URL tokens at text boundaries.
- Raise the default model-facing output limit from 64,000 to 96,000 Unicode
  code points; the environment override remains available.
- Replace model-facing truncation metadata and per-string markers with a single
  `[truncated]` line at the end of oversized results. Keep the existing fair
  allocation across search results and fetched pages.

## 0.1.6

- Keep oversized results as valid JSON, sharing the character budget across
  search results and fetched pages rather than cutting off the serialized tail.
  Report affected paths and mark shortened strings; retain unchanged provider
  data when it fits, and compact whitespace before dropping data.
- Fix premature truncation immediately below the configured output limit.

## 0.1.5

- Rank models inside a provider family by capability tier first (cheapest tier
  wins) and version number second, newest first. OpenAI tiers are
  `luna → sol → astra` and Claude tiers are `haiku → sonnet → opus → fable`;
  other families have no named tiers and sort purely by version. This replaces
  the previous regex-based "likely search-capable" ordering, so legacy models
  no longer win a lexicographic tie-break and large tiers are not called while
  a cheaper sibling is available.
- Add a deeper fallback pass: after one candidate per family, alternate models
  from other families are tried round-robin, so a provider account that rejects
  a specific model (legacy id, account tier, regional availability) can still
  serve a sibling model. Only the current model's provider id is excluded; a
  different provider id in the same family is still tried.
- Classify failures for both search and fetch: provider-wide errors
  (401/403/429, 5xx, insufficient balance, network failure, timeout, malformed
  request header) skip the rest of that provider, while model-specific errors
  keep trying sibling models.

## 0.1.4

- Return `Failed: This tool is not available in this conversation.` when all
  search providers fail during execution, preventing leaking internal provider
  attempt errors to the model.
- Return `Failed: URL fetch is not available in this conversation.` when URL
  fetching is requested but no URL-capable provider is available.
- Technical attempt errors and provider routing remain recorded in
  `details.attempts` for logs and UI inspection.

## 0.1.3

- Simplify error message when no supported provider is available: return
  `Failed: This tool is not available in this conversation.` instead of exposing
  internal provider and credential configuration instructions to the model.

## 0.1.2

- Remove provider/model routing metadata from the model-facing JSON output
  (`search` and `fetched[]`). Routing metadata remains in `details` for UI and
  logs and is not sent to the model.
- Update the architecture diagram to show all 10 supported provider classes
  plus Anthropic Messages.
- Refresh the README, Chinese README, design notes, and architecture docs for the
  new output shape.
- Verification: 116 tests pass, and the package contents pass verification.

## 0.1.1

- Align directory structure with Pi extension conventions (`extensions/index.ts` and `lib/`), eliminating the `:src` suffix in Pi's startup banner.
- Highlight and expand documentation for all 10 supported provider classes: DeepSeek, Google Gemini, Google Antigravity, Ollama Cloud, OpenAI, Azure OpenAI, OpenAI Codex, GitHub Copilot, OpenCode, and xAI Grok (plus Anthropic Messages).

## 0.1.0

Initial release of `pi-better-web-search`.

- Add one model-callable tool, `web_search`. No separate `url_context` tool.
- Support provider-native search through DeepSeek, Ollama Cloud, Google Gemini
  and Antigravity, OpenAI/Azure/Codex/Copilot/OpenCode Responses, xAI Grok, and
  Anthropic Messages.
- Add native DeepSeek Search/Fetch support:
  `/v1/tools/search` and `/v1/tools/fetch`, with Bearer authentication,
  `count: 10`, and `need_content: true`.
- Hide the tool when the current model has no compatible search interface and
  no compatible provider is authenticated.
- Expose the optional `urls` field only when a usable provider supports URL
  analysis. `urls` can be used without `query`.
- Add automatic provider fallback. When the current model does not support
  search, use a remembered compatible provider first, then try provider
  families in a deterministic order.
- Add a preference cache under pi's agent directory with separate search and
  fetch entries and an available-model fingerprint. Adding or removing a
  provider/login/API key invalidates old preferences.
- Return provider data as-is inside a small JSON wrapper. Do not deduplicate,
  normalize URLs, filter junk URLs, re-rank, summarize, or insert citation
  markers.
- Guard model-facing output with a 64,000-character limit by default; override
  with `PI_BETTER_WEB_SEARCH_MAX_CHARS`.
- Add CI, package verification, live DeepSeek test tooling, architecture and
  provider documentation, and a Chinese README.
- Verification: 116 tests, a real DeepSeek Search/Fetch run, and a real pi
  process end-to-end run with an unsupported current model and DeepSeek
  credentials.
