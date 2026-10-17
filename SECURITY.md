# Security

## Supported versions

Security fixes target the latest `0.1.x` release.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting:

https://github.com/zhexusun10/pi-better-web-search/security/advisories/new

Include the affected version, pi version, provider, reproduction steps, and
whether credentials or private data may have been exposed. Redact API keys,
OAuth tokens, and private prompts.

## Credentials and data flow

`pi-better-web-search` resolves credentials through pi's model registry on each
call. It does not store API keys or OAuth tokens. The preference cache contains
only provider/model identifiers and a hash fingerprint of the available model
set.

Search queries and requested URLs are sent to the selected provider's API. The
extension has no telemetry, analytics, or third-party service of its own. It may
use any authenticated compatible provider, so a call can incur usage on a
provider other than the current conversation model. Review your provider
accounts and permissions before enabling the extension.

## Logs and issues

Provider error text can contain request identifiers or response snippets. Tool
results can contain page content. Remove secrets and private data before
sharing logs, tool results, session exports, or cache files in an issue.
