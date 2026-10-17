# Contributing

Use English for issues, pull requests, commit messages, and primary
documentation. Chinese translations are welcome.

## Setup

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
```

The extension is TypeScript source loaded directly by pi. There is no compile
step and no runtime dependency to bundle.

## Rules

- Keep exactly one model-callable tool: `web_search`.
- Do not modify pi's system prompt, add prompt snippets/guidelines, or register
  commands, providers, MCP servers, or additional tools.
- Do not post-process provider results. No deduplication, URL normalization,
  junk-URL filtering, re-ranking, summarizing, citation-marker insertion, or
  appended Sources sections. The only output transformation is the final
  character guard.
- Do not call a provider that is not authenticated. Do not use a provider that
  does not support the requested operation.
- Keep the `urls` field hidden when no usable provider supports URL analysis.
- Preserve provider request/SSE quirks: Codex account headers, Copilot base
  URLs, OpenCode session headers, Grok dialect, Antigravity wrappers, and
  Anthropic OAuth requirements.
- Add regression tests for request shape, raw result preservation, errors,
  aborts, exposure, fallback, cache invalidation, and URL handling.
- Update `docs/providers.md`, `docs/architecture.md`, and `CHANGELOG.md` when
  behavior changes.

## Provider work

A provider adapter lives in `lib/providers/<family>.ts` and follows the
`ProviderAdapter` contract in `lib/providers/types.ts`. Return provider data
unchanged. `search()` should throw when the provider did not perform a search;
`fetch()` should return one entry per URL and put per-URL failures in
`entry.error`.

## Live provider tests

The opt-in DeepSeek test requires a real key:

```bash
DEEPSEEK_API_KEY=... npm run test:live:deepseek
```

Optional inputs:

```bash
PI_BWS_TEST_QUERY="DeepSeek V4 模型 发布" \
PI_BWS_TEST_URL="https://example.com" \
DEEPSEEK_API_KEY=... npm run test:live:deepseek
```

Never commit API keys, OAuth tokens, private prompts, full session transcripts,
or generated provider responses containing private data. The preference cache
stores only provider/model identifiers and a fingerprint.

## Commits and pull requests

Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and
`chore:`. Keep pull requests focused. Complete the pull request checklist and
include the pi version, provider/model, and a minimal reproduction when fixing a
provider bug.
