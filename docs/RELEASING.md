# Releasing

Releases are published manually from a local terminal for now.

## Requirements

- npm account with publish rights on `opfslogd`
- 2FA enabled on that account (npm requires it to publish; new setups use a security key / passkey)

## Steps

1. Make sure `main` is clean and CI is green.
2. Bump the version (pick `patch`, `minor`, or `major`):
   ```sh
   npm version patch
   ```
   This updates `package.json`, commits, and creates a `vX.Y.Z` tag.
3. Push the commit and tag:
   ```sh
   git push --follow-tags
   ```
4. Publish **from a regular terminal app** (Terminal, iTerm, etc.):
   ```sh
   pnpm publish --access public
   ```
   - `prepublishOnly` runs typecheck, test, and build first.
   - npm prints an auth URL and waits. Open it, approve with your passkey, and the publish continues.
   - Do not run this through a non-interactive shell (for example Claude Code's `!` prompt). npm cannot wait for browser auth there and fails with `EOTP`.
5. Verify. `--prefer-online` skips npm's local cache:
   ```sh
   npm view opfslogd versions dist-tags --prefer-online
   ```
   npm may say "Your package is being processed". The new version can take a few minutes to appear, and a temporary `0.0.0-stage` entry may show up while it is processed.

## Versioning

- `0.x` while the API is unstable. Breaking changes bump the minor version.
- Never reuse a version number. npm rejects it, even after an unpublish.
- `npm unpublish` only works within 72 hours of publishing. Prefer `npm deprecate` instead.

## Planned

- Publish from GitHub Actions with npm trusted publishing (OIDC). This removes the need for local auth and adds provenance to each release.
