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
- `file` is the segment converted to plain JSON Lines, not the internal segment bytes (see #010). `sha256` and `size` refer to that converted file.

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

## 010. Segment files are binary frames with JSON Lines payloads (2026-10-29)

**Decision:** A segment file is a small file header followed by frames. One flush is one frame. Each frame has a fixed-size binary header (magic, payload length, CRC32, record count, min/max timestamp, seq range, level bitmask) and a payload of UTF-8 JSON Lines. There is no per-record binary header. This format is internal: export and upload convert segments to plain JSON Lines.

**Why:**
- The bytes the main thread sends to the worker are appended to the file as is, so encoding happens once, on the main thread, at flush time. The format is therefore chosen for the cheapest main-thread encoding.
- Native `JSON.stringify` + `TextEncoder.encodeInto` handles arbitrary user objects fast with zero dependencies. A full binary format (MessagePack etc.) would need a JS encoder or a runtime dependency, and only saves about 20-30% in size.
- Plain JSON Lines cannot detect corruption that still parses, and queries must parse every line. Frame headers add CRC32 corruption checks, crash recovery by truncating at the first bad frame, and frame-level skipping for time-range and level queries.
- Keeping the format internal means backends never depend on it, so it can change across `0.x` versions.

**To verify:** native `JSON.stringify` vs JS binary encoders (e.g. msgpackr) on arbitrary objects; CRC32 throughput on mobile. Details: `docs/design/storage-format.html`.

## 011. Record schema: `ts`, `lv`, `msg`, `ctx`, `err`; per-tab values live in headers (2026-10-29)

**Decision:** Each stored JSONL record has `ts`, `lv`, `msg`, and optional `ctx` (user data) and `err` (`name`, `message`, `stack`). Tab ID and global context are stored once in the file header. `seq` is derived from the frame header's starting seq plus the line index. Export and upload add these values back to every line.

**Why:**
- `ctx` keeps user keys from colliding with reserved fields.
- `JSON.stringify(new Error())` returns `{}`, so errors need explicit fields.
- Tab ID, seq, and global context would repeat on every record. Storing them once saves tens of bytes per record, which is hundreds of KB per second at the target rate.
- `ts` is `Date.now()` in integer milliseconds (wall clock), not `performance.timeOrigin + performance.now()` (monotonic). Logs are matched against server logs and human memory, so wall-clock time matters more. The wall clock can jump backwards, so order within a tab comes from `seq`, not `ts`.
- `log()` must never throw. If `ctx` cannot be serialized (circular reference, `BigInt`), it is replaced with `{"_unserializable": "<reason>"}` and the record is still written.

## 012. Segment file names carry the time range and tab ID (2026-10-29)

**Decision:** An active segment is named `{startTs}_{tabId}.seg`. When sealed, it is renamed to `{startTs}_{endTs}_{tabId}.seg` as part of the same `move()` that changes its state directory. Timestamps are zero-padded to 13 digits. The format version is not in the name; it is in the file header.

**Why:**
- Queries and retention can pick files by name without opening them.
- Zero-padding makes lexical order equal time order.
- Sealing already moves the file, so the rename is free.
- Each worker holds the Web Lock `opfslogd:tab:{tabId}` while alive. Files in `active/` whose lock is gone (checked with `navigator.locks.query()`) belong to a crashed tab; the retention holder recovers and seals them.

## 013. Format versioning: reader/writer versions, extensible headers, fixed file names (2026-10-29)

**Decision:**
- The segment file-name scheme (#012) never changes.
- The file header has `formatVersion` (written by) and `minReaderVersion` (needed to read). A library can read a file when `minReaderVersion` is not above its own version.
- The frame header has `headerLength`, so fields can be appended to the header, and a 16-bit `flags` field, 0 for now, for incompatible features such as compression.
- Writers always write the latest format. Readers support every older format, even in `0.x`.
- When a library meets a file it cannot read: query and export skip it and report the skip; retention still deletes it by name; upload leaves it in `pending` for a newer tab; crash recovery does not touch it.

**Why:**
- Tabs can run different library versions against the same directory.
- Unread `pending` logs on user devices must survive upgrades.
- Patterns borrowed: SQLite's separate read/write versions, Protobuf's ignore-unknown-fields (here `headerLength` and extra JSON keys), Kafka's per-batch attribute flags. Most changes become compatible and need no version bump.
- IndexedDB-style `versionchange` notification is not needed: old tabs only skip what they cannot read.
