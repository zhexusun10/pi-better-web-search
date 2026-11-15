# Search guidance: developer reference notes

This project provides a `web_search` extension, **not any skills**. This is an
ordinary developer document, not an agent skill or automatically injected prompt.

Reviewed vendor sources: `build-with-exa` **0.3.0** and
`keenable-web-search` **1.2.0**. These are different kinds of skills, not a
search-quality benchmark. Installing a skill does not itself configure an API
key or register an MCP server.

| Aspect | Exa `build-with-exa` | Keenable `keenable-web-search` |
|---|---|---|
| Purpose | Developer reference for building Exa integrations | A ready-to-run web search workflow for agents |
| Runtime code | Instructions, SDK/HTTP examples and endpoint references | Bundled `scripts/search.py`, Python 3 standard library |
| Credentials | `EXA_API_KEY` for Exa requests | The bundled script always uses the keyless public endpoint, even if a key is present in the environment |
| Search request | Recommends `/search` with `contents.highlights: true`; agent searches should also supply a model-written `objective` | `/v1/search/public`, `mode: pro`, `X-Keenable-Title: OpenClaw Skill` |
| Other capabilities | Documents contents, structured output, Answer, Agent, monitors, snapshots, SDKs | Site, excluded-host and publication/acquisition-date filters; no bundled fetch command |
| Agent guidance | Natural-language retrieval intent; model supplies query and objective; avoid unrequested filters and extra synthesis | Describe the ideal page, verify important claims by opening relevant pages, cite sources and read API warnings |
| Output | API references, not a runnable result renderer | Formatted results (snippets capped at 400 characters) or full raw JSON with `--json` |
| Errors and privacy | Documents API semantics and ZDR boundaries | A 30-second HTTP timeout, basic errors/429 advice; queries go to a public service with rate limits |

## What belongs in this project

- **Exa: useful as a maintenance reference.** Consult its search/contents and
  prompting references when changing an adapter. Its native raw HTTP examples
  fit this project's dependency-free adapters. Do not ship the entire skill as
  tool description, make every user install the SDK, or replace pi's existing
  agent loop with Exa's SDK tool handlers.
- **Keenable: useful for agents without a search tool; redundant at runtime
  here.** The existing TypeScript adapter already supports keyed/public pro
  search, live fetch, raw responses, cancellation, cooldowns, Retry-After and
  multi-provider fallback. Running its Python script would bypass that routing,
  `/web-search-api` public-access consent, and credential selection. Keep it a
  developer reference or a separately chosen alternative, not a hidden fallback.
- **Neither installation is an MCP integration.** The Keenable repository has
  MCP in its name, but this particular skill runs an HTTP script. Neither skill
  should add a second model-facing search tool to this extension.
- **No live quality comparison was performed.** Instructions and code alone do
  not establish relevance, freshness, reliability, speed or price advantages.

## Distribution and context boundary

The vendor sources were consulted during development only. Their downloaded
skill directories and lockfile have been moved out of the project. There is no
skill installation step, skill registration, bundled Python search script, or
`pi.skills` declaration in this extension. Package verification rejects skill
entrypoints and skill directories.

This distinction matters: Pi can auto-discover project `.agents/skills`, and
Claude Code can discover `.claude/skills`. Merely excluding those directories
from npm would not prevent a development agent from loading local copies.
They are therefore absent from this checkout, not just excluded from publishing.

An active agent still receives the normal `web_search` tool description/schema
and tool results. That is the intended tool interface, not an extra skill or a
system-prompt hook. This developer document is not automatically injected;
explicitly reading it can, of course, put it into that session's context.
Removing files does not erase content already read in an existing conversation;
start a fresh session when that separation is required.

## Keep the two-parameter contract

The model-facing tool stays `web_search({ query?, urls? })`. There is no new
`objective`, `type`, result-count, category, domain or date parameter, and no
system-prompt injection. The user approved these internal API choices without
expanding the tool schema:

- `POST /search` sends `query`, `numResults: 10` and
  `contents: { highlights: true }`. Highlights provide token-efficient page
  excerpts; `type` remains omitted (server default `auto`).
- `POST /contents` handles `urls` with top-level `text: true` for full-page
  context. It does not also request highlights or summaries. Per-URL statuses
  and missing documents are handled independently for fallback.
