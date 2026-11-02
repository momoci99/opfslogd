# Contributing

## Prerequisites

- Node.js >= 20 (CI uses 22)
- pnpm 9 (`corepack enable` picks the version from `packageManager`)

## Setup

```sh
git clone https://github.com/momoci99/opfslogd.git
cd opfslogd
pnpm install
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm test` | Run tests once (Vitest) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm typecheck` | Type check with `tsc --noEmit` |
| `pnpm build` | Build to `dist/` with tsdown (ESM + `.d.ts` + sourcemap) |
| `pnpm dev` | Build in watch mode |
| `pnpm lint:pkg` | Validate `package.json` exports with publint |
| `pnpm exec playwright install chromium firefox webkit` | Browsers for the browser tests (once) |
| `pnpm playground` | Page to try the API by hand against `src/` (no build): log, flush, upload, export, OPFS files |
| `pnpm bench` | Speed measurements in desktop engines (`node bench/run.mjs --only=firefox` for one; `pnpm bench --android` for an Android phone over USB) |
| `pnpm build && pnpm check:storage` | Crash, quota, page-leave, and memory checks (not in CI) |
| `pnpm build && pnpm check:android` | Records lost on page leave and app kill on an Android phone over USB (not in CI; needs adb) |
| `pnpm build && pnpm check:vite` | The built package in a Vite app, dev and build (not in CI) |
| `pnpm build && pnpm check:bundlers` | The built package in webpack, Next.js, Parcel, Rollup, and esbuild apps (not in CI; installs the bundlers into `test/bundler-check/` on the first run, about 470MB) |
| `pnpm check:bfcache` | bfcache check in headed Chromium (not in CI) |

## Project layout

```
src/                  # library source; unit tests (jsdom) live next to code as *.test.ts
test/browser/         # browser tests: real OPFS, workers, Web Locks in Chromium, Firefox, WebKit
test/storage-check/   # crash, quota, page-leave, memory checks (pnpm check:storage)
test/android-check/   # page-leave and app-kill checks on an Android phone (pnpm check:android)
test/vite-dev/        # the package in a Vite app (pnpm check:vite)
test/bundler-check/   # the package in other bundlers' apps; own package.json (pnpm check:bundlers)
bench/                # speed measurements (pnpm bench)
playground/           # page to try the API by hand (pnpm playground)
docs/                 # maintainer docs (releasing, design decisions)
tsdown.config.ts      # build config
vitest.config.ts      # test config
.github/workflows/    # CI
```

## Before opening a PR

CI runs these on every push and PR. Run them locally first:

```sh
pnpm typecheck && pnpm test && pnpm build && pnpm lint:pkg
```

## Code rules

- Exported functions need explicit return types (`isolatedDeclarations` is on).
- Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Browser APIs only in `src/`. No Node built-ins.

See [docs/decisions.md](docs/decisions.md) for why the project is set up this way.
