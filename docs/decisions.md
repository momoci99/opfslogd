# Design decisions

Short records of why things are the way they are. Add new entries at the bottom.

## 001. Build with tsdown, not Vite (2026-10-29)

**Decision:** Build the library with tsdown. Vite may be used later for a `playground/` dev page only.

**Why:**
- tsdown generates `.d.ts` files out of the box. Vite library mode needs `vite-plugin-dts`.
- Adding a second entry (the worker) is one line in `tsdown.config.ts`.
- Vite's strengths (dev server, HMR) matter for a demo page, not for the published bundle.

## 002. ESM only, browser only (2026-10-29)

**Decision:** Ship ESM only (`"type": "module"`, no CJS build). Target `es2022` and the browser platform.

**Why:** OPFS and SharedWorker exist only in browsers, and every modern bundler consumes ESM. A CJS build would add complexity with no users.

## 003. Ship the SharedWorker as a separate file, never inline (2026-10-29)

**Decision:** The worker is built as its own file in `dist/` and loaded like this:

```ts
new SharedWorker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })
```

**Why:**
- A SharedWorker is shared only between pages that use the **same script URL** (plus the same name).
- **Blob URLs** (what Vite's `?sharedworker&inline` produces) are unique per document. Every tab would start its own worker, so nothing is shared.
- **Data URLs** run the worker with an opaque origin, so it cannot access OPFS.
- The `new URL(..., import.meta.url)` pattern is understood by Vite, webpack 5, and other modern bundlers, so consumers get the worker file emitted automatically.

## 004. Strict TypeScript with isolatedDeclarations (2026-10-29)

**Decision:** Use `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `isolatedDeclarations`.

**Why:** `isolatedDeclarations` forces explicit types on exports. Declaration files can then be generated per file without full type inference, which is faster and keeps the public API explicit. TypeScript requires `declaration: true` alongside it, even though `noEmit` is set.

## 005. Tests run in jsdom for now (2026-10-29)

**Decision:** Vitest uses `jsdom` for now.

**Known limit:** jsdom has no OPFS or SharedWorker. Once that code exists, switch to Vitest browser mode (Playwright) to test against a real browser.
