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

> **Superseded by #016 (2026-11-01).** Frame headers were removed. Segments are now a JSON header line followed by plain JSON Lines. The parts below about encoding once on the main thread with `JSON.stringify` and keeping the format internal still hold.

**Decision:** A segment file is a small file header followed by frames. One flush is one frame. Each frame has a fixed-size binary header (magic, payload length, CRC32, record count, min/max timestamp, seq range, level bitmask) and a payload of UTF-8 JSON Lines. There is no per-record binary header. This format is internal: export and upload convert segments to plain JSON Lines.

**Why:**
- The bytes the main thread sends to the worker are appended to the file as is, so encoding happens once, on the main thread, at flush time. The format is therefore chosen for the cheapest main-thread encoding.
- Native `JSON.stringify` + `TextEncoder.encodeInto` handles arbitrary user objects fast with zero dependencies. A full binary format (MessagePack etc.) would need a JS encoder or a runtime dependency, and only saves about 20-30% in size.
- Plain JSON Lines cannot detect corruption that still parses, and queries must parse every line. Frame headers add CRC32 corruption checks, crash recovery by truncating at the first bad frame, and frame-level skipping for time-range and level queries.
- Keeping the format internal means backends never depend on it, so it can change across `0.x` versions.

**To verify:** native `JSON.stringify` vs JS binary encoders (e.g. msgpackr) on arbitrary objects; CRC32 throughput on mobile. Details: `docs/design/storage-format.html`.

## 011. Record schema: `ts`, `lv`, `msg`, `ctx`, `err`; per-tab values live in headers (2026-10-29)

> **Amended by #016 (2026-11-01).** `seq` is now the file header's `seq0` plus the line index, since frame headers were removed.

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

> **Amended by #016 (2026-11-01).** The frame header's `headerLength` and `flags` are gone with the frames. The JSON file header ignores unknown keys, which covers `headerLength`. Incompatible features raise `minReaderVersion`.

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

## 014. Serialize each record when `log()` is called, not at flush (2026-11-01)

**Decision:** `log()` runs `JSON.stringify` on the record immediately and keeps only the result (string or bytes) in the main-thread buffer. User objects are never held until flush. Flush only joins, encodes, and transfers.

