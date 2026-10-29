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

**Why:** OPFS and Web Workers exist only in browsers, and every modern bundler consumes ESM. A CJS build would add complexity with no users.

## 003. Ship the SharedWorker as a separate file, never inline (2026-10-29)

> **Superseded by #009 (2026-10-29).** The library now uses a Dedicated Worker (#006), so the blob URL argument below no longer applies. See #009 for the current rule.

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

**Known limit:** jsdom has no OPFS, Workers, or Web Locks. Once that code exists, switch to Vitest browser mode (Playwright) to test against a real browser.

## 006. Each tab writes its own files from a Dedicated Worker; no SharedWorker (2026-10-29)

**Decision:** Each tab starts its own Dedicated Worker. That worker opens its own OPFS segment files with `createSyncAccessHandle()` and is the only writer of those files. Tabs do not send log records to each other. Cross-tab jobs (retention, upload) are coordinated with Web Locks. There is no SharedWorker.

**Why:**
- Target is evergreen desktop **and mobile**, at thousands of records per second.
- `createSyncAccessHandle()` is available only in Dedicated Workers. SharedWorker only has the async `createWritable()`, which is too slow for this volume.
- A nested Dedicated Worker inside a SharedWorker is not reliably supported (Chrome support unclear).
- SharedWorker on Android Chrome only returned in Chrome 148 (2026), and instances may be killed when the app goes to the background.
- A sync access handle is exclusive per file. Giving each tab its own files removes write contention, and a crashed tab loses only its own unflushed buffer.
- A single-leader design (Web Locks + BroadcastChannel, or SharedWorker as a port broker) adds a hot-path hop, a bottleneck, and leader handover logic.

**Trade-offs:**
- More files and one worker per tab. Readers (export, query) merge files by timestamp and per-tab sequence number.
- No total order across tabs.
- Live tail is same-tab only (`subscribe()`). Cross-tab live tail is out of scope; no use case for it.
- If tabs pass different configs, the tab that holds a coordination lock uses its own config.

## 007. Upload through a user-supplied `send()` callback, coordinated by Web Locks (2026-10-29)

**Decision:** The library does not speak any upload protocol. The user passes `upload.send(file, meta)`. When it resolves, the segment is marked uploaded. When it rejects, the segment stays pending and is retried. Only the tab that holds the `opfslogd:upload` Web Lock uploads.

Segment lifecycle: `active` (being written) → `pending` (sealed, waiting for upload) → `done` (uploaded) → deleted by retention. Without `upload`, sealed segments go straight to `done`.

When the size limit is hit, `done` segments are deleted first, then the oldest `pending` segments (rolling). Dropped counts are recorded.

**Why:**
- Upload protocols differ per backend. The maintainer's earlier system used presigned S3 URL → PUT → confirm call, a three-step handshake. A callback fits that and any other flow (auth refresh, compression, multipart).
- Web Locks give one uploader across tabs, and hand over automatically when that tab closes. This was the main reason the earlier design used a SharedWorker.
- Functions cannot be passed to a worker, so `send()` runs on the main thread of the lock holder. Upload is not on the hot path, so this cost is fine.
- Delivery is at-least-once. `meta` carries `segmentId` (idempotency key), `sha256`, `size`, and time range so the backend can dedupe and verify.

## 008. Design documents are HTML; decision records stay Markdown (2026-10-29)

**Decision:** Long design documents live in `docs/design/*.html`, written by hand as readable HTML. Short decision records stay in this file. The same content is never kept in both formats.

**Why:** Diagrams, state flows, and tables read much better as HTML. Decision records are short, append-only, and need clean diffs and GitHub rendering, so Markdown fits them better. Keeping one format per document avoids drift.

## 009. Ship the worker as a separate file, with a `workerUrl` override; no inline build for now (2026-10-29)

**Decision:** The worker ships as its own file (`dist/worker.js`) and is loaded with:

```ts
new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })
```

`init()` accepts a `workerUrl` option. When set, the library loads the worker from that URL instead. There is no inline (blob URL) build for now. Data URLs are never used.

**Why:**
- A separate file needs only `worker-src 'self'` in CSP. An inline blob worker needs `worker-src blob:`, which strict sites block.
- A separate file is cached on its own and has clean sourcemaps.
- Vite build, webpack 5, Next.js, and Parcel pick up the `new URL(..., import.meta.url)` pattern. Rollup and esbuild do not emit the file, and a library loaded from a CDN cannot start a cross-origin worker. `workerUrl` covers all of these: the user copies `worker.js` to their own origin and passes its URL.
- An inline build (`opfslogd/inline`) would double build config and test targets. It can be added later without breaking the API if users ask for it.
- Data URLs run with an opaque origin and have no OPFS access.

**Known issue to verify:** Vite dev mode pre-bundles dependencies, which may break the worker URL. Users may need `optimizeDeps.exclude: ['opfslogd']`.
