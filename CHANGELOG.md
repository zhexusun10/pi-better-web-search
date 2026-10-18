# Changelog

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