**Why:**
- Objects are passed by reference. If serialization waits until flush, changes the app makes in the meantime (`log('x', obj); obj.a = 2`) end up in the log. A log must record the value at call time.
- JS has no `sizeof`. The per-tab buffer cap (draft 4MB) can only be enforced on serialized data.
- Serializing a whole flush at once (about 20,000 records in a 100k/s burst) could block the main thread for tens of milliseconds. Per-call cost spreads this out.
- Serialization errors (#011) are caught at the call site, per record.

**Trade-offs:**
- `log()` costs one `JSON.stringify` (about 1µs for small objects, to be benchmarked) instead of one array push.
- Records already serialized cannot be picked out by level. Overload dropping becomes admission control: as the buffer fills, new low-level records are rejected first; `error` is always accepted.

**To decide by benchmark:** keep strings and encode once at flush, or `encodeInto` bytes on every call.

## 015. Main-thread buffer is a string queue, not a ring buffer (2026-11-01)

**Decision:** The main thread keeps serialized records in a plain array of strings with a running length counter. At flush it joins them, encodes them into one new `ArrayBuffer`, and transfers it to the worker. A new buffer is allocated per flush. The buffer cap is measured in string length (UTF-16 units).

**Why:**
- A transferred `ArrayBuffer` is detached on the sending side, so its memory cannot be reused. A ring buffer's main benefit (no allocation, no GC) is lost.
- A ring buffer shared by the main thread and the worker needs `SharedArrayBuffer`, which needs cross-origin isolation (COOP/COEP headers). A library cannot require that from its users.
- The earlier SharedWorker-based design used a ring buffer to limit GC. Per-tab workers with transfer remove that need.
- One allocation per flush (about 5 per second) costs little GC.
- String length tracks in-memory size, which is what the cap protects. It can differ from the UTF-8 bytes on disk, which does not matter for the cap.

**Not now:** A buffer pool (the worker returns used buffers for reuse). Add it only if a benchmark shows GC cost. Encoding bytes on every call (#014) stays a benchmark candidate.

## 016. Segments are plain JSON Lines with a JSON header line; no frame headers (2026-11-01)

**Decision:** A segment file is one JSON header line followed by record lines. There are no binary frame headers and no CRC32. This replaces #010's frames.

```
{"format":1,"minReader":1,"tab":"k3f9","seq0":0,"context":{...}}   <- header line (key names are a draft)
{"ts":1793251200123,"lv":"info","msg":"..."}
{"ts":1793251200125,"lv":"error","msg":"...","err":{...}}
```

- `seq` = header `seq0` + line index (amends #011). A worker continues `seq0` from its previous segment.
- Every record line starts with `ts` then `lv`. `ts` is 13 digits, so the level sits at a fixed position and queries can filter without `JSON.parse`.
- Crash recovery: find the first line that is incomplete, contains NUL bytes, or fails to parse, and truncate the file there. Never skip a bad line in the middle; that would shift line indexes and break `seq`. A file whose header line is broken holds no usable records and is deleted.
- The header line is always uncompressed plain JSON, so any version can read `minReader` and decide to skip the file (#013).

**Why:**
- The frame header came from two assumed weaknesses of JSON Lines, never checked: parseable corruption and having to parse every line in queries. #012 (time range in file names) came later and already gives file-level skipping. The level and `ts` prefix check is far cheaper than parsing.
- Real crash damage is a cut or zero-filled tail, which line checks catch. Recovery by line also keeps the complete lines of a half-written flush, where frames dropped the whole flush.
- Survey of other systems: frames with length and checksum appear when the payload is binary, compressed, or encrypted and newlines cannot mark records (LevelDB/RocksDB WAL, Kafka, Vector and Beats disk buffers, Tencent Mars xlog). Text line logs have none (Docker `json-file`, pino, winston). Fluent Bit has a CRC32 option for its chunks, and it is off by default.
- Without frames, the main thread sends bytes and the worker appends them. There are no per-flush tallies to pass, no header space to reserve, no CRC to compute, and no header byte layout to design.

**Trade-offs:**
- Corruption that still parses as valid JSON is not detected. After sealing, upload's `sha256` (#007) covers the file.
- Queries scan every line of a segment instead of skipping frames. Estimated tens of ms per 8MB segment, to be benchmarked. Queries are rare and off the write path.
- Per-flush compression or encryption would need frames again. That would be a new format version under #013, and the v1 reader stays.


## 017. Flush triggers: lazy 200ms timer, 256K-character size, and error with a 50ms gap (2026-11-01)

**Decision:** The main thread flushes its string queue when any of these is true. The numbers are drafts to tune by benchmark.
- **Timer:** when the first record enters an empty queue, start a 200ms timer. No timer runs while the queue is empty.
- **Size:** the queue holds more than 256K characters.
- **Error:** an `error` record schedules a flush in a microtask. If the last flush was less than 50ms ago, the flush moves to the 50ms mark.

Flushes on `visibilitychange` / `pagehide` and a user-called `flush()` are decided separately.

**Why:**
- The timer bounds crash loss. Starting it only when there is data keeps idle tabs from waking 5 times a second, which matters for mobile battery.
- Without a size trigger, a 100k/s burst fills about 4M characters per 200ms, which reaches the draft 4MB cap within one interval. Records would be dropped while the worker sits idle, and one large join and encode would block the main thread.
- An error often comes right before a renderer crash or kill. Close and navigation are covered by `pagehide`, so the benefit is narrow, but the cost is small. The microtask merges errors from the same task, and the 50ms gap limits error-driven flushes to 20 per second during an error storm.

**Consequence:** With the size trigger, the main-thread queue never grows past about 256K characters, so a cap on the queue alone never fires. Data the worker has not written yet waits in the worker's message queue, which the main thread cannot see. The cap must cover the queue plus in-flight data. Whether the worker acknowledges writes is the next decision.

## 018. Worker acknowledges each flush; the buffer cap covers queued plus in-flight data (2026-11-01)

**Decision:** Each flush message carries an `id`. After `handle.write()`, the worker posts `{ id }` back to the main thread. The main thread remembers the size of each flush, adds it to `inFlight` when sending, and subtracts it when the ack arrives. The per-tab cap (draft 4MB) and the level-based rejection (#014) apply to `queue size + inFlight`.

**Why:**
- After #017 the main-thread queue stays under about 256K characters. Data the worker has not written waits in the worker's message queue, which neither side can measure. Without acks there is no real memory cap.
- The worker can fall behind: it also converts segments for export and upload and runs crash recovery, and OPFS writes can be slow on mobile.
- Dropping in the worker (instead of rejecting on the main thread) happens after the memory is already used, and the worker would have to parse records to drop by level.
- The worker-to-main channel already exists (upload Blobs for `send()`, error reports). An ack is one small message per flush.
- A stop in acks also tells the main thread that the worker has died or hung.

**Known effect:** Acks are handled as main-thread tasks. While the main thread runs a long task, `inFlight` looks larger than it is, so rejection starts early. This errs toward dropping low-level records, never toward exceeding the cap. Rejection thresholds should allow for it.
