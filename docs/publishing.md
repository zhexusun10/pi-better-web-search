# Publishing

The package is built and ready to publish. Publishing is a deliberate manual
step so a maintainer can review the tarball and credentials.

## Preconditions

- `npm ci --ignore-scripts` has been run.
- The version in `package.json` and `CHANGELOG.md` agree.
- No API keys, OAuth tokens, private prompts, or session transcripts are in the
  worktree.
- The repository is clean and CI is green.

## Verify

```bash
npm run check
npm test
npm run verify:package
npm pack --dry-run
```

`verify:package` checks that the tarball contains only runtime sources, docs,
assets, and metadata. It rejects tests, scripts, CI files, `node_modules`, the
local `pi-web-search` reference checkout, `.env` files, and `DESIGN.md`.

## Build the tarball

```bash
npm run build
```

This produces `dist/pi-better-web-search-0.1.7.tgz`. The tarball is not
committed.

## Publish

```bash
npm publish --access public
```

Alternatively, publish the verified tarball directly:

```bash
npm publish dist/pi-better-web-search-0.1.7.tgz --access public
```

`prepublishOnly` reruns the checks, tests, and package verification. npm may
require browser or OTP authentication.

## Tag and release

```bash
git tag -a v0.1.7 -m "v0.1.7"
git push origin v0.1.7
gh release create v0.1.7 dist/pi-better-web-search-0.1.7.tgz \
  --title "v0.1.7" \
  --notes-file /path/to/release-notes.md
```

Attach the verified tarball to the GitHub release. Include provider
compatibility notes and any real-provider verification performed for the
release.

## Verify the published package

```bash
npm view pi-better-web-search version
```

Install it into an isolated pi config directory:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-bws-install pi install npm:pi-better-web-search
PI_CODING_AGENT_DIR=/tmp/pi-bws-install pi list
```

Then start pi and confirm `web_search` appears only when the current model or an
authenticated provider supports search.

## Pi gallery

The `pi-package` keyword makes the package eligible for the Pi gallery. Indexing
is controlled by Pi; a keyword does not guarantee immediate listing. Keep the
`pi.extensions` manifest and `pi.image` metadata valid.

## Packaging rules

- Pi provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and
  `typebox`. They stay in `peerDependencies` and must not be bundled or moved to
  `dependencies`.
- The extension is TypeScript source loaded directly by pi. There is no build
  output to publish.
- Do not include tests, scripts, reference checkouts, local caches, or
  credentials in the tarball.
