# Changelog

## Unreleased

### Fixes

- Discover official DeepSeek Search/Fetch through pi's provider-level login and
  `models.json` authentication even when the available chat catalog is empty or
  has no flash model. Reuse request-time registry credentials and configured
  endpoints without copying keys or invoking an inference model; expose both
  provider pickers and URL support. Preserve standalone priority and fallback.
- Show all terminal command entrypoints in `/pi-better-web-search` help,
  including independent search/fetch preferences and API settings.

## 1.0.0 — Search is an agent superpower

### The flagship search upgrade

- Bring **Keenable, Exa, and Perplexity**, the top three independent providers
  in the Artificial Analysis Search Index snapshot, plus **DeepSeek native
  Search/Fetch**, directly into pi without requiring a conversation-model change.
- Lead the English/Chinese READMEs with the search advantage: **33 model-only →
  83 with Keenable Pro (+50 points)**. Show why agents should find existing
  libraries, official docs, and proven fixes before spending tokens reinventing
  them. Add a sourced Search Index chart and redraw the architecture for four
  standalone APIs, native fallback, terminal login, and the 96k output guard.

### Regression fixes

- Stop OpenAI/xAI streams on completed/done/incomplete terminal events and
  Anthropic streams on `message_stop`, cancelling connections that remain open
  instead of timing out and discarding usable search results.
- Redact native-provider transport, SSE and JSON errors using a snapshot of sent
  credential headers (including custom API tokens and Bearer/Basic auth). Keep
  status/code metadata for fallback, scrub structured error bodies, and suppress
  JSON parser snippets that could expose a partial credential.
- Require Anthropic server-tool evidence to name `web_search`; unrelated tools
  no longer produce false search success. Skip non-object stream frames safely.
- Atomically replace settings and the success cache after writing/syncing a
  same-directory temporary file. Partial-write and rename failures preserve the
  previous file; configured file symlinks continue to update their targets.
- Recheck Keenable public-access consent before each adapter request, including
  combined calls and URL batches. Key loss/logout no longer downgrades an
  in-flight operation to public endpoints; preserve completed search/pages and
  resolve auth-dependent endpoint paths from the same key snapshot as headers.
- Recognize aborts by signal, structured identity or canonical legacy messages,
  not arbitrary text containing `abort`. Malformed page responses no longer
  discard completed URLs, and dedicated transport AbortErrors remain redacted
  even if credentials rotate while the request is in flight.
- Cancel stalled response bodies and responses arriving after an attempt timeout,
  even when a custom transport ignores the signal. Ignore late adapter updates
  after timeout/completion and prevent disposed deadlines from being restarted.
- Bound individual SSE frames to 4,194,304 UTF-16 code units, including unfinished
  lines and multiline data, while accepting larger streams of bounded frames. Scan
  fragmented lines incrementally instead of repeatedly rescanning their prefix.
- Share literal/JSON-escaped credential redaction across dedicated API errors,
  native DeepSeek errors and Exa per-URL errors. Also redact HTTP status text and
  structured error codes using the credentials actually sent.
- Keep routing priorities strict: **manual preference → Keenable → Exa →
  Perplexity → standalone DeepSeek → native automatic routing**. Manual choices
  get a first probe even after failure or Retry-After; cooldowns reorder only
  remaining automatic model routes. Standalone DeepSeek failures do not suppress
  native DeepSeek candidates using separate authentication.
- Route standalone DeepSeek through shared dedicated HTTP validation/backoff:
  honor credential-specific `Retry-After` across Search/Fetch, reject malformed
  header keys before HTTP, and leave native model/proxy auth unchanged.
- Redact Exa per-URL errors using the key actually sent even if login rotates it
  in flight; honor canonical-URL error statuses that use `url` instead of `id`.
- Release bounded HTTP error streams without awaiting an underlying cancellation
  promise that may never settle, so errors can reach fallback immediately.
- Isolate the live DeepSeek test's settings/cache and disable standalone API
  discovery so other saved/environment search keys cannot trigger unrelated
  provider calls or override the intended native DeepSeek fallback check.

### Implementation details

- Explicitly provide no skills: remove vendor skill copies and their lockfile
  from the checkout, retain only developer reference notes, and reject skill
  directories/entrypoints in package verification. Keep normal tool descriptions,
  schemas and API behavior unchanged; no automatic vendor skill context is added.
- Refine both description variants to address insufficient or conflicting
  evidence and cite the source URLs actually used; make fetch conditional on
  need in the URL-capable version, without adding fetch to search-only guidance.
- Improve capability-aware tool/field descriptions with natural-language
  query guidance, source verification/citation, and optional evidence-driven
  search refinement. Both variants start with the provider-neutral
  `Search the live web and return the most relevant URLs and content.`; only
  URL-capable variants instruct fetching pages. Keep `query` / `urls`, existing validation, adapter requests
  and system prompts unchanged. Document skill wording, provider-specific length
  limits and agent-driven chains without adding a fixed search loop.
