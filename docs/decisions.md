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

> **Note (2026-11-01):** Vitest browser mode is now set up as a second project (`browser`) next to jsdom (`unit`), in step 6 (#058).

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

Segment lifecycle: `active` (being written) → `pending` (closed, waiting for upload) → `done` (uploaded) → deleted by retention. Without `upload`, closed segments go straight to `done`.

When the size limit is hit, `done` segments are deleted first, then the oldest `pending` segments (rolling). Dropped counts are recorded.

**Why:**
- Upload protocols differ per backend. The maintainer's earlier system used presigned S3 URL → PUT → confirm call, a three-step handshake. A callback fits that and any other flow (auth refresh, compression, multipart).
- Web Locks give one uploader across tabs, and hand over automatically when that tab closes. This was the main reason the earlier design used a SharedWorker.
- Functions cannot be passed to a worker, so `send()` runs on the main thread of the lock holder. Upload is not on the hot path, so this cost is fine.
- Delivery is at-least-once. `meta` carries `segmentId` (idempotency key), `sha256`, `size`, and time range so the backend can dedupe and verify.
- `file` is the segment converted to plain JSON Lines, not the internal segment bytes (see #016, #033). `sha256` and `size` refer to that converted file.

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

> **Note (2026-11-01):** Checked in step 6. Vite 8 needs no `optimizeDeps.exclude` in dev or build, as long as the worker is created with the literal expression (#059).

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

> **Amended by #034, #061, #067 (2026-11-01).** Lock names carry the namespace (`opfslogd:{namespace}:tab:{tabId}`). The main thread creates the tab ID. The two times in a closed segment name are the minimum and maximum record `ts`.

**Decision:** An active segment is named `{startTs}_{tabId}.seg`. When it is moved out of `active/`, it is renamed to `{startTs}_{endTs}_{tabId}.seg` as part of the same `move()` that changes its state directory. Timestamps are zero-padded to 13 digits. The format version is not in the name; it is in the file header.

**Why:**
- Queries and retention can pick files by name without opening them.
- Zero-padding makes lexical order equal time order.
- Leaving `active/` already moves the file, so the rename is free.
- Each worker holds the Web Lock `opfslogd:tab:{tabId}` while alive. Files in `active/` whose lock is gone (checked with `navigator.locks.query()`) belong to a crashed tab; the retention holder recovers them and moves them to `pending/`.

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

> **Measured (2026-11-01, step 8):** the library's whole `log()` path (admission check, `serializeRecord`, queue push) costs about 0.2-0.6µs for a medium record, 1.2-2.2µs for an error with a cause chain, and 1.0µs / 5.1µs with 4x CPU throttling. A rejected call costs a few ns. docs/design/benchmark.html#impl-results

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
- Corruption that still parses as valid JSON is not detected. Once the segment is closed, upload's `sha256` (#007) covers the file.
- Queries scan every line of a segment instead of skipping frames. Estimated tens of ms per 8MB segment, to be benchmarked. Queries are rare and off the write path. (Measured in step 6: about 7ms on Chromium and WebKit, 35ms on Firefox, docs/design/benchmark.html.)
- Per-flush compression or encryption would need frames again. That would be a new format version under #013, and the v1 reader stays.


## 017. Flush triggers: lazy 200ms timer, 256K-character size, and error with a 50ms gap (2026-11-01)

> **Amended by #077 (2026-11-01).** The timer is 50ms, set by measurement.

> **Note (2026-11-01):** 200ms has no basis. It was an example value in the step-1 targets. Pick the interval by benchmark: the shortest interval at which flush cost stays at or below 1% of main-thread time on a low-end mobile device. For reference, batching delays elsewhere follow the cost of one send: Logback/Log4j2 async have no delay, Kafka `linger.ms` is 5ms, OpenTelemetry log batching and Fluent Bit flush are 1s (network). Our flush stays inside the tab, so it is likely tens of microseconds and the interval can probably be shorter than 200ms.

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

## 019. Overload: reject debug and info at 80%, everything at 100%; record drops as one line per flush (2026-11-01)

**Decision:** Before serializing, `log()` checks usage (`queue size + inFlight`, #018) against the cap (draft 4M characters).
- Below 80%: accept everything.
- 80% or more: reject `debug` and `info`. Accept `warn` and `error`.
- 100%: reject everything, including `error`.

A rejected record is never stored. Only per-level counters go up. `log()` returns at once and does not throw.

At the next flush, if any counter is above zero, the library appends one record and resets the counters:

```json
{"ts":1793251200400,"lv":"warn","msg":"opfslogd: records dropped","ctx":{"reason":"overload","dropped":{"debug":1200,"info":300},"from":1793251200210,"to":1793251200390}}
```

`from` and `to` are the times of the first and last drop. Field names are a draft. Telling the app about drops (a callback) is decided with the public API.

**Why:**
- Overload usually comes from a flood of low-level records, and something going wrong often happens during that flood. A level-blind cap (S1) would drop the error that matters most. Rejecting low levels first keeps the last 20% for `warn` and `error`.
- The thresholds cannot be exact: ack delay (#018), string length versus real memory, and an arbitrary cap all blur them. The rule only needs low levels to be cut before high ones, which still holds when the real cut point moves.
- Prior art: Logback's `AsyncAppender` drops TRACE/DEBUG/INFO when less than 20% of its queue is free. OpenTelemetry, Sentry, and sonic-boom drop new items regardless of level. journald writes a "Suppressed N messages" line into the log. Sentry tags drops with a reason.
- Blocking when full (Logback and Log4j2 default) is not possible: `log()` runs on the main thread.
- At 100% even `error` is rejected. Unbounded growth could crash the tab and lose everything.
- Checking before `JSON.stringify` makes a rejected `log()` cheaper than an accepted one, which helps exactly when the main thread is under load.
- One drop line per flush at most, so the drop record cannot itself flood the log. It is an ordinary record, so export, query, and upload need no special case. The `reason` field leaves room for other causes later (for example, pending segments deleted by retention, #007).

**Rejected:** four steps (50/75/90/100%), which added numbers to tune with no prior art; no cap, which risks crashing the tab.

## 020. On hide and close, flush only; moving the segment to `pending/` is left to orphan recovery (2026-11-01)

**Decision:**
- `visibilitychange` to `hidden`: flush at once.
- `pagehide`: flush at once, best effort.
- Neither event moves the segment to `pending/`. When the tab goes away, its `opfslogd:tab:{tabId}` lock is released and the retention holder recovers the orphaned `active/` file and moves it to `pending/` (#012). A normal close and a crash take the same path.
- While hidden, timers are throttled (about 1s, and up to 1 minute in Chrome after a long time hidden). `log()` therefore also flushes when the oldest queued record is older than the flush interval. Records logged last, with no later `log()` call, still wait for the delayed timer.

**Why:**
- On mobile, a backgrounded page is often killed by the OS with no `pagehide`. `hidden` is the last event that reliably arrives while the page and its worker are still running (Chrome's Page Lifecycle guidance says the same).
- During `pagehide` the document and its dedicated worker are being torn down, so a posted message may never be written.
- Moving to `pending/` closes the handle and calls `move()` asynchronously in the worker. It may not finish while the page is torn down, and orphan recovery already covers the case. Doing it on close adds an unreliable step that duplicates an existing path.
- Rotating on every `hidden` would create many tiny segments for users who switch tabs often.

**To verify:** whether a page holding a Web Lock or a sync access handle can enter the back/forward cache, and what happens to its worker if it does.

> **Note (2026-11-01):** In Chromium it enters the cache, and the worker keeps writing with the same handle after the page comes back (docs/design/benchmark.html). Firefox and Safari are on the manual device list.

## 021. Rotate active segments by age as well as size; the age is a public option (2026-11-01)

> **Amended by #066 (2026-11-01).** The size limit is 2MB (draft), not 8MB.

> **Amended by #054 (2026-11-01).** Export also reads the calling tab's active segment.

**Decision:** The worker rotates (moves its active segment to `pending/` and opens a new one) when the segment reaches the size limit (default 8MB) **or** has been open for a set time (draft default 5 minutes) and is not empty. This applies whether or not `upload` is configured. The age is a public option; its name and place are decided with the public API (step 5).

**Why:**
- Only segments in `pending/` are uploaded. With size-only rotation, a long-lived tab writing 1MB per hour would upload once every 8 hours, even with `upload.intervalMs` set to one minute.
- Since #020, closing a tab no longer moves the segment to `pending/`. Doing so on close never helped long-lived tabs anyway.
- Rotating by age is an ordinary worker action on its own file, so it has none of the teardown problems of doing it on close.
- One rule with or without upload keeps behavior simple. Closed files also keep export and query away from files still being written.
- At 5 minutes there are at most 288 segments per tab per day. Retention deletes whole files, so more files do not change how it works.

**Open:** 5 minutes has no basis beyond being longer than the default upload interval (1 minute) while keeping the file count moderate.

## 022. Coordination locks are taken per run and released right away; no conditions on tab state (2026-11-01)

> **Amended by #034 (2026-11-01).** Lock names carry the namespace: `opfslogd:{namespace}:upload`, `opfslogd:{namespace}:retention`, `opfslogd:{namespace}:tab:{tabId}`.

**Principle:** Lock handling stays simple and unconditional. Every tab follows the same rule, and no rule depends on visibility, focus, or other tab state.

**Decision:**
- `opfslogd:upload` and `opfslogd:retention`: each tab, on its own timer, calls `navigator.locks.request(name, { ifAvailable: true }, ...)`. If it gets the lock, it does one run (upload the pending segments, or one retention pass) and releases the lock when the run ends. If not, it skips this round.
- `opfslogd:tab:{tabId}`: held by the worker for its whole life, as in #012. It means "this tab is alive".
- `steal` is never used.

**Why:**
- Before, the uploader held its lock indefinitely. Browsers freeze hidden tabs, and a frozen tab keeps its locks, so a frozen holder stopped uploads for every tab.
- A frozen tab runs no timers, so it never tries to take a lock. The problem mostly disappears without any visibility logic.
- Releasing on `hidden` (the earlier candidate) adds state transitions and would stop uploads from a background tab that is not frozen, which works against #021.
- `steal` would create two uploaders once the frozen tab wakes up.
- The tab lock must stay held while frozen: a frozen tab is alive, and its active file must not be recovered by another tab.

**Remaining risk:** if a tab freezes in the middle of a run, the lock stays held until it wakes. This needs a tab to freeze right after starting a run, and only delays that work.

**Open (step 5):** a `send()` that never settles also holds the upload lock. Whether `send()` gets an `AbortSignal` or a timeout is decided with the public API.

## 023. `subscribe()` ships in v0.1 and receives each flush batch (2026-11-01)

**Decision:** Same-tab `subscribe(fn)` is part of v0.1. At each flush, after the batch is built and before it is transferred, the main thread calls every subscriber once with that batch. Subscribers get exactly what goes to the file: accepted records plus the drop line (#019), never rejected records. A subscriber that throws is isolated and does not affect logging. With no subscribers the cost is zero. The shape of the argument (strings or parsed objects) and the API are decided in step 5.

**Why:**
- Use cases: in-app debug panels (devices where DevTools is hard to open), routing to the console during development, and tests.
- Calling subscribers inside `log()` would put app code on the write path: a slow or throwing subscriber would slow `log()`, and passing the original object would bring back the mutation problem #014 avoided.
- Waiting for the worker ack would add latency and tie subscriber delivery to ack handling, for a guarantee ("it is on disk") that a live viewer does not need.
- A delay of up to one flush interval is not noticeable in a viewer, and it shrinks if the benchmark picks a shorter interval (#017).
- Users could wrap the logger themselves, but the library can deliver exactly what was stored, including drop lines.

## 024. `log` calls take the message first, then an optional context object (2026-11-01)

**Decision:** Each level method takes `(msg, ctx?)`:

```ts
logger.info('upload done', { fileId: 'a1', ms: 320 })
logger.warn('slow response')
```

`msg` is a string and `ctx` is one optional object. They map to the stored `msg` and `ctx` fields (#011) as they are. How the logger object is obtained, and how an `Error` is passed, are decided separately (step 5).

**Why:**
- It matches the record schema (#011) one to one: one message string, one context object.
- Message first is the most common order in JS loggers (winston and most others) and reads naturally.

**Rejected:**
- Object first, `info(ctx, msg)` (pino, bunyan). pino puts the object first because it supports printf-style formatting in the message arguments. opfslogd does no formatting, so the order only adds confusion.
- `console`-style variable arguments, `info('a', obj, 123)` (loglevel, consola). Easy to swap for `console`, but the line between message and context is unclear. The whole argument list would have to be stored, and queries could no longer rely on `msg` and `ctx`.

## 025. Errors are passed as `ctx.err`, or as `ctx` itself (2026-11-01)

**Decision:** The documented way to log an error is the `err` key of `ctx`:

```ts
try { ... } catch (e) {
  logger.error('upload failed', { err: e, fileId })
}
```

- If `ctx.err` is an `Error`, it is stored in the record's `err` field (`name`, `message`, `stack`, #011) and left out of `ctx`. The user's object is not changed.
- If `ctx` itself is an `Error` (`logger.error('upload failed', e)`), it is stored in `err` and the record has no `ctx`.
- If `ctx.err` is not an `Error` (for example `throw 'text'`), it stays in `ctx` as an ordinary value.
- This works on every level, not only `error`.
- An `Error` deeper inside `ctx` (`{ last: { error: e } }`) is not converted and is stored as `{}`. The docs tell users to put errors in `err` or pass them as `ctx`.

**Why:**
- It keeps the `(msg, ctx?)` shape of #024.
- With strict TypeScript, a `catch` variable is `unknown`. `{ err: e }` fits a `Record<string, unknown>` context with no cast.
- `logger.error('x', e)` is common in JavaScript. Without the second rule, the error would be stored as `{}` and its content lost with no warning. The check is one `instanceof`.

**Rejected:**
- A third argument, `error(msg, err, ctx?)`. It breaks #024 and gives the second argument a different meaning on different levels.
- Converting errors at any depth with a `JSON.stringify` replacer. A replacer takes V8 off its fast stringify path and calls a JS function for every key, on every `log()`, for a rare case. The cost estimate in #014 assumes no replacer.
- Scanning only the top-level values of `ctx`. It costs a key loop on every call and still misses deeper errors, so the rule gets harder to explain.

## 026. `err` stores the `cause` chain, up to depth 5 (2026-11-01)

**Decision:** When an `Error` is stored in `err` (#025), its `cause` is stored too, in the same shape, recursively:

```json
"err": {"name":"Error","message":"upload failed","stack":"...",
        "cause": {"name":"TypeError","message":"Failed to fetch","stack":"..."}}
```

- At most 5 levels of `cause` are stored. Deeper causes are dropped.
  The top error does not count: one `err` holds at most 6 errors (the top error plus 5 causes). Clarified in step 8 (2026-11-01).
- A cycle (a cause that points back to an error already in the chain) ends the chain.
- A `cause` that is not an `Error` (a string, an object) is stored as an ordinary value. If it cannot be serialized, it is replaced as in #011.

**Why:**
- Wrapping errors with `new Error(msg, { cause })` (ES2022) is common, and the root cause is usually in the inner error. Chrome's `stack` does not include the cause, so without this the root cause is lost.
- The cost applies only to records that carry an `Error`, not to the ordinary `log()` path.
- Prior art: pino's default error serializer serializes `cause` recursively. Sentry's LinkedErrors integration collects the cause chain with a default limit of 5. Node's `util.inspect` prints `cause`.

## 027. `err` also stores the error's own enumerable properties (2026-11-01)

**Decision:** When an `Error` is stored in `err` (#025, and each level of `cause` in #026), its own enumerable properties (`Object.keys`) are copied into the same object, next to `name`, `message`, `stack`, and `cause`. If a property has the same name as one of those four, the fixed field wins. Values are handled like `ctx` values: if one cannot be serialized, it is replaced as in #011.

```json
"err": {"name":"HttpError","message":"bad","stack":"...","status":503,"code":"UPSTREAM_DOWN"}
```

**Why:**
- App error classes often carry the fact that matters (`status`, `code`) as properties. Without this they are lost.
- The cost applies only to records that carry an `Error`.
- Prior art: pino's default error serializer copies all enumerable properties. Node's `util.inspect` shows them.

**Not covered:** `DOMException.code` is a getter on the prototype, so it is not copied; `name` (for example `QuotaExceededError`) carries the same information. `AggregateError.errors` is not enumerable and is not stored for now.

## 028. The logger is a module singleton set up by `init()`; records logged before `init()` wait in the queue (2026-11-01)

**Decision:** The package exports one logger and an `init()` function. Any module can import the logger and log; the app calls `init()` once, at its entry point.

```ts
// main.ts
import { init } from 'opfslogd'
init({ upload: { send } })

// anywhere
import { logger } from 'opfslogd'
logger.info('clicked', { id })
```

Records logged before `init()` are serialized and queued as usual (#014, #015). Flushes wait until `init()` has started the worker. The buffer cap and rejection rules (#019) apply as usual, so if `init()` is never called, the queue fills to the cap and later records are rejected. Export names (`logger`, `init`) are drafts.

**Why:**
- The goal is an API users can use without thinking. Call sites import from the package directly; there is no logger module for the app to create and place, and no way to create several by mistake.
- There is one worker per tab (#006), so the logger is a single object anyway.
- The usual cost of a singleton is the "used before init" state. Here it is almost free: the queue exists without a worker, so the only addition is "do not flush while there is no worker".
- Packages used by the app can log to the same logger.
- Prior art: browser SDKs that collect logs or events are singletons set up by `init()` (Datadog Browser Logs, Sentry, PostHog, Amplitude, LogRocket, Bugsnag). Datadog, PostHog, Amplitude, and Google Analytics' `dataLayer` queue calls made before setup. Factory-only loggers (pino, bunyan) are server loggers, where one process may need several outputs.

**Rejected:** a factory, `createLogger(options)`. It needs the app to own a logger module, and it removes nothing this design needs. A factory for several instances can be added later without breaking this API.

**Trade-off:** tests share global state and need a way to reset it (`close()`, decided next).

## 029. A second `init()` call is ignored with one console warning (2026-11-01)

**Decision:** Once `init()` has run, later calls do nothing. The options of the first call stay in effect. The library prints one `console.warn` saying that `init()` was already called and that changed options take effect after a page reload.

**Why:**
- Repeated `init()` is common and usually harmless: HMR re-running the entry module (Vite, webpack), React StrictMode, or `init()` placed inside a component.
- Throwing would break the page on every HMR update.
- Restarting with the new options would restart the worker: a new tab ID and tab lock, the old active segment left as an orphan, and queued records to carry over. An HMR update is not worth that cost.
- Prior art: Datadog Browser Logs warns and ignores a second `init()`. Sentry replaces its client, which suits it because it holds no files or locks.

**Trade-off:** during development, changed `init()` options need a reload. The warning says so.

## 030. `close()` flushes, moves the segment to `pending/`, and stops; later `log()` calls are discarded (2026-11-01)

**Decision:** `close(): Promise<void>` does the following, in order:
1. Flush the queue and wait for the worker's ack (#018).
2. Move the active segment to `pending/`. No new segment is opened.
3. Release the locks and terminate the worker.

After `close()`, `log()` calls are discarded: nothing is queued, and no drop line (#019) is written, because the stop is intended. `log()` still never throws (#011). The first discarded call after each `close()` prints one `console.warn` saying that logging has stopped. The warning is printed in every environment, with no development-only check, the same rule as #029. A later `init()` is a normal start, not a second call under #029.

States: before `init()` (records are queued, #028) → running → closed (records are discarded) → `init()` → running.

**Why:**
- Uses: resetting global state in tests (#028), and stopping logging on logout or when the user withdraws consent.
- Going back to the before-`init()` state would keep queuing records from the app and third-party packages after a consent withdrawal, and a later `init()` would write them. Logs from a period the user refused would be stored.
- Logging after `close()` is like using a released resource, so the developer should hear about it. It is not an error to throw, though: the logger is shared, and other code (including third-party packages) cannot know it was closed.
- Warnings in every environment, not development only:
  - Detecting development needs `process.env.NODE_ENV`. AGENTS.md bans `process` in `src/`. Only some bundlers replace it (not Rollup without a plugin, not CDN or unbundled use). The common guard `typeof process !== 'undefined' && ...` silences the warning in Vite and webpack 5 builds, because they replace `process.env.NODE_ENV` but provide no `process`. `import.meta.env.DEV` is Vite-only.
  - An opt-in `debug` option would hide the warning from the developers who need it.
  - The production cost is one console line, only after misuse.
  - Switching to development-only warnings later changes only console output, not the API. Do it if users ask.
- Moving the segment here does not conflict with #020. #020 avoids it while the page is being torn down, when the async steps may not finish. `close()` is awaited while the worker is still running.

## 031. Global context can change at runtime; a change starts a new segment (2026-11-01)

**Decision:** The global context is set at `init()` and can be changed while running (API shape decided separately). It is serialized when it is set, like a record (#014). When it changes:
1. The main thread flushes its queue, then sends the new context to the worker.
2. The worker rotates: it moves the active segment to `pending/` and opens a new one whose header line carries the new context. If the active segment holds no records yet, the worker rewrites its header line instead.

Messages keep their order, so records logged before the change carry the old context and records logged after it carry the new one. `seq` continues across segments as usual (#016).

**Why:**
- The main use of global context in browser SDKs is the user ID, which is known only after login and removed at logout. Sentry (`setUser`, `setTag`), Datadog (`setUser`, `setGlobalContextProperty`), and LogRocket (`identify`) all allow runtime changes. Fixed values (`version`, `env`) fit too, as an initial value.
- The context lives in the segment header (#011). Rotation already exists (#021), so a change needs no new mechanism.
- Changes are rare (login, logout, plan or language change), so the extra segments cost little. Values that change per request belong in the record `ctx`; the docs say so.

**Rejected:**
- Fixed at `init()` only. It cannot hold a user ID set after login.
- A special context line inside the segment. It breaks two rules of #016: every line starts with `ts` and `lv`, and `seq` is the line index.
- Copying the context into every record. It brings back the bytes #011 saves.

**Not now:** scoped context (`logger.child({ module })` in pino, winston, bunyan). It is a separate feature and can be added later.

## 032. `setContext(partial)` shallow-merges; `undefined` removes a key (2026-11-01)

**Decision:** The global context is changed with one function:

```ts
init({ context: { version: '2.3.1', env: 'prod' } })
setContext({ userId: 'u42' })        // login  -> { version, env, userId }
setContext({ userId: undefined })    // logout -> { version, env }
```

- Top-level keys are merged into the current context. Nested objects are replaced, not merged.
- A key whose value is `undefined` is removed.
- If the merged result serializes to the same string as before, nothing happens and no new segment starts (#031).
- `init({ context })` works like a `setContext(context)` call at `init()` time. A `setContext()` before `init()` is kept, and `init()`'s keys win on conflict.
- `close()` clears the context, so a later `init()` starts clean (#030).

**Why:**
- Replacing the whole object would make `setContext({ userId })` at login silently drop `version` and `env`. Merging avoids that trap.
- One function instead of Datadog's `setGlobalContextProperty` / `removeGlobalContextProperty` pair. Several keys changed in one call cause only one segment change.
- Shallow merge only, so the rule stays easy to predict.
- Comparing the serialized result keeps repeated calls with the same value from creating segments.

## 033. Exported lines carry the global context nested under `context` (2026-11-01)

**Decision:** Export and upload add the global context to each line as one nested object named `context`, next to `tab` and `seq`:

```json
{"ts":1793251200123,"lv":"info","msg":"clicked","ctx":{"id":7},"tab":"k3f9","seq":0,"context":{"userId":"u42","version":"2.3.1"}}
```

The name is provisional and may be revisited before `1.0`.

**Why:**
- Merging context keys into the top level (Datadog's way) lets them collide with reserved fields (`msg`, `seq`, ...), the same reason `ctx` is nested (#011).
- Backends can tell global values from per-record values.
- `context` matches the API (`init({ context })`, `setContext`).

**Trade-off:** a line holds both `ctx` (per record) and `context` (global), which may confuse. `global` was the alternative name.

## 034. `namespace` option separates apps on the same origin (2026-11-01)

> **Amended by #073 (2026-11-01).** Allowed characters: `[a-z0-9_-]`, 1-64 characters.

**Decision:** `init({ namespace })` (default `'default'`) selects the OPFS directory `opfslogd/{namespace}/` and prefixes every lock name:

- `opfslogd:{namespace}:upload`
- `opfslogd:{namespace}:retention`
- `opfslogd:{namespace}:tab:{tabId}`

This amends the lock names in #012 and #022. Segment file names (#012, #013) do not change. Allowed characters are decided at implementation (they must be safe as a directory name and in a lock name).

**Why:**
- OPFS and Web Locks are per origin. Two apps on one origin (`user.github.io/app1` and `/app2`, several apps under one company domain, micro frontends) would otherwise share one directory and one upload lock. App 1's `send()` would upload app 2's logs to app 1's backend, and both would share one retention budget. This happens silently and is close to a data leak.
- Making later addition non-breaking would require the `opfslogd/default/` layout now anyway, so the option itself costs only one string.
- With a default value, single-app users never need to set it.

**Telling users about it:** the option's JSDoc (shown on hover in the IDE) and a README section ("several apps on one domain") describe the failure: without a namespace, one app uploads the other's logs to its own backend. There is no runtime detection or warning. Nothing reliably tells two apps apart: `location.pathname` changes with SPA routes, and the worker script URL changes with every hashed deploy. False warnings train developers to ignore warnings. Warning whenever `upload` is set with the default namespace would warn almost every single-app user.

## 035. Of the internal defaults, only the segment age limit is a public option in v0.1 (2026-11-01)

**Decision:** The segment age limit (#021, draft 5 minutes) is a public `init()` option. The buffer cap (#019), flush interval and flush size (#017), overload threshold (#019), and segment size limit (8MB) stay internal constants in v0.1.

**Why:**
- Removing a public option is a breaking change; turning an internal constant into an option later is not.
- The flush interval, flush size, and overload threshold are to be set by benchmark. Users have little basis for changing them, and wrong values raise main-thread cost or loss.
- The buffer cap may matter to memory-sensitive apps, but it is measured in UTF-16 units, which is awkward to explain. Open it if users ask.
- The segment size limit interacts with retention and upload capacity; it is revisited with those options (step 5, units 9 and 10). (It was not revisited then; step 7 lowered it to 2MB, #066.)
- The segment age limit sets the longest delay before a record can be uploaded, and that requirement differs per app.

## 036. The segment age option is `rotate.maxAgeMs` (2026-11-01)

**Decision:** The segment age limit (#021, #035) is set with:

```ts
init({ rotate: { maxAgeMs: 300_000 } })
```

**Why:**
- "Segment" is an internal term. The standard term for closing the current log file and starting a new one is rotation: logrotate (`daily`, `size`), winston-daily-rotate-file (`frequency`, `maxSize`), pino-roll (`frequency`, `size`).
- A `rotate` group gives the segment size limit a place (`rotate.maxBytes`) if it is opened later (#035).
- The `Ms` suffix matches `upload.intervalMs` (#007).
- Not under `upload`: #021 applies the age limit with or without upload.

## 037. Term change: "seal" is replaced by "rotate" and "move to `pending/`" (2026-11-01)

**Decision:** The word "seal" (Korean docs: 봉인) is no longer used. Earlier records and design pages were reworded; their decisions did not change.

- **Rotate:** close the active segment, move it to `pending/`, and open a new one. Used for the size and age limits (#021) and context changes (#031). Matches the public option `rotate` (#036).
- **Move to `pending/`:** the same move without opening a new segment. Used by `close()` (#030) and orphan recovery (#012, #020).
- **Closed segment:** any segment no longer in `active/`.

Throughout, `pending/` means `done/` when `upload` is not configured (#007).

**Why:** "Seal" was an internal word that did not match the public API and did not read naturally. Rotation is the standard term for log files (logrotate, winston-daily-rotate-file, pino-roll).

## 038. `flush(timeoutMs?)` returns `Promise<boolean>` (2026-11-01)

**Decision:** `flush(timeoutMs?: number): Promise<boolean>` sends the current queue to the worker. It resolves `true` once every record queued at the time of the call has been written (the worker's ack, #018), and `false` if that does not happen within `timeoutMs` (draft default 5 seconds). It never rejects.

The same rule covers every state, with no special cases:
- Before `init()`: the records wait for the worker. If `init()` runs and they are written within the timeout, `true`; otherwise `false`.
- After `close()`: the queue is empty (#030), so `true` at once.

**Why:**
- Automatic flushes cover hide, `pagehide` (#020), and `close()`; export flushes on its own. A user-called `flush()` remains useful in tests and before an action that should wait until the log is on disk.
- The ack mechanism already exists, so the cost is small.
- Without a timeout, a dead or hung worker would leave `await flush()` waiting forever and stall app code.
- Returning `false` instead of rejecting lets callers skip try/catch.
- Prior art: Sentry `flush(timeout): Promise<boolean>`, pino `logger.flush(cb)`.

## 039. No separate drop callback (2026-11-01)

**Decision:** There is no `onDrop` callback. Dropped records reach the app in two existing ways: the drop line written at flush (#019), and `subscribe()`, which receives that line with its batch (#023).

**Why:**
- A callback would be a third path for the same information.
- Apps rarely react to drops (lowering the log level, showing an indicator), and those that do can subscribe.
- It can be added later without breaking the API.

**Follow-up:** how subscribers recognize the drop line is settled in #044.

## 040. Internal errors go to `init({ onError })` as `OpfslogdError` with a `code` (2026-11-01)

> **Amended by #064 (2026-11-01).** New code `write-failed` (a segment write failed for a reason other than quota). Write failures are reported once when they start, not on every failed flush.

> **Amended by #073 (2026-11-01).** New code `invalid-option` (an option value breaks its rules; the logger stays closed).

**Decision:**

```ts
init({
  onError(err) {        // err: OpfslogdError, extends Error
    err.code            // 'opfs-unavailable' | 'worker-load-failed' | ...
    err.cause           // the original error (a DOMException, ...)
  },
})
```

Draft codes:

| Code | When |
|---|---|
| `opfs-unavailable` | OPFS cannot be used (old browser, some private modes) |
| `worker-load-failed` | the worker file fails to load (wrong `workerUrl`, CSP) |
| `quota-exceeded` | storage is full |
| `worker-unresponsive` | acks stopped; the worker died or hung (#018) |
| `unreadable-file` | a file in a newer format was skipped (#013) |

- `send()` failures are not reported here. `send()` is the app's own function, and the library retries (#007).
- Without `onError`, each code is printed once with `console.error`, in every environment (same rule as #029, #030). With `onError`, nothing is printed.
- An exception thrown by `onError` is caught and ignored, like a throwing subscriber (#023).
- Codes may be added in minor versions; handlers should allow unknown codes.

**Why:**
- Step 1 set "errors are reported only through a callback": the library never throws into app code.
- Most apps forward these to an error tracker (Sentry and the like), which expects `Error` instances. `code` lets apps branch without matching `message` text, and `cause` keeps the original error.
- Printing once by default keeps a failed setup (no OPFS, blocked worker) from going unnoticed while logs silently stop.

## 041. When storage cannot start, the logger behaves as closed (2026-11-01)

**Decision:** After `opfs-unavailable` or `worker-load-failed` (#040), the logger switches to the closed state of #030: `log()` checks the state and returns at once (no serialization, no timers, no queue), the queue built up before `init()` is discarded, and subscribers receive nothing. The "logging has stopped" warning of #030 is not printed, because `onError` or `console.error` already reported the cause. `flush()` returns `true` at once, as after `close()` (#038).

This applies only to these two codes. `quota-exceeded` can recover once retention frees space, and `worker-unresponsive` can recover when acks resume; while acks are missing, #019 rejects records before serialization, so the cost stays small.

**Principle:** a failed logger must not load the main thread or change how the app behaves.

**Why:**
- Continuing to serialize and flush with nowhere to write costs main-thread time for nothing.
- Keeping subscribers alive (so an in-app debug panel still works) would keep that cost. Browsers without OPFS are rare, so this is not worth it.
- It reuses an existing state instead of adding one.

## 042. Subscribers receive parsed record objects in the exported shape (2026-11-01)

**Decision:** At each flush, `subscribe()` callbacks receive an array of parsed objects, `LogRecord[]`, in the same shape as an exported line: `ts`, `lv`, `msg`, `ctx`, `err`, `tab`, `seq`, `context` (#033). The batch is parsed once per flush and the same array is passed to every subscriber. Records are not frozen; the docs say to treat them as read-only.

```ts
subscribe((records) => {
  for (const r of records) panel.add(r.lv, r.msg, r.ctx)
})
```

**Why:**
- Debug panels, console output, and tests all need objects. Passing strings would make every user write the same parsing code.
- The parse cost is paid only by apps that subscribe; with no subscribers it is zero (#023). This is the app's own choice, so it does not conflict with #041.
- The same shape as export means what a panel shows matches the exported file.
- `Object.freeze` on every record would add cost for all subscribers to guard against a rare mistake.

**To verify:** parse cost per flush during a burst (about 20,000 records per flush at 100k/s).

> **Note (2026-11-01):** The 20,000 figure predates the 256K-character size trigger (#017). One flush holds at most about 1,400 medium records. Measured: about 0.7ms per flush on Chromium, about 2.9ms with 4x CPU throttling; a sustained 100k/s burst costs 5-20% of main-thread time while a subscriber is attached. Acceptable for a debugging feature (#043). See docs/design/benchmark.html.

## 043. `subscribe(fn)` returns an unsubscribe function; its documented purpose is debugging (2026-11-01)

**Decision:**

```ts
const off = subscribe((records) => { ... })
off()

// React
useEffect(() => subscribe(fn), [])
```

- Calling the returned function more than once is safe.
- Subscribing before `init()` is allowed; delivery starts with the first flush after `init()`.
- `close()` removes all subscribers, as it clears the context (#032).
- The JSDoc and README state the purpose: debugging and development (in-app debug panels, console output during development, tests). Shipping logs to a server is what `upload` is for.

**Why:**
- The main use is a debug panel, and the returned function fits React's `useEffect` cleanup directly.
- `unsubscribe(fn)` cannot remove an inline arrow function. An `AbortSignal` option needs an `AbortController` even for the simple case.
- Stating the purpose keeps `subscribe()` from being used as a production pipeline. It is a poor fit for one: delivery happens before the write and is lost on a crash, every flush pays a parse (#042), and there is no retry or backpressure.

## 044. The drop line's `msg` and `ctx.reason` are a fixed, documented contract (2026-11-01)

**Decision:** The drop line (#019) always has `msg` equal to `"opfslogd: records dropped"` and a `ctx.reason` field. Both are documented as stable. Subscribers and backends recognize the line by comparing with these values. No helper function and no extra marker field are added. This replaces the follow-up note in #039 ("without matching `msg` text").

**Why:**
- Backends, often not written in JS, must recognize the line too, so the `msg` text is a contract everywhere anyway. Stating it is what matters.
- An `isDropRecord()` helper adds public API for a one-line comparison; it can be added later without breaking anything.
- A marker field (e.g. `"src":"opfslogd"`) changes the stored schema (#011) when the library writes only one kind of line.

## 045. `send()` gets `meta.signal` and is aborted after `upload.timeoutMs` (2026-11-01)

**Decision:** `send(file, meta)` receives an `AbortSignal` as `meta.signal`. If `send()` has not settled within `upload.timeoutMs` (public option, draft default 60 seconds), the library aborts the signal, treats the attempt as failed, ends the run, and releases the upload lock (#022). The segment stays in `pending/`. If `send()` settles later, the result is ignored.

```ts
upload: {
  async send(file, meta) {
    await fetch(url, { method: 'PUT', body: file, signal: meta.signal })
  },
  timeoutMs: 60_000,
}
```

**Why:**
- A `send()` that never settles would hold the upload lock and stop uploads in every tab, the case #022 left open.
- Passing the signal to `fetch` cancels the real request. A timeout alone would stop waiting while the request kept running.
- A late success after the timeout means the segment is uploaded again on a later run. #007 already accepts at-least-once delivery and gives `segmentId` for dedupe.
- The right limit depends on network and backend, so it is a public option. The default needs measurement: 8MB over a slow mobile link (about 1Mbps) takes about a minute.

## 046. Failed uploads retry on the fixed interval; a run stops at its first failure (2026-11-01)

**Decision:** No backoff. When `send()` rejects or times out (#045), the run ends at once and the remaining segments wait for the next `upload.intervalMs` run. The failed segment stays in `pending/` and is tried again then.

**Why:**
- Each client tries once per interval and stops at the first failure, so an outage does not raise the request rate above normal. The problem backoff solves, retrying harder as failures pile up, does not arise.
- Backoff would need state shared across tabs, because the uploading tab changes from run to run (#022). That is a new shared store for little gain.
- A backoff option can be added later without breaking the API.

**Remaining risk:** when an outage ends, every client uploads its backlog at once.

## 047. No limit on segments per upload run, for now (2026-11-01)

**Decision:** A run uploads pending segments one at a time, oldest first, until it runs out or hits a failure (#046). There is no per-run limit. Revisit after load testing.

**Why:**
- One client sends one request at a time. The burst after an outage comes from all clients starting together, which happens every interval anyway.
- There is no basis for a limit value yet.
- A backend under load can answer with an error such as 429; the app's `send()` rejects, and the run stops (#046). The server already has a way to slow clients down.

**To verify:** load test of the recovery burst (many clients, each with a backlog), and how long a run holds the upload lock.

## 048. `send(file, meta)` arguments (2026-11-01)

> **Amended by #066, #067 (2026-11-01).** `from` and `to` are the minimum and maximum record `ts`. Segments are at most about 2MB.

**Decision:**

```ts
send(file: Blob, meta: {
  segmentId: string   // the pending file name without extension: "{startTs}_{endTs}_{tabId}"
  sha256: string      // hex digest of file
  size: number        // bytes of file
  from: number        // ts of the first record
  to: number          // ts of the last record
  signal: AbortSignal // #045
}): Promise<unknown>  // the resolved value is ignored
```

`file` is the segment converted to exported JSONL (#007, #033), as a `Blob` with type `application/x-ndjson`.

**Why:**
- A `Blob` goes straight into a `fetch` body. Apps that want compression can use `file.stream().pipeThrough(new CompressionStream('gzip'))`, in line with deferring compression in the library (#016). A string would copy up to 8MB.
- The pending file name is already unique (it contains the tab ID) and does not change after the move to `pending/`, so it serves as the idempotency key with no new ID to create or store.
- Left out: record count (the backend can count lines) and namespace (each app defines its own `send`). Fields can be added later without breaking the API.

## 049. The first upload run happens soon after `init()`, once the page is idle (2026-11-01)

**Decision:** `upload.intervalMs` defaults to 1 minute (draft, #021). The first run does not wait a full interval: after `init()`, the library waits for the `load` event and then `requestIdleCallback` (a short `setTimeout` where it is missing, as in Safari), runs once, and then runs every interval. The run still uses `ifAvailable` (#022), so with several tabs opening at once only one runs.

**Why:**
- With only the interval timer, nothing uploads until a minute after `init()`. Short sessions (a mobile user who opens the app for 30 seconds) would never upload, and the backlog from earlier sessions would keep waiting.
- Running at `init()` would put segment conversion, sha256, and network requests on top of page load.
- Retention has the same problem; whether it follows the same rule is decided with the retention options.

## 050. Retention has a size limit and an age limit (2026-11-01)

> **Amended by #061 (2026-11-01).** The retention run reports deleted pending segments to the main thread as counts; the main thread writes the drop line at its next flush.

**Decision:** `retention.maxBytes` and `retention.maxAgeMs`. A retention run (#022):
1. Deletes every closed segment whose end time (in its file name, #012) is older than `maxAgeMs`, whether `done` or `pending`.
2. If the total is still above `maxBytes`, deletes `done` segments, then the oldest `pending` segments, as in #007.

Deleted `pending` segments are reported with a drop line (#019) whose `ctx.reason` is `"retention"`; its other fields are decided at implementation (the count of records is not known without reading the file). Defaults are decided separately.

**Why:**
- Logs hold values such as user IDs (#031). An app that logs little never reaches the size limit, so without an age limit its logs would stay on the device forever. Keeping data no longer than needed is a basic privacy rule (GDPR storage limitation).
- Local logs months old are rarely useful, even for bug reports.
- The end time is in the file name, so the age check opens no files.
- Unuploaded logs past the age limit are deleted too; the drop line records it. #019 left `reason` open for this use.

## 051. `retention.maxAgeMs` defaults to 7 days (2026-11-01)

**Decision:** The default age limit is 7 days.

**Why:**
- Tencent Mars xlog, a mobile log library used by WeChat, keeps logs 10 days by default (from secondary sources; the official source was not checked). Meituan Logan's default could not be confirmed.
- Bug reports usually come within days of the problem.
- Safari's ITP deletes all script-writable storage of a site the user has not interacted with for 7 days of Safari use. A WebKit maintainer said in Bugzilla 276998 that this covers OPFS, but no official document says so. A 7-day default stays within that limit either way. Users who visit regularly reset the counter, so a longer setting still works for them.
- Apps that need longer can raise it.

**Basis is weak:** no source gives a strong reason for 7 over 10 or 14. Revisit with field data.

**To verify:** whether Safari's 7-day cap actually deletes OPFS data.

## 052. `retention.maxBytes` defaults to 50MB (draft) and is a public option (2026-11-01)

**Decision:** The size limit defaults to 50MB, counted as bytes of segment files on disk in the namespace. Apps change it with `init({ retention: { maxBytes } })`. Only closed segments are deleted (#050); active segments count toward the total but are never deleted by retention.

**Basis:** none from other libraries; browser quotas (tens of percent of the disk) give no useful guide. At about 200 bytes per record (#017), one hour a day for 7 days is about 5MB at 1 record per second and 50MB at 10 per second. 50MB is a draft to revisit with field data.

**Why a public option:** the right value depends on the app's log volume and on whether it uploads. With upload, the limit decides how many local copies of uploaded logs stay; without upload, it is the whole local log.

## 053. Retention runs at the first idle point before upload, then every minute (internal) (2026-11-01)

**Decision:** The first retention run happens at the same point as the first upload run (#049), and runs before it. After that it runs on an internal interval of 1 minute (the same as the default upload interval). The interval is not a public option. Apps without `upload` follow the same schedule.

**Why:**
- A retention run also recovers orphaned `active/` files (#012). Running it first lets files left by crashed or closed tabs of earlier sessions reach `pending/` and be uploaded in the same first pass.
- A run is cheap: list directories, compare file names, one `navigator.locks.query()`.
- Users have little reason to change the interval. It can be opened later without breaking the API (#035).

## 054. Export includes closed segments and the calling tab's active segment (2026-11-01)

**Decision:** Export reads every closed segment in the namespace and the calling tab's own active segment: its worker flushes, then reads the file through its own handle. Other tabs' active segments are left out, and the result says how many were left out. This amends #021's "closed files also keep export and query away from files still being written".

**Why:**
- The main use is a bug report sent from the tab where the problem happened. The most important records are that tab's last few minutes, which are still in its active segment.
- Other tabs' records up to their last rotation (at most 5 minutes old by default) are included as closed segments.
- Asking other tabs for their active data (BroadcastChannel) would add the tab-to-tab path #006 avoids, plus handling for tabs that do not answer (frozen tabs).

**To verify:** whether another context can read a file while a tab holds a sync access handle on it (`getFile()`). If it can, other tabs' active segments can be added later without breaking the API.

> **Note (2026-11-01, step 7):** Step 6 confirmed that `getFile()` reads such a file in Chromium, Firefox, and WebKit (docs/design/benchmark.html). Other tabs' active segments still stay out of v0.1: the gain is only their last 0-5 minutes, and reading a file while the other tab keeps writing to it was not checked (a `File` from `getFile()` may throw `NotReadableError` once the file changes). Add them when users ask and that case is verified; `skipped.activeOtherTabs` then becomes 0.

## 055. `exportLogs({ from?, to? })` returns `{ file, skipped }` (2026-11-01)

**Decision:**

```ts
const { file, skipped } = await exportLogs({ from?: number, to?: number })
// file: Blob (application/x-ndjson), lines in the exported shape (#033)
// skipped: { activeOtherTabs: number, unreadable: number }
```

- The name is `exportLogs` because `export` is a reserved word.
- `from` and `to` limit the time range. Files are picked by the times in their names (#012) and lines by their leading `ts` (#016), without JSON parsing.
- `skipped.activeOtherTabs` counts other tabs' active segments left out (#054). `skipped.unreadable` counts files in a newer format (#013). These are information, not errors, so they are returned rather than sent to `onError`.
- No level or text filters. There is no query API in v0.1 (#057).

**Why:**
- A `Blob` works directly with `URL.createObjectURL` for a download link or as a `fetch` body, and matches `send()`'s file (#048).
- A bug report does not need the whole 50MB; a time range such as the last hour keeps it small, and the filter is cheap.

## 056. Exported lines are merged in time order across tabs (2026-11-01)

**Decision:** `exportLogs()` merges segments with a streaming k-way merge: one read position per open file, and the line with the earliest `ts` goes next. Files are opened in start-time order (#012) and only while their time range overlaps the output, so the number of open files is about the number of tabs that were open at the same time. `ts` is compared as the leading string of each line (#016), without parsing. Within one tab, lines always stay in `seq` order, even where the wall clock jumped back (#011).

**Why:**
- The main reader of an export is a person reading a bug report. Concatenating files in name order interleaves overlapping tabs in blocks, which is hard to read.
- The merge streams; it never holds the whole export in memory, unlike sorting it all (up to 50MB of parsing).
- Backends would re-sort anyway, but export is for people first. Upload sends one segment at a time and is not affected.

## 057. No query API in v0.1 (2026-11-01)

**Decision:** v0.1 has no `query()`. Searching stored logs by level, text, or tab is left out.

**Why:**
- The uses are covered: bug report files by `exportLogs({ from, to })` (#055), live debug panels by `subscribe()` (#042), server-side search by upload. An in-app view of past logs can parse the lines of a short `exportLogs()` range; it is a debugging use, so the cost is acceptable.
- A query API brings filters, result limits, paging, and object results into the public API, and its shape is hard to change once published (#035). It should follow real requests.
- The storage format already supports it (`ts` and `lv` at fixed positions, #016), so it can be added later without breaking anything. The segment scan benchmark (#016) stays, since export's time filter uses the same scan.

## 058. Step 6 covers only browser API checks and benchmarks that need no library code (2026-11-01)

**Decision:** Step 6 builds the environment for two kinds of checks, run in desktop Chromium, Firefox, and WebKit through Playwright:

1. Whether browser APIs behave as the design assumes: `move()` inside OPFS, `getFile()` on a file another worker holds a sync access handle on (#054), bfcache with a held Web Lock or sync access handle (#020), the worker path under Vite dev mode (#009). These run first, since a failure changes the design.
2. Speed measurements that need no library code: `JSON.stringify` of one record (#014), keeping strings vs `encodeInto` per call (#014, #015), `JSON.parse` of one flush batch (#042), scanning an 8MB segment (#016), JSON vs msgpackr (#016).

Measurements that need the implementation (flush interval and size #017, drops under bursts #018 #019, `pagehide` flush rate #020, GC cost #015, memory per worker) move to the implementation stage. Checks that need real devices or long runs (mobile Safari quota and eviction, ITP 7-day limit #051, freezing of lock holders #022, upload on slow networks #045, upload pile-up after an outage #047) become a manual checklist.

**Why:**
- Playwright's WebKit is not Safari, and Playwright cannot run on phones; CPU throttling in Chromium only approximates a low-end phone. Vitest browser mode fits desktop-engine checks, not mobile numbers.
- Flush and overload numbers depend on the real write path; measuring a stand-in would decide them twice.

## 059. Create the worker with the literal `new Worker(new URL('./worker.js', import.meta.url), ...)` expression; never hold the URL in a variable (2026-11-01)

**Decision:** The default worker is always created with `new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })` written as one expression. When `workerUrl` is given, a separate branch calls `new Worker(options.workerUrl, ...)`. The two calls stay duplicated on purpose; do not merge them into `new Worker(options.workerUrl ?? new URL(...))` or pass a `URL` held in a variable. In the implementation stage, a test checks that the built `dist` still contains the literal expression.

**Why:**
- Bundlers recognize a worker only by this exact expression. In Vite 8, a URL held in a variable works in dev, but `vite build` treats `worker.js` as a small asset and inlines it as a `data:` URL. A `data:` URL worker has an opaque origin, so OPFS fails with `SecurityError: Storage directory access is denied` (#009). The failure shows only in production builds.
- With the literal expression, Vite 8 works in dev without `optimizeDeps.exclude` and in build (`pnpm check:vite`, docs/design/benchmark.html).

**Not checked yet:** bundlers other than Vite.

## 060. No JSON vs msgpackr benchmark (2026-11-01)

**Decision:** The planned comparison of `JSON.stringify` with msgpackr (#016) is dropped.

**Why:**
- No result would change the decision. Using msgpackr would add a runtime dependency; the package has none and keeps it that way.
- Serialization already meets the target: under 1 µs for a medium record, 6.5 µs for a large one on Chromium with 4x CPU throttling (docs/design/benchmark.html).
- JSONL was also chosen because people can read it and it exports as is (#016). A faster binary encoder does not give that.

## 061. The main thread owns the tab ID and `seq`; every record line comes from a main-thread flush (2026-11-01)

**Decision:**
- The main thread creates the tab ID at `init()` and passes it to the worker. The worker uses it for the tab lock (#012, #034) and segment names. This replaces "the worker creates the tab ID" in storage-format.html.
- Every record line in a segment comes from a main-thread flush. The worker never writes record lines itself; it writes only header lines.
- The main thread counts the lines it sends, so it knows each record's `seq` when it builds the subscriber batch (#042). The worker sets a new segment's `seq0` from the number of lines it has written so far (#016). The two counts match because both see the same lines.
- Events that happen in the worker and should appear in the log (pending segments deleted by retention, #050) are sent to the main thread as counts. The main thread writes them as a drop line (#019) at its next flush. When such counts arrive, the main thread treats the queue as not empty and starts the flush timer (#017).

**Why:**
- Subscribers receive `tab` and `seq` (#042), and they are called before the batch is sent to the worker (#023). The main thread must know both values at that point, without waiting for the worker.
- If the worker inserted its own lines, the main thread's `seq` would drift from the file's line index.
- Overload drop lines (#019) are already written by the main thread, so retention drops use the same path.

**Rejected:**
- The worker owns `seq` and returns it in the ack: subscribers would have to wait for the ack, which #023 rejected.
- Leaving `seq` out of subscriber records: breaks "same shape as an exported line" (#042).

**Trade-off:** a retention drop line waits for the next flush of the tab that ran retention. If that tab closes within that interval, the line is lost. Only the record of the deletion is lost, not log content.

## 062. Outside a browser page, the library does nothing (2026-11-01)

**Decision:** When the module is imported, it checks `typeof document === 'undefined'` once. If there is no `document` (Node, Deno, Bun, SSR, a Web Worker), the logger starts in the closed state (#030) and stays there: `log()` returns at once, and `init()`, `setContext()`, `subscribe()`, and `flush()` do nothing. No warning or error is printed. The library works only in a browser page.

**Why:**
- SSR frameworks (Next.js, Nuxt, SvelteKit) run the same component code on the server. Without this, `log()` calls there would fill the before-`init()` queue (#028) up to the cap in a long-lived server process and keep paying serialization for records that can never be written. An `init()` reached on the server would print `opfs-unavailable` in every server process.
- It follows #041: a logger with nowhere to write must not cost anything. It reuses the closed state instead of adding one.
- The check runs once at import, so `log()` pays nothing for it.
- No warning, because running on the server is normal SSR use, not a mistake. A warning would show for every SSR user (the same reason #034 avoids false warnings).
- Prior art: browser SDKs such as Datadog Browser SDK and PostHog do nothing on the server.

**Trade-off:** logs called on the server are not kept anywhere. The README says so.

## 063. `exportLogs()` outside the running state resolves at once with an empty result (2026-11-01)

**Decision:** When the logger is not running (before `init()`, after `close()`, after `opfs-unavailable` or `worker-load-failed` (#041), or outside a browser page (#062)), `exportLogs()` resolves at once with an empty `Blob` and `skipped` counts of 0. It never rejects.

**Why:**
- Same rule as `flush()` (#038), which returns `true` at once after `close()`. One rule for every state, no special cases.
- "No logs" and "could not read" look the same, but the app can tell them apart where it matters: a storage failure was already reported through `onError` (#041), and a call before `init()` is a developer mistake that shows up as an empty file during development.
- After `close()` for a consent withdrawal (#030), handing out stored logs would go against the reason for closing.
- Tests call `exportLogs()` before `close()`.

**Rejected:**
- Rejecting with an `OpfslogdError`: callers would need try/catch, against the rule that the library does not throw into app code (#040) and against `flush()` never rejecting.
- Per-state behavior (wait for `init()` with a timeout, start a temporary worker after `close()`): state-dependent rules and a second worker lifecycle for rare uses.

## 064. Any failed segment write is rolled back, acked as failed, counted as dropped, and followed by a rotation (2026-11-01)

**Decision:** When `handle.write()` throws, for any reason:
1. The worker truncates the file back to the offset before the write, so no partial line stays in the segment.
2. The worker still acks the flush, as `{ id, ok: false }`. The main thread subtracts it from `inFlight` as usual (#018) and adds the flush's line count to the drop counters. The next flush writes a drop line (#019) with `ctx.reason` `"quota"` for `QuotaExceededError` and `"write-failed"` for anything else.
3. The lost lines keep their `seq` numbers, since subscribers already received them (#061). The worker rotates, so the gap falls between segments: the next segment is opened at the next write, with `seq0` equal to the number of lines the worker has **received**. The flush message carries its line count, so the worker does not have to count newlines. If opening the new segment also fails, that flush takes the same path.
4. `onError` gets `quota-exceeded` or the new code `write-failed` (#040) once when failures start. It is called again only after a successful write followed by a new failure.
5. Freeing space is left to the normal retention schedule (#053). No extra trigger.

**Why:**
- A partial write followed by later appends leaves a broken line in the middle of a segment. Crash recovery (#016) truncates at the first bad line, so every good line after it would be lost too.
- Without an ack, `inFlight` never shrinks, #019 rejects everything, and the main thread reports `worker-unresponsive` by mistake.
- The main thread counted the lines as sent and gave them `seq` numbers (#061); it cannot take them back. Rotation keeps `seq = seq0 + line index` true inside every segment, with an existing mechanism (#021).
- One path for every write error, with the error name deciding only `reason` and the error code. No per-cause branches.
- While storage is full, every flush (about 5 per second) fails. Reporting each one would flood error trackers.
- If the device is full below the retention limit, an early retention run would free little.

**Rejected:**
- Rolling back `seq` on the main thread: subscribers already have the numbers.
- A gap marker line inside the segment: breaks #016's "every line starts with `ts` and `lv`" and "`seq` is the line index", as in #031.

**To verify (implementation):** whether browsers write part of the data before throwing `QuotaExceededError`. The truncate stays either way; it costs almost nothing.

> **Measured (2026-11-01, step 8):** neither Chromium nor Firefox throws `QuotaExceededError` from a sync handle `write()` when storage is full. Chromium writes part of the data and returns a bogus count (4294967288); Firefox writes nothing and returns 0. The worker therefore treats a write that returns a count other than the batch length as `quota`, and the truncate is required (Chromium leaves partial data). WebKit is on the manual device list. docs/design/benchmark.html#impl-results

## 065. No `persist()` option; apps call `navigator.storage.persist()` themselves (2026-11-01)

**Decision:** The library never calls `navigator.storage.persist()` and has no option for it. The README tells apps that need logs to survive storage pressure to call it themselves. This replaces architecture.html's "the user turns it on with an option".

**Why:**
- Persistence applies to the whole origin (IndexedDB, caches, everything), not just logs. That is the app's decision, not a logging library's.
- Firefox shows a permission prompt for it. A logging option should not put a permission request in front of the app's users.
- It is one line in app code. An option wrapping it adds nothing.
- Logs are diagnostic and stored best effort (#019, #064). Losing them under storage pressure does not break the app.
- It can be added later without breaking the API (#035).

## 066. Segment size limit drops from 8MB to 2MB (draft, internal) (2026-11-01)

**Decision:** The worker rotates at 2MB instead of 8MB (#021). It stays an internal constant (#035). The value is a draft to confirm by measurement.

**Why:** 8MB came from step 1 with no basis, and #035's promise to revisit it with the retention and upload options was not kept. At about 200 bytes per record (#052), 8MB collides with later decisions:
- Upload timeout: 8MB over a 1Mbps link takes about 64 seconds, past the 60-second `upload.timeoutMs` default (#045). A full segment would time out on every run, and since a run stops at its first failure (#046), the segments behind it would never upload.
- Active segments count toward `retention.maxBytes` but cannot be deleted (#052). Five tabs with full 8MB active segments hold 40MB of the 50MB default.
- Each retention deletion removes 16% of 50MB at once.

At 2MB: about 16 seconds at 1Mbps, 10MB for five full active segments, 4% per deletion.

> **Measured (2026-11-01, step 8):** the uploaded file is about 1.4 times the segment, because every exported line carries `tab`, `seq`, and `context` (#033). A full 2MB segment uploads as about 2.8MB, about 22 seconds at 1Mbps: still inside the 60-second `upload.timeoutMs` default (#045). Converting it and computing its sha256 takes 14-43ms in the worker. docs/design/benchmark.html#impl-results-3 The size limit only matters above about 35 records per second (below that, the 5-minute age limit rotates first), so apps that log little see no difference.

**Trade-off:** apps that log a lot send about 4 times as many uploads (about 6 per minute at 1,000 records per second). A very small `retention.maxBytes` (near 2MB) still deletes coarsely; deriving the segment size from it was rejected as an extra rule.

**To measure (implementation, devices):** upload time of a 2MB segment on slow mobile links, upload request rate for high-volume apps, retention behavior with several tabs open.

## 067. File-name times are the minimum and maximum `ts` of the segment's records (2026-11-01)

**Decision:** In a closed segment name `{startTs}_{endTs}_{tabId}.seg` (#012), `startTs` is the smallest and `endTs` the largest `ts` of the records in the file. `meta.from` and `meta.to` of `send()` (#048) are the same two values. This makes "first" and "last" record in #012 and #048 exact.
- Each flush message carries the batch's minimum and maximum `ts`. The main thread knows every `ts` at `log()` time, so this is two comparisons per call.
- The worker keeps a running minimum and maximum per segment and uses them in the name when the segment leaves `active/`.
- Orphan recovery already checks every line (#016) and computes the two values then.
- An active segment is named with the minimum `ts` of its first write. Its own tab's export uses the worker's in-memory values, so the active name needs no update.
- The file-name format does not change (#013); only the meaning of the values becomes exact.

**Why:** Four things rely on these times: export file selection (#055), merge order (#056), retention age (#050), and `meta.from`/`to` (#048). Two cases put records outside the range with "creation time" and "last record" semantics:
- Records queued before `init()` (#028) are older than the file.
- When the wall clock jumps back (#011), the last record is not the latest. `endTs` then looks too old, so retention could delete the file early and `exportLogs({ from })` could skip it.

## 068. Tabs with different `upload` settings: each closed segment follows the setting of the tab that closes it (2026-11-01)

**Decision:** No change in behavior; this records it. A segment goes to `pending/` or `done/` according to the `upload` setting of the tab that closes it: the owner tab when it rotates or closes (#021, #030), or the retention holder when it recovers an orphan (#012). Segments closed while `upload` was not set are in `done/` and are never uploaded later, even if another tab with `upload` comes along. The README and api.html state this.

Settings mix in three cases:
1. Right after a deploy that first adds `upload`: old tabs without it run next to new tabs with it for a while.
2. Conditional upload: only for users who consented, or for sampled sessions.
3. Orphan recovery: the recovering tab's setting decides where the orphan goes.

**Why:**
- It is the existing rule ("the tab that holds the lock uses its own config", #006) applied to segment state.
- For consent and sampling (case 2) it is the right behavior: logs from a period without upload are not uploaded later.
- Case 1 happens once per such deploy, for a few minutes, and those logs stay on the device. Case 3 decides only whether a file is uploaded; no data is damaged.

**Rejected:** always moving closed segments to `pending/` and reaching `done/` only by upload. Apps without `upload` would have every retention deletion reported as a deleted pending segment (#050), unless drop lines got an extra "only with upload" condition. It would also upload logs from before a consent once upload is turned on.

## 069. No minimum level option in v0.1; callers decide whether to log (2026-11-01)

**Decision:** There is no `level` option and no extra argument for it. Code that should not log in some environments checks for itself:

```ts
if (isDev) logger.debug('scroll', { y })
```

**Why:**
- An `{ enabled }` argument would do what an `if` already does, and would break the `(msg, ctx?)` shape (#024), the same reason #025 rejected a third argument.
- An `if` at the call site is cheaper than any library check: the `ctx` object is never built.
- `init({ level })` can be added later without breaking the API (#035).

**Trade-off:** apps cannot turn off `debug` in one place, and calls from third-party packages that log to this logger cannot be filtered. In production, `debug` records fill retention (#052) and upload volume faster. Revisit if users ask.

## 070. Drop lines: one per reason per flush; `from` and `to` are the time range of the lost records (2026-11-01)

**Decision:** Fills in the drop line fields left open by #019, #050, and #064. All drop lines keep `lv` `"warn"` and `msg` `"opfslogd: records dropped"` (#044), and skip the overload cap.

```jsonc
// overload (#019)
{"reason":"overload","dropped":{"debug":1200,"info":300},"from":…,"to":…}
// failed write (#064): same shape as overload
{"reason":"quota","dropped":{"info":800,"error":2},"from":…,"to":…}
{"reason":"write-failed","dropped":{"info":800},"from":…,"to":…}
// retention (#050): record count unknown without reading the file
{"reason":"retention","segments":3,"bytes":6200000,"from":…,"to":…}
```

- A flush writes one drop line per reason that has counts, so at most four. Lines are appended after the flush's records in a fixed order: overload, quota, write-failed, retention.
- `dropped` counts by level and lists only levels above zero. For a failed write, the main thread keeps the per-level line counts of each in-flight flush (four numbers) next to its size (#018).
- `from` and `to` are the smallest and largest `ts` of the lost records: the `log()` call times for overload, the flush's `minTs` and `maxTs` for a failed write (#067), and the times in the deleted file names for retention (#012).

**Why:**
- `reason` holds one value, so mixed reasons need separate lines. The count is still bounded per flush, which is what #019's "one line per flush" protected.
- The same shape for overload and failed writes lets readers handle both with one piece of code.
- One meaning for `from` and `to` everywhere: the gap a reader should expect in the log.
- Counting records in deleted segments would mean reading every file before deleting it. Segments and bytes are known from the directory listing.

**Known effect:** drop lines travel in a flush like any other line. If that flush fails, their detail is lost; the new `quota` or `write-failed` line counts them as `warn` lines and its `from`/`to` covers the gap. This needs storage failure and overload at the same time, so the counts are not put back.

## 071. Segment header keys are `format`, `minReader`, `tab`, `seq0`, `context` (2026-11-01)

**Decision:** The draft key names of the header line (#016) are final:

```json
{"format":1,"minReader":1,"tab":"k3f9","seq0":0,"context":{"version":"2.3.1"}}
```

`format` and `minReader` are #013's `formatVersion` and `minReaderVersion`. The header always has `context`, `{}` when empty. Exported lines (#033) leave out `context` when it is empty.

**Why:**
- `tab` and `context` match the keys of an exported line, so the mapping is obvious.
- The header is one line per file, so key length does not matter.
- The header starts with `{"format":` and record lines with `{"ts":`, so the two are easy to tell apart.
- An empty `context` on every exported line adds bytes and no information.

## 072. Tab ID: 8 random lowercase letters and digits (2026-11-01)

**Decision:** The main thread creates the tab ID (#061) as 8 characters from `[0-9a-z]` (base36), drawn with `crypto.getRandomValues`. No check for an ID already in use.

**Why:**
- The ID appears in file names (`_` is the separator), lock names (`:` is the separator), and every exported line. Base36 has neither separator and stays short (about 15 bytes per exported line with the key).
- 36^8 is about 2.8 × 10^12. Two tabs open at the same time on one origin practically never collide, and old files are told apart by the `startTs` in front of the ID.
- A collision check (try the tab lock with `ifAvailable`, retry on failure) adds code for an event that does not happen in practice.

**Rejected:** `crypto.randomUUID()` (36 characters, about 30 more bytes per exported line, more uniqueness than this needs); 6 characters (about 2 × 10^9, saves only 2 characters).

## 073. `namespace` allows `[a-z0-9_-]`, 1-64 characters; an invalid value reports `invalid-option` and leaves the logger closed (2026-11-01)

**Decision:** `namespace` (#034) must match `/^[a-z0-9_-]{1,64}$/`. When it does not, `init()` does not throw. It reports a new `OpfslogdError` code, `invalid-option` (#040), and the logger behaves as closed, as in #041 (no warning from #030; the error report already says why).

**Why:**
- No `/` or `.`: safe as an OPFS directory name (no `..`, no path separator).
- No `:`: lock names stay unambiguous (`opfslogd:{ns}:tab:{tabId}`).
- No uppercase: whether OPFS names are case-sensitive was not checked on every engine, so `App` and `app` might or might not share a directory.
- Starting strict keeps a later loosening non-breaking; tightening later would break users.
- The library never throws into app code (#040). Without `onError`, `console.error` prints once, so a typo does not go unnoticed.

**Rejected:** rewriting invalid characters (`My App` to `my-app`). Two different namespaces could map to one directory, the same mixing #034 exists to prevent.

## 074. The worker calls `handle.flush()` only when a segment is closed, not after every write (2026-11-01)

**Decision:** After each batch the worker calls `handle.write()` and acks. `handle.flush()` runs only when the segment is rotated or closed, just before the handle is closed and the file moved.

**Why:**
- `flush()` asks the system to persist the data to disk (like `fsync`). On every batch (about 5 per second per tab) that is a disk sync per batch, mostly on mobile flash.
- What a log loses without it is narrow: data that the browser already took but the OS had not yet stored when the whole device lost power or the OS crashed. A tab crash or kill is the common case, and data handed to the OS survives it.

**To verify (implementation, step 10):** that a killed renderer keeps every acked write in Chromium, Firefox, and WebKit, and the cost of `flush()` per batch. If an engine loses acked writes, flush per batch there.

> **Measured (2026-11-01, step 8):** after `SIGKILL` of the whole browser, all acked writes (11MB in 40 batches) were on disk in Chromium, Firefox, and WebKit. On macOS desktop, `flush()` after every write made no measurable difference to the write round trip (about 0.4-1.1ms per 257KB batch). Decision stands. Power loss was not tested. docs/design/benchmark.html#impl-results

## 075. Closed segments with no records are deleted; a closed-name clash raises `maxTs` by 1ms (2026-11-01)

**Decision:**
- A segment is opened at the first write (#064), so a segment without records exists only when its first batch failed. Rotation deletes such a segment instead of moving it.
- If the closed name (#012, #067) already exists in the target directory, the worker raises the `maxTs` in the name by 1ms until the name is free.

**Why:**
- A file with only a header line holds nothing for export or upload.
- `move()` onto an existing name replaces that file. A clash needs two segments of one tab whose records all share one millisecond, for example two context changes (#031) within 1ms. Losing a whole segment for that is worse than a name range 1ms wider than the records; the range still covers every record, which is what #067 relies on.

## 076. Main-thread details settled in implementation: ack timeout 10s, `close()` gives up after 5s, `flush()` is `false` after a failed write (2026-11-01)

**Decision:**
- `worker-unresponsive` (#040) is reported when batches are in flight and no ack has arrived for 10 seconds. It is reported once and again only after acks have resumed and stopped again.
- `close()` (#030) waits at most 5 seconds for the last ack, then at most 5 seconds for the worker to move its segment, then terminates the worker either way. If the move did not happen, orphan recovery moves the file later (#020).
- `flush()` (#038) resolves `false` when a batch it waited for was acked as failed (#064), not only on timeout. "Written" means on disk.
- The main thread sends batches right after `init()` creates the worker, without waiting for the worker's ready message. The worker handles messages in order, so they are written after it has started; if it fails to start, the logger closes (#041).
- Level methods take `ctx?: object`, not `Record<string, unknown>`. An interface or class instance has no index signature and would not type-check against `Record<string, unknown>`.

**Why:**
- A 257KB batch is written in about 1ms (docs/design/benchmark.html#impl-results). Even with the worker busy preparing an export or an upload, 10 seconds without any ack means the worker is dead or stuck. A shorter limit would report false alarms during long main-thread tasks, which delay ack handling (#018).
- `close()` is awaited by app code (logout, tests). A dead worker must not make it hang.
- A `flush()` that returns `true` while the records were dropped would tell the caller the opposite of what happened.
- Waiting for ready before sending would add a state and a second queue for no gain.

## 077. The flush interval is 50ms (2026-11-01)

**Decision:** The flush timer of #017 is 50ms instead of the 200ms draft. The size trigger (256K characters), the error trigger (50ms gap), the cap (4M characters), and the 80% threshold stay as they are.

**Why:**
- One flush costs 13-23µs on desktop engines and 47µs with 4x CPU throttling, for sending plus ack handling (docs/design/benchmark.html#impl-results-2). At 50ms that is about 0.1% of main-thread time on the throttled run, well under #017's 1%.
- #017's rule ("the shortest interval with flush cost at or below 1%") would allow about 5ms. It leaves out the cost of waking up: the timer fires and the worker writes on every flush while records keep coming. At 5-10ms that is 100-200 wake-ups per second for a small gain.
- What a shorter interval buys is narrow: the records lost when the renderer crashes. Navigation, hiding, and error records already flush at once (#017, #020), and navigation lost nothing in the measurement. 50ms cuts the crash window to a quarter of 200ms at a cost that stays negligible.
- Measurements also showed the 4M-character cap and the 80% threshold are reached only when one task logs more than about 17,000 records; a 100k/s burst split across tasks drops nothing. No reason to change them.

**To verify:** flush cost on a real low-end phone. `pnpm bench:serve` cannot measure it over plain http on the LAN (OPFS needs a secure context); use Android USB port forwarding or https.

## 078. Retention details settled in implementation: orphans without records are deleted; the run goes beside writes; the main thread schedules it (2026-11-01)

**Decision:**
- Orphan recovery (#012) deletes an orphaned `active/` file that holds no records (header line only, or a header line followed only by bad lines). It does not move an empty file to `pending/`. Same rule as #075 for the writer's own segments.
- A recovered orphan goes to `pending/` or `done/` by the upload setting of the tab that runs retention (#068).
- The worker runs retention outside its ordered message handling, so writes and acks continue during a run. The run never touches a file whose tab lock is held, which includes the running tab's own active file.
- The worker has no `requestIdleCallback`, so the main thread picks the times: after the `load` event and `requestIdleCallback` (a 1-second `setTimeout` where it is missing), then every minute (#049, #053). Each time it posts a `maintain` message; the worker runs only if it gets the retention lock with `ifAvailable` (#022), and reports back. Deleted `pending/` segments come back as counts for the drop line (#061, #070).
- The size limit (#052) sorts closed segments by file name, which is start time order (#012).

**Why:**
- A file without records has nothing to export or upload. Since segments open at the first write (#064), such an orphan exists only when a tab died between writing the header and the first batch.
- Running retention inside the ordered handling would hold back every write while it lists directories and scans orphans. It touches other files, so there is no conflict to order.
- Scheduling on the main thread keeps one place for the idle rule that upload (#049) will share.

## 079. Upload details settled in implementation (2026-11-01)

**Decision:**
- The main thread takes the upload lock (`ifAvailable`, #022) and calls `send()` (#007). For each segment it asks the worker, in order: the list of `pending/` names (oldest first, #047), the converted file, then "move to `done/`" after `send()` resolves. The worker does these steps beside its writes, as with retention (#078); they touch only `pending/` and `done/`.
- The worker builds the file from the segment's good lines (cut at the first bad line, #016), adds `tab`, `seq`, and `context` (#033), and computes `sha256` with `crypto.subtle` over exactly those bytes (#048). `from` and `to` come from the records (#067).
- The upload loop starts right after the first retention run reports back (#053), then runs every `upload.intervalMs`. Retention keeps its own 1-minute timer. A run is skipped while the previous one in the same tab is still going.
- A `pending/` file in a newer format (#013) is skipped and reported as `unreadable-file` once per file per page load, not on every run.
- After `close()`, an upload run in progress stops at its next step. A segment whose `send()` resolved but was not yet moved to `done/` is sent again later (#007 at-least-once).
- Invalid `upload` options (no `send` function, non-positive `intervalMs` or `timeoutMs`) report `invalid-option` (#073).

**Why:**
- Functions cannot cross to the worker, so `send()` and therefore the lock live on the main thread. Reading, converting, and hashing a 2MB segment stay off the main thread.
- One report per file keeps a newer tab's files from producing an error every minute in an error tracker.

## 080. Export details settled in implementation (2026-11-01)

**Decision:**
- `exportLogs()` first flushes (#038), then asks the worker. The worker copies its own active segment through its own handle in message order, so the copy holds every record flushed before the call (#054). The merge then runs beside writes, like retention (#078).
- Every `active/` file other than this tab's is left out and counted in `skipped.activeOtherTabs`, including orphans that retention has not recovered yet. They are exported once recovered.
- The merged output is folded into the `Blob` about every 1M characters, so the export does not sit in the worker's JS heap as one string. Input files are read whole (at most about 2MB each, #066), and only files whose time ranges overlap are open together (#056).
- A `from` or `to` that is not a finite number is ignored.

**Why:**
- Copying the active segment in order needs no extra state and cannot see a half-written batch. Holding writes back for the whole merge (up to 50MB, #052) would delay acks and trip the overload limits (#019).
- Treating unrecovered orphans as "not exported yet" keeps one rule for `active/`: only the owner reads its active file.
