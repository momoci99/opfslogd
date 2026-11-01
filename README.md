# opfslogd

English · [한국어](#한국어)

Browser logging library that keeps logs on the device, in the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) (OPFS), written by a [Dedicated Worker](https://developer.mozilla.org/en-US/docs/Web/API/Worker) off the main thread. Tabs coordinate with [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). Upload to your own backend is optional.

> Work in progress (`0.x`). The API may change before `1.0`.

- `log()` costs under a microsecond for a typical record on desktop browsers, and never throws.
- Records survive reloads, closed tabs, and crashes (a crash can lose its last 50ms). A bug report can include the last minutes before the problem.
- Upload uses a function you write, so it fits any backend.
- Zero runtime dependencies. ESM only. Browser only.

## When to use it

opfslogd is a flight recorder for web apps: keep a lot of logs on the device, cheaply, and look at them when something goes wrong.

Good fits:

- **Heavy, long-running apps** (web IDEs, editors, video calls, trading screens, games) that want detailed debug logs from the minutes before a crash or a bug, at a volume too large to send to a server all the time.
- **Offline apps and PWAs** (field work, point of sale, warehouses, kiosks): logs are kept while offline and uploaded when the connection is back.
- **Apps with "please send us your logs" support**: one `exportLogs()` call gives a file to attach, like a desktop app's log file.
- **Privacy-sensitive apps**: logs stay on the device until the user agrees or files a report.
- **Next to an error tracker**: Sentry and similar tools keep a short trail of recent events. Attach `exportLogs()` output to an error report for the full story.

Not a good fit:

- Sites that only need to collect errors: an error tracker is enough.
- Apps that log little: `sendBeacon()` or IndexedDB is simpler.
- Live server-side log streams: send them directly.
- Session replay: use a tool built for it.

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

### Playground

A page to try the API by hand, run from a clone of this repo:

```sh
pnpm install
pnpm playground
```

It opens `http://localhost:5181/playground/`. The page loads the source in `src/` directly, so edits show up on reload with no build. It has buttons for `init()`, `close()`, the four log levels, bursts and steady streams of records, `setContext()`, `flush()`, `exportLogs()`, and a fake upload `send()` that can resolve, reject, or never settle. It shows records from `subscribe()`, errors from `onError`, and the segment files in OPFS. Open it in several tabs to see locks, retention, and upload across tabs. `pnpm playground --host` also serves it on the LAN, but phones block OPFS without https.

### More

See [CONTRIBUTING.md](CONTRIBUTING.md). Design documents start at [docs/design/index.html](docs/design/index.html), with a one-page summary in [docs/design/overview.html](docs/design/overview.html) (Korean); decisions are in [docs/decisions.md](docs/decisions.md).

## License

MIT

---

# 한국어

[English](#opfslogd) · 한국어

브라우저 로그를 기기 안의 [Origin Private File System](https://developer.mozilla.org/ko/docs/Web/API/File_System_API/Origin_private_file_system)(OPFS)에 저장하는 라이브러리입니다. 파일 쓰기는 메인 스레드가 아닌 [Dedicated Worker](https://developer.mozilla.org/ko/docs/Web/API/Worker)가 합니다. 탭 사이 조율은 [Web Locks](https://developer.mozilla.org/ko/docs/Web/API/Web_Locks_API)로 합니다. 직접 만든 백엔드로 업로드하는 기능은 선택입니다.

> 개발 중(`0.x`)입니다. `1.0` 전에 API가 바뀔 수 있습니다.

- 데스크톱 브라우저에서 일반적인 기록 한 건의 `log()` 비용은 1µs 미만이고, 예외를 던지지 않습니다.
- 새로고침, 탭 닫기, 크래시에도 기록이 남습니다(크래시 때는 마지막 50ms를 잃을 수 있습니다). 버그 리포트에 문제 직전 몇 분의 로그를 담을 수 있습니다.
- 업로드는 직접 작성한 함수로 하므로 어떤 백엔드에도 맞습니다.
- 런타임 의존성이 없습니다. ESM 전용, 브라우저 전용입니다.

## 언제 쓰면 좋은가

opfslogd는 웹앱의 블랙박스입니다. 로그를 기기에 많이, 싸게 쌓아 두고, 문제가 생겼을 때 꺼내 봅니다.

잘 맞는 경우:

- **무겁고 오래 켜 두는 앱**(웹 IDE, 편집기, 화상 회의, 트레이딩 화면, 게임): 크래시나 버그 직전 몇 분의 자세한 debug 로그가 필요하지만, 늘 서버로 보내기에는 양이 너무 많을 때.
- **오프라인 앱과 PWA**(현장 작업, 매장 POS, 창고, 키오스크): 오프라인 동안 로그를 쌓아 두고, 연결되면 업로드합니다.
- **"로그를 보내 주세요"라고 요청하는 고객 지원이 있는 앱**: `exportLogs()` 한 번이면 데스크톱 앱의 로그 파일처럼 첨부할 파일이 나옵니다.
- **개인정보에 민감한 앱**: 사용자가 동의하거나 신고하기 전까지 로그는 기기에만 있습니다.
- **에러 추적 도구와 함께**: Sentry 같은 도구는 최근 이벤트를 짧게만 남깁니다. 에러 리포트에 `exportLogs()` 결과를 붙이면 전체 흐름을 볼 수 있습니다.

잘 맞지 않는 경우:

- 에러만 모으면 되는 사이트: 에러 추적 도구로 충분합니다.
- 로그가 적은 앱: `sendBeacon()`이나 IndexedDB가 더 간단합니다.
- 서버에서 실시간으로 보는 로그: 바로 전송하세요.
- 화면 재현(session replay): 그 용도로 만든 도구를 쓰세요.

## 설치

```sh
pnpm add opfslogd
```

## 빠른 시작

```ts
// main.ts: 앱 진입점에서 한 번
import { init } from 'opfslogd'

init({ context: { version: '2.3.1' } })
```

```ts
// 어디서든
import { logger } from 'opfslogd'

logger.info('checkout clicked', { cartItems: 3 })

try {
  await pay()
} catch (e) {
  logger.error('payment failed', { err: e, orderId })
}
```

`init()` 전에 남긴 기록은 메모리에서 기다렸다가 `init()`이 실행되면 저장됩니다.

## API

| Export | 하는 일 |
|---|---|
| `logger.debug/info/warn/error(msg, ctx?)` | 한 줄을 기록합니다. `ctx`는 아무 객체나 됩니다. 예외를 던지지 않습니다. |
| `init(options?)` | 저장을 시작합니다. 두 번째 호출부터는 콘솔 경고 한 번과 함께 무시합니다. |
| `setContext(partial)` | 내보내는 줄마다 붙는 전역 context에 얕게 병합합니다. `undefined`는 키를 지웁니다. |
| `flush(timeoutMs?)` | 큐의 기록이 디스크에 쓰이면 `true`, 시간 초과(기본 5초)나 쓰기 실패면 `false`로 resolve합니다. reject하지 않습니다. |
| `close()` | 큐에 있는 것을 쓰고, 현재 파일을 닫고, 멈춥니다. 이후 `log()` 호출은 버립니다. |
| `subscribe(fn)` | 쓸 때마다 `fn(records)`를 호출합니다. 디버그 패널과 테스트용입니다. 구독 해제 함수를 돌려줍니다. |
| `exportLogs({ from?, to? })` | 저장된 로그를 시간순 JSON Lines `Blob` 하나로 돌려줍니다. |
| `OpfslogdError` | `onError`로 전달되는 에러 클래스입니다. `code`가 있습니다. |

### 에러 기록

에러는 `ctx.err`로, 또는 `ctx` 자체로 넘깁니다. `name`, `message`, `stack`, `cause` 사슬(5단계), 자기 속성(`status` 등)이 저장됩니다:

```ts
logger.error('upload failed', { err: e, fileId })
logger.error('upload failed', e)
```

`ctx` 안쪽 더 깊이 들어 있는 `Error`는 `{}`로 저장됩니다.

### 옵션

```ts
init({
  namespace: 'default',            // "한 도메인에 앱이 여러 개일 때" 참고
  context: { version: '2.3.1' },   // 전역 context
  rotate: { maxAgeMs: 300_000 },   // 5분 뒤 현재 파일을 닫음
  retention: {
    maxBytes: 50_000_000,          // 기기에 최대 50MB까지
    maxAgeMs: 7 * 86_400_000,      // 7일보다 오래된 것은 지움
  },
  upload: { send, intervalMs: 60_000, timeoutMs: 60_000 },
  onError(err) { Sentry.captureException(err) },
  workerUrl,                       // 번들러가 worker.js를 못 찾을 때만
})
```

`onError`가 없으면 에러 코드마다 한 번 `console.error`로 출력합니다. 코드: `opfs-unavailable`, `worker-load-failed`, `quota-exceeded`, `write-failed`, `worker-unresponsive`, `unreadable-file`, `invalid-option`. 저장을 시작할 수 없으면 로거는 멈추고 비용이 들지 않습니다.

## 내보내는 형식

export와 업로드는 [JSON Lines](https://jsonlines.org/)이고, 한 줄에 기록 하나입니다:

```json
{"ts":1793251200123,"lv":"info","msg":"clicked","ctx":{"id":7},"tab":"k3f9x2ab","seq":42,"context":{"version":"2.3.1"}}
```

| 필드 | 뜻 |
|---|---|
| `ts` | `log()`를 호출한 때의 `Date.now()` |
| `lv` | `debug`, `info`, `warn`, `error` |
| `msg`, `ctx`, `err` | 기록한 내용 |
| `tab` | 탭의 무작위 ID |
| `seq` | 탭 안의 순서. 한 탭의 줄을 정렬할 때는 `ts`가 아니라 이것을 쓰세요. 시계는 뒤로 갈 수 있습니다. |
| `context` | 전역 context. 비어 있으면 없습니다. |

### 버려진 기록

기기가 따라가지 못하거나 저장 공간이 차면 기록을 버립니다. 그 사실은 한 줄로 남습니다:

```json
{"ts":…,"lv":"warn","msg":"opfslogd: records dropped","ctx":{"reason":"overload","dropped":{"debug":1200,"info":300},"from":…,"to":…}}
```

`msg`와 `ctx.reason`은 바뀌지 않는 계약입니다. 사유: `overload`, `quota`, `write-failed`, `retention`(위 제한 때문에 업로드 전에 지워진 파일. 이때는 `dropped` 대신 `segments`와 `bytes`가 있습니다). `from`과 `to`는 빠진 시간 범위입니다.

## 업로드

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

- 로그는 최대 약 2MB 파일에 쓰이고, 5분이 지나거나 차면 닫힙니다. 닫힌 파일은 `intervalMs`마다 오래된 것부터 하나씩 업로드하고, 첫 업로드는 페이지가 로드된 직후입니다.
- 백엔드가 파일을 받으면 resolve하세요. reject하면 다음 실행에서 다시 시도합니다. 한 번의 실행은 첫 실패에서 멈춥니다.
- `meta`: `segmentId`, `sha256`(`file`의 hex), `size`, `from`, `to`, `signal`. signal은 `timeoutMs` 뒤 abort됩니다.
- 전달은 **at least once**입니다. `segmentId`로 중복을 거르세요.
- 업로드는 한 번에 한 탭만 합니다.
- `upload`가 설정되지 않은 동안 닫힌 파일은 나중에도 업로드되지 않습니다. 동의 절차에 맞습니다: 사용자가 동의하기 전의 로그는 기기에 남습니다.
- 원하면 압축하세요: `file.stream().pipeThrough(new CompressionStream('gzip'))`.

## 버그 리포트용 export

```ts
import { exportLogs } from 'opfslogd'

const { file, skipped } = await exportLogs({ from: Date.now() - 60 * 60_000 })
const url = URL.createObjectURL(file)
```

export에는 닫힌 파일 전부와 현재 탭이 쓰고 있는 파일이 들어갑니다. 다른 탭이 쓰고 있는 파일(길어야 최근 몇 분)은 빠지고 `skipped.activeOtherTabs`에 셉니다.

## 한 도메인에 앱이 여러 개일 때

OPFS와 Web Locks는 origin 단위입니다. 두 앱이 origin을 같이 쓰고(`user.github.io/app1`과 `/app2`, 한 회사 도메인 아래 여러 앱, 마이크로 프론트엔드) 둘 다 기본 namespace를 쓰면 디렉터리 하나를 같이 씁니다. 그러면 **한 앱의 `send()`가 다른 앱의 로그를 자기 백엔드로 올립니다.** 앱마다 다른 `namespace`(`[a-z0-9_-]`, 최대 64자)를 주세요.

## 알아 둘 것

- **번들러.** Worker는 별도 파일 `worker.js`이고 `new Worker(new URL('./worker.js', import.meta.url))`로 불러옵니다. Vite는 설정 없이 됩니다(dev와 build 확인). 번들러가 처리하지 못하면 패키지의 `worker.js`를 복사하고 그 URL을 `workerUrl`로 넘기세요.
- **CSP.** Worker에는 `worker-src 'self'`(또는 Worker를 내려주는 origin)가 필요합니다. `blob:`이나 `data:` URL은 쓰지 않습니다.
- **서버 사이드 렌더링.** 브라우저 페이지가 아니면(Node, SSR) 모든 함수가 아무것도 하지 않습니다.
- **로그아웃이나 동의 철회.** `close()`를 호출하세요. 기록이 멈추고, 이후 기록은 큐에 쌓이지 않고 버려집니다.
- **레벨 필터 없음.** 최소 레벨 옵션은 없습니다. 호출하는 쪽에서 거르세요(`if (isDev) logger.debug(...)`).
- **저장소 유지.** 저장 공간이 부족하면 브라우저가 OPFS 데이터를 지울 수 있습니다. 필요하면 `navigator.storage.persist()`를 직접 호출하세요.
- **Secure context.** OPFS는 https(또는 `localhost`)가 필요합니다.

## 브라우저 지원

데스크톱의 최신 Chromium 계열, Firefox, Safari: Worker에서 OPFS `createSyncAccessHandle()`, `FileSystemFileHandle.move()`, Web Locks를 지원하는 브라우저. 테스트는 Chromium, Firefox, WebKit에서 돌립니다. Safari 개인 정보 보호 브라우징에서는 OPFS가 막힐 수 있고, 이때 로거는 `opfs-unavailable`을 알리고 아무것도 하지 않습니다.

**모바일 브라우저는 아직 검증하지 않았습니다.** Android Chrome과 iOS Safari에도 위 API가 있지만, 실제 휴대폰에서 테스트하거나 측정하지 않았습니다. 저장 공간 제한, 백그라운드 탭 처리, 속도가 다를 수 있습니다. 실기기 확인은 1.0 전에 할 예정입니다.

## 개발

### Playground

API를 직접 눌러 보는 페이지입니다. 이 저장소를 clone해서 실행합니다:

```sh
pnpm install
pnpm playground
```

`http://localhost:5181/playground/`가 열립니다. 페이지가 `src/`의 소스를 바로 불러오므로 빌드 없이 수정 사항이 새로고침에 반영됩니다. `init()`, `close()`, 네 가지 레벨, 한꺼번에 기록과 계속 기록, `setContext()`, `flush()`, `exportLogs()` 버튼이 있고, resolve·reject·응답 없음을 고를 수 있는 가짜 업로드 `send()`가 있습니다. `subscribe()`로 받은 기록, `onError`의 에러, OPFS의 세그먼트 파일을 보여줍니다. 여러 탭에서 열면 탭 사이 Lock, retention, 업로드를 볼 수 있습니다. `pnpm playground --host`로 LAN에도 띄울 수 있지만, 휴대폰은 https가 아니면 OPFS를 막습니다.

### 더 보기

[CONTRIBUTING.md](CONTRIBUTING.md)를 보세요. 설계 문서는 [docs/design/index.html](docs/design/index.html)에서 시작하고, 전체 요약은 [docs/design/overview.html](docs/design/overview.html), 결정 기록은 [docs/decisions.md](docs/decisions.md)에 있습니다.

## 라이선스

MIT
