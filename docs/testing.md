# Testing

## Test suite

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
```

- `npm run check` runs `tsc --noEmit`.
- `npm test` runs the 116 unit and integration tests with Node's test runner.
- `npm run verify:package` runs `npm pack --dry-run --json` and checks that the
  tarball contains runtime sources, docs, assets, and metadata, while excluding
  tests, scripts, CI files, the local reference checkout, and `DESIGN.md`.
- `npm run build` runs the checks, tests, package verification, and packs
  `dist/pi-better-web-search-0.1.0.tgz`.

Tests import the TypeScript sources directly. The suite mocks `globalThis.fetch`
and uses temporary cache directories. Coverage includes:

- exposure and schema variants (query-only vs query+urls);
- current-model/cache/family candidate ordering;
- cache fingerprint invalidation;
- raw result preservation (duplicate URLs, tracking parameters, junk-looking
  URLs, unknown fields);
- search and fetch fallback, including per-URL fallback;
- provider request shapes and SSE parsing;
- HTTP/stream errors and abort propagation;
- character-guard truncation;
- one-tool registration and no system-prompt hooks.

## Live DeepSeek test

This is opt-in and consumes DeepSeek API usage. The key is read from
`DEEPSEEK_API_KEY` and is never printed or committed.

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
   `deepseek` provider whose `apiKey` is `"$DEEPSEEK_API_KEY"`.
3. Start a local OpenAI-compatible mock server. On the first request, return a
   `web_search` tool call. On the second request, return a final text answer.
4. Run:

   ```bash
   DEEPSEEK_API_KEY=... \
   PI_CODING_AGENT_DIR=/tmp/pi-bws-e2e/agent \
   PI_BETTER_WEB_SEARCH_CACHE=/tmp/pi-bws-e2e/cache.json \
   pi --no-session --print --mode json \
     --provider mock-chat --model mock-chat/mock-chat-model \
     -e ./src/index.ts "please search the web"
   ```

5. Inspect the second model request. The tool result must be valid raw JSON with
   `search.provider = "deepseek"`, a non-empty `results` array, and the expected
   search fields. The cache must contain the DeepSeek provider/model.
6. Confirm `web_search` was declared in the first request even though the
   current mock model cannot search.

This check validates pi's registration lifecycle, dynamic exposure, tool
execution, provider switching, the real DeepSeek API, and cache persistence.

## CI

The GitHub Actions workflow runs on Node 22 and 24:

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
