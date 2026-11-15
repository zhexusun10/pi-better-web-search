# Security

## Supported versions

Security fixes target the latest `1.x` release.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting:

https://github.com/zhexusun10/pi-better-web-search/security/advisories/new

Include the affected version, pi version, provider, reproduction steps, and
whether credentials or private data may have been exposed. Redact API keys,
OAuth tokens, and private prompts.

## Credentials and data flow

`pi-better-web-search` resolves credentials through pi's model registry on each
call. Standalone APIs first read a saved extension key, then the corresponding
environment variable. `/pi-better-web-search login` accepts a key only in a
masked local TUI component: no plaintext renderer, RPC fallback, command-line
key argument, chat message or key notification. Login makes no validation call.

Keys are persisted separately in `<pi agent dir>/better-web-search-auth.json`
(or `PI_BETTER_WEB_SEARCH_AUTH`). This is **local plaintext, not encryption or
an OS keychain**. New files use mode 0600 and new parent directories 0700 where
supported; Windows relies on the user profile's filesystem ACLs. Writes use a
cross-process lock and atomic replacement. Corrupt stores are not overwritten.
Do not commit, share or export the credential file, its temporary files, or
backups. The default filename is gitignored and rejected by package verification.

Ordinary settings contain only provider ids and enable/disable flags. The
success cache contains only routing identities and an availability fingerprint,
never keys or credential hashes. Saved DeepSeek keys are used for the official
standalone endpoints, not silently sent to arbitrary configured model gateways.

Search queries and requested URLs are sent to the selected provider's API. The
extension has no telemetry, analytics, or third-party service of its own. It may
use any authenticated compatible provider, so a call can incur usage on a
provider other than the current conversation model. Review your provider
accounts and permissions before enabling the extension.

Keenable public/keyless access is disabled by default and requires explicit
terminal opt-in with privacy confirmation. Its public data policy can retain
queries, requested URLs and results; do not send secrets or personal data.
Supplying an invalid key never silently downgrades to public access. Adapter
requests recheck public consent and use one credential snapshot for endpoint
mode and headers, including after key loss/logout during combined calls or URL
batches. Dedicated API error text redacts the key actually sent, including
transport AbortErrors and in-flight key rotation. Native provider network, SSE
and JSON error paths also redact credentials from sent headers and structured
error bodies; parser snippets that could expose partial keys are suppressed.
Successful raw provider output is not rewritten. Exposed keys must be rotated
in the provider console. See [API configuration](docs/search-apis.md).

## Logs and issues

Provider error text can contain request identifiers or response snippets. Tool
results can contain page content. Remove secrets and private data before
sharing logs, tool results, session exports, or cache files in an issue.
