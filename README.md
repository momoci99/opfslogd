# opfslogd

Browser logging library that keeps logs on the device, in the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) (OPFS), written by a [Dedicated Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker) off the main thread. Tabs coordinate with [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). Upload to your own backend is optional.

> Work in progress (`0.x`). The API may change before `1.0`.

- `log()` costs under a microsecond for a typical record on desktop browsers, and never throws.
- Records survive reloads, closed tabs, and crashes (a crash can lose its last 50ms). A bug report can include the last minutes before the problem.
- Upload uses a function you write, so it fits any backend.
- Zero runtime dependencies. ESM only. Browser only.

## Install

```sh
pnpm add opfslogd
```

## Quick start

```ts
// main.ts: once, at your app's entry point
import { init } from 'opfslogd'

init({ context: { version: '2.3.1' } })
```

```ts
// anywhere
import { logger } from 'opfslogd'

logger.info('checkout clicked', { cartItems: 3 })

try {
  await pay()
} catch (e) {
  logger.error('payment failed', { err: e, orderId })
}
```

Records logged before `init()` wait in memory and are written once it runs.

## API

| Export | What it does |
|---|---|
| `logger.debug/info/warn/error(msg, ctx?)` | Records one line. `ctx` is any object. Never throws. |
| `init(options?)` | Starts storage. Later calls are ignored with one console warning. |
| `setContext(partial)` | Shallow-merges global context added to every exported line. `undefined` removes a key. |
| `flush(timeoutMs?)` | Resolves `true` once queued records are on disk, `false` after the timeout (default 5s) or a failed write. Never rejects. |
| `close()` | Writes what is queued, closes the current file, and stops. Later `log()` calls are discarded. |
| `subscribe(fn)` | Calls `fn(records)` at each write, for debug panels and tests. Returns an unsubscribe function. |
| `exportLogs({ from?, to? })` | Stored logs as one JSON Lines `Blob`, in time order. |
| `OpfslogdError` | Error class passed to `onError`, with a `code`. |

### Errors

Pass errors as `ctx.err`, or as `ctx` itself. Their `name`, `message`, `stack`, `cause` chain (5 levels), and own properties (such as `status`) are stored:

```ts
logger.error('upload failed', { err: e, fileId })
logger.error('upload failed', e)
```

An `Error` nested deeper inside `ctx` is stored as `{}`.

### Options

```ts
init({
  namespace: 'default',            // see "Several apps on one domain"
  context: { version: '2.3.1' },   // global context
  rotate: { maxAgeMs: 300_000 },   // close the current file after 5 minutes
  retention: {
    maxBytes: 50_000_000,          // keep at most 50MB on the device
    maxAgeMs: 7 * 86_400_000,      // and nothing older than 7 days
  },
  upload: { send, intervalMs: 60_000, timeoutMs: 60_000 },
  onError(err) { Sentry.captureException(err) },
  workerUrl,                       // only if your bundler cannot find worker.js
})
```

Without `onError`, each error code is printed once with `console.error`. Codes: `opfs-unavailable`, `worker-load-failed`, `quota-exceeded`, `write-failed`, `worker-unresponsive`, `unreadable-file`, `invalid-option`. When storage cannot start, the logger stops and costs nothing.

## Exported format

