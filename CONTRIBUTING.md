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
| `pnpm bench` | Speed measurements in desktop engines (`node bench/run.mjs --only=firefox` for one) |
| `pnpm build && pnpm check:storage` | Crash, quota, page-leave, and memory checks (not in CI) |
| `pnpm build && pnpm check:vite` | The built package in a Vite app, dev and build (not in CI) |
| `pnpm check:bfcache` | bfcache check in headed Chromium (not in CI) |

## Project layout

```
src/                  # library source; unit tests (jsdom) live next to code as *.test.ts
test/browser/         # browser tests: real OPFS, workers, Web Locks in Chromium, Firefox, WebKit
test/storage-check/   # crash, quota, page-leave, memory checks (pnpm check:storage)
test/vite-dev/        # the package in a Vite app (pnpm check:vite)
bench/                # speed measurements (pnpm bench)
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