- The skill's agent pattern also requires a model-written `objective`, passed
  through unchanged. This part is intentionally deferred because the user
  requires two parameters. Do not invent an objective from the query or claim
  that this adapter implements the complete recommended agent pattern.
- Exa and other fetch providers can serve `urls`, independently of which
  provider performs the search.

### Exa choices: approved and still deferred

| Option | What it changes | Current behavior |
|---|---|---|
| `contents.highlights: true` | Adds token-efficient page excerpts without changing the tool schema | Enabled on search, explicitly approved |
| `contents.text` | Broad page context; higher tool-result volume | Not sent |
| `contents.summary` | Exa-side per-page LLM synthesis and extra cost | Not sent; only consider on explicit request |
| `objective` | Broader goal, source priorities/exclusions, facts to extract; skill says the model must write it | Not sent; would require a separately approved way to provide it |
| `type` | Latency/depth choices: `auto`, `lite`, `deep-lite`, `deep`, `deep-reasoning` | Not sent; server `auto` |
| `numResults` | Intentional result-count control | Explicitly set to 10 on search, as requested |
| Category/domain filters | Hard restrictions, not mere source preferences | Not sent |
| Publication-date filters | Enforce a bounded publication window, dropping undated/misdated pages | Not sent; "latest" alone does not warrant them |
| `contents.maxAgeHours` | Cache/crawl freshness, **not** publication recency | Not sent |
| `systemPrompt` / `outputSchema` | Exa-side structured extraction/synthesis, different from pi's system prompt | Not sent |
| `/contents` fetch adapter | Makes Exa usable for known URLs without adding a model parameter | Enabled with top-level `text: true`; inspects per-URL statuses |

Search highlights and known-URL full-text fetch improve evidence without
expanding `query` / `urls`. Do not stack highlights, text and summary. New extraction,
research, recurring monitoring or list-building workflows should be considered
separately, not silently added to this generic tool.

## Applied description and schema guidance

`lib/schema.ts` uses the same provider-neutral opening for both URL-availability
variants, taken verbatim from Exa's sample tool description. The URL-capable
version says:

> Search the live web and return the most relevant URLs and content.
> Use for current information, fact-checking, and documentation lookup.
> Search excerpts may lack context; fetch relevant pages when needed to verify
> important details and cite the source URLs used. If the evidence is insufficient
> or conflicting, refine the query and search again.

The query-only version does not advertise fetch. It instead advises verifying
important details against original sources when possible, citing the source URLs
used, and refining the query when evidence is insufficient or conflicting. Both
versions prefer natural-language queries with relevant time scope and source preferences;
keywords and search operators are still accepted. `urls` can be used alone to
read known pages or verify results. Adding `query` still triggers an independent
search, not just targeted extraction of the supplied pages.

The schema structure, validation limits and adapter request bodies are unchanged.
There is no new argument, top-level union, prompt snippet, system-prompt guideline
or automatic research loop. Keep vendor setup commands, Python paths, hardcoded
filters, Exa-only parameters and the full skill out of every model turn.

### Source wording behind the guidance

Exa's `references/prompting-and-patterns.md`, Query Formulation:

> Exa works best with explicit natural-language intent. Good queries usually encode:

It lists subject, constraint, time window if freshness matters, and source
preference if domain-specific sources matter. Its sample tool description says:

> Use for fresh information beyond the model's training data.

Keenable's `SKILL.md`, Usage:

> Run the bundled script with a natural-language query (describe the ideal page,
> not bare keywords):

> Snippets are starting points. Open the most relevant URL (e.g. with the agent's
> web-fetch tool) before relying on a claim, and cite the source.

We translate these into **preferences**, not a ban on keyword queries, a
requirement to fetch every result, or a promise of real-time crawling. Source
preferences in query text are not guaranteed hard filters.

### Checking "Search excerpts may lack context"

This is our provider-neutral caution, **not a verbatim sentence shared by the
two skills**, nor proof that every provider returns only excerpts. Both sources
support its underlying distinction:

- Keenable explicitly says "Snippets are starting points" and tells the agent
  to open the relevant URL before relying on a claim (Usage, quoted above).
- Exa's `references/prompting-and-patterns.md`, Highlights vs Text, describes
  highlights as selecting "an appropriate excerpt length per page, anchored to
  the search query" and says:

  > use `text` on `/search` only when broad page context is necessary for downstream logic

  This distinguishes query-focused excerpts from broader page context; it does
  not literally state "Search excerpts may lack context."

