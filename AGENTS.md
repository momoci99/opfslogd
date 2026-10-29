# AGENTS.md

Guide for AI coding agents working in this repo. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

`opfslogd` is a browser logging library built on OPFS (Origin Private File System) and Dedicated Workers. It is published on npm as `opfslogd`. Work in progress (`0.x`).

## Setup and commands

- Requires Node >= 20 and pnpm 9. Always use `pnpm`, never npm or yarn, to install or run scripts.

| Command | Purpose |
|---|---|
| `pnpm install` | Install deps |
| `pnpm test` | Vitest, single run |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | tsdown → `dist/` (ESM + `.d.ts` + sourcemap) |
| `pnpm lint:pkg` | publint check of `package.json` exports |

**Before finishing any change, run:**

```sh
pnpm typecheck && pnpm test && pnpm build && pnpm lint:pkg
```

CI (`.github/workflows/ci.yml`) runs the same steps on every push and PR.

## Layout

```
src/                 library source; tests next to code as *.test.ts
src/index.ts         public entry; everything exported here is public API
docs/decisions.md    design decision records (Markdown)
docs/design/         design documents (HTML, open in a browser; start at index.html)
docs/RELEASING.md    release process (human-only)
tsdown.config.ts     build entries and options
vitest.config.ts     test environment
```

## Code rules

- **Browser-only, ESM-only.** No Node built-ins (`fs`, `path`, `process`, ...) in `src/`.
- **Explicit return types on exports.** `isolatedDeclarations` is on, so typecheck fails without them.
- **`import type`** for type-only imports (`verbatimModuleSyntax`).
- Strict mode with `noUncheckedIndexedAccess`. Handle `undefined` from index access; do not silence it with `!`.
- No runtime dependencies without asking the user first. The package currently has zero.
- Keep public API changes deliberate. Anything exported from `src/index.ts` is public.

## Workers and OPFS

- Architecture: each tab runs its own Dedicated Worker that writes its own OPFS files with `createSyncAccessHandle()`. Cross-tab coordination (retention, upload) uses Web Locks. No SharedWorker. See `docs/decisions.md` #006, #007 and `docs/design/architecture.html`.
- Build the worker as a separate tsdown entry and load it like this, unless the user passes `workerUrl`:
  ```ts
  new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })
  ```
- **Do not inline the worker.** No blob URL build (needs `worker-src blob:` in CSP) and never a data URL (opaque origin, no OPFS access).
- See `docs/decisions.md` #009 for details.

## Testing

- Vitest with `jsdom`. jsdom has **no OPFS, no Workers, and no Web Locks**.
- Do not mock those APIs to make tests pass. Test that code with Vitest browser mode (Playwright). If browser mode is not set up yet, say so instead of faking it.
- Add or update tests with every behavior change.

## Git

- Commit messages follow Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- Work on a branch for non-trivial changes. Do not force-push `main`.
- Commit or push only when the user asks.

## Do not

- **Do not run `npm publish` / `pnpm publish`, `npm version`, `npm unpublish`, or `npm deprecate`.** The maintainer releases manually with passkey 2FA. See `docs/RELEASING.md`.
- Do not commit `notes/`. It holds the maintainer's personal notes and is gitignored.
- Do not commit `dist/`. It is gitignored.
- Do not edit `pnpm-lock.yaml` by hand.

## Decisions

When you make a design decision that others will ask "why?" about, add an entry to `docs/decisions.md`.

Longer design documents (architecture, flows, state diagrams, targets) go in `docs/design/*.html`, hand-written readable HTML, not minified. Do not duplicate the same content in Markdown. See `docs/decisions.md` #008.
