# AGENTS.md

Guide for AI coding agents working in this repo. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

`opfslogd` is a browser logging library built on OPFS (Origin Private File System) and Dedicated Workers. It is published on npm as `opfslogd`. Work in progress (`0.x`).

## Setup and commands

- Requires Node >= 20 and pnpm 9. Always use `pnpm`, never npm or yarn, to install or run scripts.

| Command | Purpose |
|---|---|
| `pnpm install` | Install deps |
| `pnpm test` | Vitest, single run: `unit` (jsdom) and `browser` (Chromium, Firefox, WebKit) projects |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | tsdown → `dist/` (ESM + `.d.ts` + sourcemap) |
| `pnpm lint:pkg` | publint check of `package.json` exports |
| `pnpm exec playwright install chromium firefox webkit` | Browsers for the `browser` project (once) |
| `pnpm playground` | Vite page at `/playground/` to try the API by hand against `src/` (no build) |
| `pnpm bench` / `pnpm bench:serve` | Speed measurements in desktop engines / served on the LAN for phones |
| `pnpm check:bfcache` / `pnpm check:vite` / `pnpm check:storage` | Manual browser checks (not in CI; `check:vite` and `check:storage` need `pnpm build` first); see `docs/design/benchmark.html` |

**Before finishing any change, run:**

```sh
pnpm typecheck && pnpm test && pnpm build && pnpm lint:pkg
```

CI (`.github/workflows/ci.yml`) runs the same steps on every push and PR.

## Layout

```
src/                 library source; tests next to code as *.test.ts
src/index.ts         public entry; everything exported here is public API
test/browser/        Vitest browser-mode tests (real OPFS, Workers, Web Locks)
test/bfcache/        bfcache check script (headed Chromium)
test/vite-dev/       check that the worker loads in a Vite app
bench/               speed measurement page and runner
playground/          page to try the API by hand (pnpm playground)
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
- Keep that expression literal. Do not put the URL in a variable or merge it with `workerUrl` (`options.workerUrl ?? new URL(...)`): Vite then inlines the worker as a data URL in production builds. See `docs/decisions.md` #059.
- **Do not inline the worker.** No blob URL build (needs `worker-src blob:` in CSP) and never a data URL (opaque origin, no OPFS access).
- See `docs/decisions.md` #009 for details.

## Testing

- Two Vitest projects (`vitest.config.ts`): `unit` runs `src/**/*.test.ts` in jsdom; `browser` runs `test/browser/**/*.test.ts` in Chromium, Firefox, and WebKit through Playwright.
- jsdom has **no OPFS, no Workers, and no Web Locks**. Do not mock those APIs to make tests pass; test that code in the `browser` project.
- WebKit blocks OPFS in Playwright's default throwaway context, so the WebKit instance uses a persistent context and runs one file at a time. Keep that.
- Vitest `bench` does not run in browser mode; speed measurements live in `bench/`.
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