Keeping **excerpts** and **may** makes the sentence a conditional evidence
warning. It does not label full-text results as snippets or require fetching
every result. Agreement between two vendor skills alone does not establish an
invariant for every supported provider. Also, "live web" here describes web
retrieval, not a guarantee of a fresh live crawl on each call; existing cache and
freshness behavior is unchanged.

### What "URLs and content" means across providers

The shared opening describes the tool's purpose, not a guaranteed normalized
`{ url, content }` response. The adapters preserve provider-specific data:

- Exa requests URLs and highlights on search; known-URL fetch requests page text.
- DeepSeek, Ollama, Perplexity and Keenable preserve raw result objects, commonly
  containing URLs with snippets and/or page content, depending on the provider.
- Google preserves generated answer text and grounding/source metadata, which
  can include redirect URLs. The generated answer is not raw page text.
- OpenAI/xAI and Anthropic preserve generated answer text, native search/tool
  result objects and citations. Returned source excerpts vary; the adapters do
  not manufacture missing page content or source URLs.

URLs can be nested in citations or grounding metadata instead of a flat result
field. "Content" may mean excerpts or generated answers, not necessarily full
source pages. Empty searches, missing optional data and bounded output truncation
mean neither URLs nor source text are guaranteed on every successful call. This
is a code/response-shape review, not a measured provider success-rate claim.

## Query length and chained calls

### Length: no invented cross-provider cap

Neither reviewed vendor reference specifies a numeric maximum or required word count for
`query`. This does not establish that the remote APIs have no limits.

- Exa's search reference says **objective** is "Up to 4096 characters." That
  limit is not for `query`, and objective is not exposed in this project.
- `maxCharacters` in Exa extraction options bounds returned page content or
  highlights, not input query length.
- Keenable's script truncates formatted **snippets** after 400 characters;
  that is output formatting, not a query limit. Its query builder joins CLI
  arguments without imposing a query-length cap.
- Separately, this project's native **DeepSeek** adapter enforces 128 Unicode
  code points. A longer query returns an actionable error without silently
  truncating it or trying a different search provider. This provider-specific
  behavior is not a rule from either skill and is not a global schema limit.

Use focused, self-contained retrieval queries; do not shorten them at the expense
of useful entities, versions or constraints. Do not paste a whole
conversation or ask the search backend to format the final answer. These are
engineering recommendations, not numeric restrictions from the skills. Preserve
longer queries for providers that accept them; shorten on an actionable error.

### Chaining: permitted, not a required fixed sequence

Exa's `SKILL.md`, Search as an LLM Tool, says:

> Repeat the request and handler step until the model replies without tool calls.

This describes the **agent tool-call loop**, not a requirement to search twice,
a fixed research depth, or an automatic loop inside one search request. It also
explicitly permits a later query derived from page evidence:

> Need pages related to a known seed URL: use the search endpoint (`/search`)
> with a query derived from the page (for example title, topic, or text from `/contents`)

Keenable's Research guidance says:

> find papers, primary sources, and background on a topic, then
> read the most relevant pages before drawing conclusions.

Keenable's bundled script itself makes one search request; it does not plan or
execute follow-up searches.

For this project, a useful **optional** agent workflow is:

```text
search(topic)
  -> inspect the evidence
  -> search(a more specific, self-contained query), if evidence is insufficient
  -> fetch(relevant URLs), when verification needs page context and fetch is available
  -> answer with source URLs once the evidence is sufficient
```

For example, a first result might name "Widget v2"; the agent can then call
`web_search({ query: "Widget v2 official release notes" })`, followed by
`web_search({ urls: ["https://example.com/widget-v2"] })`. It need not repeat the
search if the first result already supplies sufficient evidence, or search at
all when the user provides the needed page URL.

Each call explicitly supplies its query/URLs. The extension does not prepend
prior search results or conversation history to the next query; its cache
remembers routing preferences, not a remote research session. Keep new searches
specific enough to stand alone. Avoid identical repeated searches without a new
reason; this is a cost/quality recommendation, not a hard tool-call limit. The
limit of one initial attempt plus six fallbacks per phase bounds provider fallback
**within one call**, not the number of research steps an agent may perform.

Sources: [Exa skill](https://github.com/exa-labs/agent-skills/tree/main/skills/build-with-exa),
[Keenable skill](https://github.com/keenableai/keenable-mcp/tree/main/skills/keenable-web-search).
