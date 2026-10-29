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

## Project layout

```
src/                  # library source; tests live next to code as *.test.ts
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
