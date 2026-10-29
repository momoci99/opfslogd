# AGENTS.md

Guide for AI coding agents working in this repo. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

`opfslogd` is a browser logging library built on OPFS (Origin Private File System) and SharedWorker. It is published on npm as `opfslogd`. Work in progress (`0.x`).

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
docs/decisions.md    design decision records
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

## SharedWorker and OPFS

- **Never inline the worker** as a blob URL or data URL, and never use Vite's `?sharedworker&inline`.
  - Blob URLs differ per tab, so tabs would not share one worker.
  - Data URLs get an opaque origin, which has no OPFS access.
- Build the worker as a separate tsdown entry and load it like this:
  ```ts
  new SharedWorker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })
  ```
- See `docs/decisions.md` #003 for details.

## Testing

- Vitest with `jsdom`. jsdom has **no OPFS and no SharedWorker**.
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
