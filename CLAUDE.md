# opfslogd

Browser logging library built on OPFS and SharedWorker. Published on npm as `opfslogd`.

## Commands

- `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint:pkg`
- Run all four before committing. CI runs the same steps.

## Rules

- Browser-only, ESM-only. No Node built-ins in `src/`.
- Exported functions need explicit return types (`isolatedDeclarations`).
- Use `import type` for type-only imports (`verbatimModuleSyntax`).
- Tests sit next to source as `src/**/*.test.ts`.
- Never inline the SharedWorker (blob or data URL). Build it as a separate entry and load it with `new URL('./worker.js', import.meta.url)`. See docs/decisions.md #003.
- jsdom has no OPFS or SharedWorker. Use Vitest browser mode for those tests.

## Releasing

Never run `npm publish` / `pnpm publish` yourself. The user publishes from a regular terminal with passkey 2FA. See docs/RELEASING.md.

## Docs

- `docs/decisions.md`: why things are set up this way. Add entries for new decisions.
- `notes/`: the user's personal notes, gitignored. Do not commit.