Exports and uploads are [JSON Lines](https://jsonlines.org/), one record per line:

```json
{"ts":1793251200123,"lv":"info","msg":"clicked","ctx":{"id":7},"tab":"k3f9x2ab","seq":42,"context":{"version":"2.3.1"}}
```

| Field | Meaning |
|---|---|
| `ts` | `Date.now()` when `log()` was called |
| `lv` | `debug`, `info`, `warn`, or `error` |
| `msg`, `ctx`, `err` | What was logged |
| `tab` | Random ID of the tab |
| `seq` | Order within the tab. Use it, not `ts`, to order one tab's lines: the clock can jump back. |
| `context` | Global context; absent when empty |

### Dropped records

When the device cannot keep up, or storage is full, records are dropped. A line records it:

```json
{"ts":…,"lv":"warn","msg":"opfslogd: records dropped","ctx":{"reason":"overload","dropped":{"debug":1200,"info":300},"from":…,"to":…}}
```

`msg` and `ctx.reason` are a stable contract. Reasons: `overload`, `quota`, `write-failed`, and `retention` (unuploaded files deleted by the limits above; this one has `segments` and `bytes` instead of `dropped`). `from` and `to` give the time range that is missing.

## Upload

```ts
init({
  upload: {
    async send(file, meta) {
      const res = await fetch('/logs', {
        method: 'POST',
        body: file, // JSON Lines Blob
        headers: { 'x-segment-id': meta.segmentId, 'x-sha256': meta.sha256 },
        signal: meta.signal,
      })
      if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    },
  },
})
```

- Logs are written to files of up to about 2MB, closed after 5 minutes or when full. Closed files are uploaded one at a time, oldest first, every `intervalMs`, and the first time soon after the page loads.
- Resolve when your backend has the file. Reject to retry on the next run; a run stops at the first failure.
- `meta`: `segmentId`, `sha256` (hex, of `file`), `size`, `from`, `to`, `signal`. The signal is aborted after `timeoutMs`.
- Delivery is **at least once**. Deduplicate on `segmentId`.
- Only one tab uploads at a time.
- Files closed while `upload` was not set are never uploaded later. This suits consent: logs from before the user agreed stay local.
- Compress if you like: `file.stream().pipeThrough(new CompressionStream('gzip'))`.

## Export for bug reports

```ts
import { exportLogs } from 'opfslogd'

const { file, skipped } = await exportLogs({ from: Date.now() - 60 * 60_000 })
const url = URL.createObjectURL(file)
```

The export holds every closed file plus the current tab's open one. Other tabs' open files (at most their last few minutes) are left out and counted in `skipped.activeOtherTabs`.

## Several apps on one domain

OPFS and Web Locks are per origin. If two apps share an origin (`user.github.io/app1` and `/app2`, several apps under one company domain, micro frontends) and both keep the default namespace, they share one directory: **one app's `send()` uploads the other app's logs to its own backend.** Give each app its own `namespace` (`[a-z0-9_-]`, up to 64 characters).

## Things to know

- **Bundlers.** The worker is a separate file, `worker.js`, loaded with `new Worker(new URL('./worker.js', import.meta.url))`. Vite handles this with no config (checked in dev and build). If your bundler does not, copy `worker.js` from the package and pass its URL as `workerUrl`.
- **CSP.** The worker needs `worker-src 'self'` (or the origin you serve it from). No `blob:` or `data:` URLs are used.
- **Server-side rendering.** Outside a browser page (Node, SSR), every function does nothing.
- **Logout or consent withdrawn.** Call `close()`. It stops logging; later records are discarded, not queued.
- **No level filter.** There is no minimum-level option; skip calls yourself (`if (isDev) logger.debug(...)`).
- **Storage persistence.** Browsers may evict OPFS data under storage pressure. Call `navigator.storage.persist()` yourself if you need it.
- **Secure context.** OPFS needs https (or `localhost`).

## Browser support

Current Chromium-based browsers, Firefox, and Safari on desktop: anything with OPFS `createSyncAccessHandle()` in workers, `FileSystemFileHandle.move()`, and Web Locks. Tests run in Chromium, Firefox, and WebKit. Safari private browsing may not allow OPFS; the logger then reports `opfs-unavailable` and does nothing.

**Mobile browsers are not verified yet.** Chrome on Android and Safari on iOS have the APIs above, but the library has not been tested or measured on real phones. Storage limits, background tab handling, and speed may differ. Real-device checks are planned before 1.0.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Design documents start at [docs/design/index.html](docs/design/index.html); decisions are in [docs/decisions.md](docs/decisions.md).

## License

MIT
