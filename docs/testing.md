# Testing

These commands run from a repository checkout.

## Test suite

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
```

- `npm run check` runs `tsc --noEmit`.
- `npm test` runs the unit and integration tests with Node's test runner.
- `npm run verify:package` runs `npm pack --dry-run --json` and checks that the
  tarball contains runtime sources, docs, assets, and metadata, while excluding
  tests, scripts, CI files, the local reference checkout, and `DESIGN.md`.
- `npm run build` runs the checks, tests, package verification, and packs
  `dist/pi-better-web-search-1.0.3.tgz`.

Tests import the TypeScript sources directly. The suite mocks `globalThis.fetch`
and uses temporary cache directories. Coverage includes:

- exposure and schema variants (query-only vs query+urls);
- capability-aware tool/field guidance, source verification/citation, optional
  search refinement, no invented global query limit or extra parameters, and
  explicit search-to-search-to-fetch calls without an automatic fixed chain;
- four-provider terminal login with masked typing/paste, cancellation, local-TUI
  gating, immediate API exposure, persisted/env key precedence, safe status and
  logout, independent credential storage, atomic concurrent updates, corrupt
  store/save failure handling and secret-free notifications/settings/cache;
- dedicated API protocols, standard Perplexity search (no fast/effort/Agent API),
  Keenable keyed/public pro search and live GET fetch, Exa 10-result highlights
  search and full-text `/contents` fetch, per-URL statuses, reordered/redirected
  results, duplicate URLs, source metadata, omission of response-level billing,
  request tracking and processing time fields, retained provider timestamps such
  as Perplexity `server_time`, Exa notices and nested same-name fields,
  standalone exposure, explicit/configured/native ordering and fallback;
- API configuration menus, public-access consent, secret-free persistence,
  credential redaction and Retry-After seconds/HTTP-date behavior;
- atomic settings/cache replacement with injected partial-write and rename
  failures, first-write cleanup and file-symlink compatibility; four simulated
  symlink tests run on every platform, while two real filesystem checks report
  the OS error and skip if link creation is unavailable (e.g. Windows `EPERM`);
- runtime Keenable consent/key checks across combined calls and URL batches,
  preserved partial results after key loss or consent revocation, and matching
  public/keyed endpoint/header snapshots;
- abort-classification false positives in URLs/provider bodies/malformed JSON,
  and safe typed transport AbortErrors during credential rotation;
- release regressions: standalone DeepSeek cross-phase Retry-After, credential
  rotation, pre-HTTP header validation, partial URL preservation and cancellation;
  Exa in-flight key-rotation redaction and canonical-URL error statuses; bounded
  HTTP error cleanup even when underlying stream cancellation never settles;
  a subprocess-mocked DeepSeek smoke test that cannot call unrelated APIs;
- pi 1.5.2 registry integration using isolated credential/model stores: official
  DeepSeek pi-login and `models.json` auth with an empty chat snapshot, native
  Search/Fetch without a flash id, provider menus/tool exposure, proxy/header
  preservation, login/logout fingerprints, rotation redaction and fallback;
- strict luna/haiku/flash eligibility for inference-backed routes and numeric newest-version ordering;
- explicit/current-provider/cache/family ordering without pinning an older model;
- terminal provider pickers, independent persistent search/fetch choices, Auto,
  cancellation, unavailable choices, and save failures;
- selected-provider fallback, per-URL partial success, cooldown/recovery, and
  separation of explicit preferences from success-cache fingerprints;
- terminal search/fetch labels and native API routes without inference-model labels;
- current-provider hints with unsupported conversation APIs, and single-snapshot
  candidate discovery/cache fingerprints;
- raw result preservation (duplicate URLs, tracking parameters, junk-looking
  URLs, unknown fields);
- search and fetch fallback, including per-URL fallback and partial successes
  preserved across transport/global HTTP failures;
- independent partial success: preserve search when fetch is unavailable/fails,
  and fetched pages when search is unavailable/fails, including query-length
  rejection; complete-failure aggregation and explicit cancellation;
- provider request shapes and SSE parsing (CR/LF/CRLF, chunk boundaries, empty
  frames, `[DONE]`, cancellation of pending reads, per-frame/unfinished-line
  bounds, and larger streams containing individually bounded frames);
- response lifecycle regressions: timeout cancellation of stalled JSON bodies,
  late header cleanup, non-settling source cancellation, disposed deadline guards,
  and suppression of late search/fetch updates after timeout or success;
- literal/JSON-escaped credential redaction, overlapping secrets, HTTP status
  text/error codes and transport errors during in-flight key rotation;
- native OpenAI/xAI/Anthropic terminal events on connections that stay open,
  Anthropic search-tool evidence checks and non-object stream frames;
- native transport/SSE/JSON error redaction, captured credential headers in
  record/tuple/Headers forms, structured error bodies, preserved failure metadata,
  synchronous failures/header mutation and exact external cancellation reasons;
- HTTP/stream errors, abort propagation, and already-aborted adapter rejections;
- invalid/fractional/overflowing timeout configuration;
- collapsed-result failure counts and truncation warnings;
- structured character-guard truncation, a single trailing marker, valid JSON
  before the marker, Unicode and escaping, boundary lengths, fair allocation,
  and intact links and identifiers across search results and fetched pages;
- one-tool registration and no system-prompt hooks.

## Live dedicated API test

```bash
npm run test:live:search-apis -- all
# Or select perplexity / keenable / exa instead of all.
```

This opt-in test prints only HTTP status/response shape, never credentials or
request headers. It reads saved login keys first, then environment fallbacks
(`PERPLEXITY_API_KEY`, `EXA_API_KEY`, `KEENABLE_API_KEY`); Perplexity and Exa are
skipped without either source. Create keys at https://console.perplexity.ai or
https://dashboard.exa.ai/api-keys and use `/pi-better-web-search login` in pi's
terminal. With a key, the Exa probe checks both highlights search and full-text
fetch. Keenable uses public endpoints if neither key source is present. It sends only a public example
query and URL, stops a provider after any failure, and may consume quota.
See [dedicated APIs](search-apis.md). Unit tests never use inherited real keys.

## Live DeepSeek test

This is opt-in and consumes DeepSeek API usage. The key is read from the saved
login store first, then `DEEPSEEK_API_KEY`, and is never printed or committed.
The script isolates both cache and settings in a temporary directory and disables
standalone API discovery to exercise native DeepSeek fallback only. Other saved
or environment search-API keys cannot cause unrelated provider usage.

```bash
DEEPSEEK_API_KEY=... npm run test:live:deepseek
```

Optional inputs:

```bash
PI_BWS_TEST_QUERY="DeepSeek V4 模型 发布" \
PI_BWS_TEST_URL="https://example.com" \
DEEPSEEK_API_KEY=... npm run test:live:deepseek
```

The script checks:

1. `deepseekAdapter.search()` returns a non-empty raw results array with title,
   URL, and summary/content fields.
2. `deepseekAdapter.fetch()` returns a raw page with title and content.
3. `runWebSearch()` with an unsupported current model and an authenticated
   DeepSeek provider auto-switches to DeepSeek, returns raw search results plus
   the fetched page, and writes a temporary cache entry.

Use a throwaway cache path or the script's temporary directory. Do not point
the live test at a production cache.

## Real pi process check

The strongest end-to-end check uses a mock current model that does not support
search and a real DeepSeek credential:

1. Create an isolated `PI_CODING_AGENT_DIR`.
2. Add a local `models.json` with an `openai-completions` mock provider and a
   `deepseek` provider with an eligible `deepseek-v4-flash` candidate whose
   `apiKey` is `"$DEEPSEEK_API_KEY"`.
3. Start a local OpenAI-compatible mock server. On the first request, return a
   `web_search` tool call. On the second request, return a final text answer.
4. Run:

   ```bash
   DEEPSEEK_API_KEY=... \
   PI_CODING_AGENT_DIR=/tmp/pi-bws-e2e/agent \
   PI_BETTER_WEB_SEARCH_CACHE=/tmp/pi-bws-e2e/cache.json \
   pi --no-session --print --mode json \
     --provider mock-chat --model mock-chat/mock-chat-model \
     -e ./extensions/index.ts "please search the web"
   ```

5. Inspect the second model request. The tool result must be valid raw JSON with
   a non-empty `search.results` array and the expected raw search fields.
   `details.provider` and the cache must identify DeepSeek; routing is not
   inserted into the raw `search` payload.
6. Confirm `web_search` was declared in the first request even though the
   current mock model cannot search.

This check validates pi's registration lifecycle, dynamic exposure, tool
execution, provider switching, the real DeepSeek API, and cache persistence.

## CI

**Pi 1.5.2 verified** means type checking and automated tests pass against the
pinned pi 1.5.2 host dependencies. It does not imply live verification of every
provider. The GitHub Actions workflow runs on Node 22 and 24:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
```

Live provider tests are not run in CI because they require external credentials
and may consume paid usage.

## What is not covered

- Live credentials for every provider family. OpenAI, xAI, Anthropic, Google,
  and Ollama adapters are covered with mocked requests and streams.
- Model answer quality or search ranking quality. The extension returns provider
  output; it does not evaluate it.
- Provider pricing or quota behavior.
