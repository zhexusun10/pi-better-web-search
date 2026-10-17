## Summary

Describe the behavior change and the provider or exposure path affected.

## Checklist

- [ ] `npm run check` passes.
- [ ] `npm test` passes.
- [ ] `npm run verify:package` passes when package contents changed.
- [ ] Added or updated regression tests for the changed behavior.
- [ ] Updated `docs/providers.md`, `docs/architecture.md`, or `CHANGELOG.md` when needed.
- [ ] No API keys, OAuth tokens, private prompts, or full session transcripts.
- [ ] The extension still registers only `web_search` and does not modify pi's system prompt.
- [ ] Provider results are still returned raw; only the final character guard transforms output.
- [ ] `urls` is hidden when no usable provider supports URL analysis.