- Add `/pi-better-web-search login`: select DeepSeek, Exa, Keenable or Perplexity
  and enter an API key in a masked local terminal dialog. Persist keys separately
  with restricted permissions, cross-process locking and atomic replacement;
  refresh tool exposure immediately without environment setup or a chat model.
  Saved keys override environment keys; preserve manual routing and fallback.
- Add safe presence-only `status` and confirmed `logout` (disables standalone
  access without silently switching Keenable to public mode). Refuse RPC/print
  secret entry and key arguments; preserve cancellation and existing credentials
  on save failures. Credential files are local plaintext, not encrypted.
- Add standalone Exa Search/Fetch with `EXA_API_KEY` and `/web-search-api exa`.
  Search sends the approved `numResults: 10` and `contents.highlights: true`;
  known URLs use `POST /contents` with top-level `text: true`. Inspect per-URL
  statuses even on HTTP 200, preserve successful raw documents, and retry only
  unresolved URLs through existing fallback. Keep safe error redaction,
  cancellation, Retry-After, API priority and the `query` / `urls` contract.
  Document Exa/Keenable skill differences; objective and other advanced options
  remain off; no Exa-specific parameter or system-prompt change is introduced.
- Add standalone Perplexity Search (`POST /search`, `search_type: web`, never
  fast, no model/effort, no Fetch) and Keenable pro Search/live GET Fetch.
  Preserve raw result objects and use existing timeout, cooldown, fallback and
  partial-success handling. Configured APIs precede automatic model routing;
  explicit per-phase provider preferences still win.
- Add `/web-search-api [deepseek|exa|keenable|perplexity]` to enable/disable APIs,
  view safe key setup, and opt into Keenable public access with privacy consent.
  This menu saves toggles only; masked login stores credentials separately. Honor Retry-After
  across dedicated search/fetch calls, and add an opt-in status/shape-only smoke
  test: `npm run test:live:search-apis -- all`. No new runtime dependency or MCP.
- Preserve successful search and URL-fetch data independently. Missing fetch
  capability or fetch failures no longer replace successful search output with
  a whole-call error; failed search (including query-length rejection) no longer
  suppresses requested fetch work. Return partial-success JSON with `search.error`
  and/or per-URL errors, and mark the whole call failed only if no operation
  succeeded. Keep partial search failures visible in collapsed terminal results.
- Add `/web-search-provider [search|fetch]` terminal pickers with independent,
  persistent search/fetch preferences and an Auto reset. Choices precede
  automatic hints without disabling fallback, per-URL retries, or health
  cooldowns; success-cache updates never overwrite explicit preferences.

- Clarify that providing `query` triggers a separate search even with `urls`;
  show URL-only omission guidance only when URL support is exposed. Reject
  additional input arguments in both schemas and at runtime, require non-empty
  URL arrays when supplied, and constrain URL strings to 1–8192 Unicode code
  points consistently with native DeepSeek validation.
- Strictly limit search and URL analysis candidates to OpenAI `luna`, Claude
  `haiku`, and other brands' `flash` models. Select the newest numeric version
  within the eligible brand/tier, including gateways; current-model and cache
  hints now select a provider instead of pinning an older or larger model.
  Never fall back to an excluded tier, and hide the tool without an eligible
  model or configured standalone API.
- Compare dotted/dashed Claude minor versions numerically and ignore date
  suffixes independently of the provider API family.
- Distinguish Search, Fetch, and combined operations in the terminal. Display
  the actual DeepSeek/Ollama standalone API endpoint instead of an inference
  model name; add `details.routes` and progress `details.activeRoute` metadata.
  Raw provider output is unchanged and available in the expanded result.
- Preserve current-provider priority even when the conversation model's API is
  unsupported, and derive discovery/cache fingerprints from one registry snapshot.
- Preserve completed DeepSeek/Ollama URL results after a later global HTTP error;
  only unresolved URLs proceed to fallback. Show failed URL counts and truncation
  warnings in collapsed results.
- Validate timeout overrides against Node's integer timer range and observe
  adapter rejections even when the signal is already aborted.
- Handle SSE CR/LF/CRLF boundaries, data-less event resets, `[DONE]`, and pending
  read cancellation without waiting for the provider connection to close.

### Regression coverage and validation

- Add 62 regression tests across response/deadline lifecycle, late adapter
  updates, bounded/fragmented SSE frames, credential redaction and rotation,
  atomic settings/cache writes, runtime Keenable consent, abort classification,
  native terminal events and search-evidence validation.
- Add four platform-independent simulated symlink tests for settings/cache target
  updates and dangling-link refusal. Keep the real filesystem checks separately.
- Verify on Node 24: 386 tests total, 384 passed, no failures; two real file-symlink
  tests skipped because Windows returns `EPERM` when creating file symlinks.
- Type checking and package verification pass. Provider requests are mocked;
  these checks do not call billable live APIs.

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
