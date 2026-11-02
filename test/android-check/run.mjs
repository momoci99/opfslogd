// Records lost when an Android phone leaves or kills the page (docs/design/benchmark.html#android).
// The page logs 5,000 records/s (like check:storage section 3); then one of the scenarios below
// ends it, and a new tab counts what reached OPFS.
// Run: pnpm build && pnpm check:android [--browser=chrome,samsung] [--runs=3] [--only=home-kill,...]
// Needs one phone on USB with USB debugging allowed (see adb.mjs).

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { adb, closeTab, closeTabsOn, openTab, pid, setUp, sleep, tearDown, version, withTimeout } from './adb.mjs'

const repo = join(import.meta.dirname, '..', '..')
if (!existsSync(join(repo, 'dist', 'worker.js'))) {
  console.error('dist/worker.js is missing. Run pnpm build first.')
  process.exit(1)
}
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const RUNS = Number(arg('runs') ?? 3)
const pick = arg('browser')?.split(',')
const only = arg('only')?.split(',')

// Server: the built library, the pages, and the counts the page reports.
// The logged count lives here, not in localStorage, because killing the whole app can lose
// localStorage's last writes. /start answers true once per namespace, so a tab the browser
// restores after a kill does not log again.
const PORT = 5183
const ORIGIN = `http://localhost:${PORT}`
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' }
const started = new Set()
const logged = new Map()
const events = new Map()
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const ns = url.searchParams.get('ns') ?? ''
  const json = (o) => res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(o))
  if (url.pathname === '/start') {
    const start = !started.has(ns)
    started.add(ns)
    return json({ start })
  }
  if (url.pathname === '/report') {
    logged.set(ns, Math.max(logged.get(ns) ?? 0, Number(url.searchParams.get('n'))))
    return json({})
  }
  if (url.pathname === '/event') {
    if (!events.has(ns)) events.set(ns, [])
    events.get(ns).push(url.searchParams.get('e'))
    return json({})
  }
  if (url.pathname === '/logged') return json({ logged: logged.get(ns) ?? null, events: events.get(ns) ?? [] })
  const path = normalize(url.pathname)
  if (!path.startsWith('/dist/') && !path.startsWith('/test/android-check/')) return res.writeHead(404).end()
  try {
    const body = await readFile(join(repo, path))
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/plain', 'cache-control': 'no-store' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const pageUrl = (mode, ns) => `${ORIGIN}/test/android-check/page.html?mode=${mode}&ns=${ns}`

async function startLogging(b, ns) {
  const { browser, page } = await openTab(b, pageUrl('log', ns))
  const r = await withTimeout(page.evaluate(() => window.__result), 20000, 'log start')
  if (!r?.started) throw new Error(`log page: ${JSON.stringify(r)}`)
  await sleep(1000 + Math.random() * 1000)
  return { browser, page }
}

async function countOnDisk(b, ns) {
  await sleep(500) // let the old worker finish
  const { browser, page } = await openTab(b, pageUrl('count', ns))
  const r = await withTimeout(page.evaluate(() => window.__result), 30000, 'count')
  await closeTab(b, page)
  await browser.close()
  return r
}

// Kill in the background, as Android does under memory pressure. am kill only kills an app
// that is cached; with the screen off the browser is not, so fall back to force-stop.
async function killBackground(b) {
  adb('shell', 'am', 'kill', b.pkg)
  await sleep(500)
  if (!pid(b)) return ''
  adb('shell', 'am', 'force-stop', b.pkg)
  return 'am kill left it running, used force-stop'
}

// While DevTools is attached, the page stays visible after HOME and its timers keep full speed.
// So every scenario that hides or kills the page detaches first; the page reports its
// lifecycle events to the server instead.
const scenarios = {
  // leave by navigating the tab
  async navigate(b, ns) {
    const { browser, page } = await startLogging(b, ns)
    await page.evaluate(() => { location.href = '/test/android-check/page.html?mode=idle' }).catch(() => {})
    await sleep(500)
    await closeTab(b, page)
    await browser.close()
    return ''
  },
  // close the tab
  async 'close-tab'(b, ns) {
    const { browser, page } = await startLogging(b, ns)
    await closeTab(b, page)
    await browser.close()
    return ''
  },
  // kill the whole app while the page is in front and logging (like a crash)
  async 'force-stop'(b, ns) {
    const { browser } = await startLogging(b, ns)
    await browser.close()
    await sleep(500)
    adb('shell', 'am', 'force-stop', b.pkg)
    return ''
  },
  // HOME, then the app is killed in the background
  async 'home-kill'(b, ns) {
    const { browser } = await startLogging(b, ns)
    await browser.close()
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    await sleep(5000)
    return killBackground(b)
  },
  // the same after 30s in the background, where timers run once a second
  async 'home-30s-kill'(b, ns) {
    const { browser } = await startLogging(b, ns)
    await browser.close()
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    await sleep(30000)
    return killBackground(b)
  },
  // screen off, then kill. Not in the default list: a phone with a screen lock must be
  // unlocked by hand when the screen comes back, within 20s.
  async 'screen-off-kill'(b, ns) {
    const { browser } = await startLogging(b, ns)
    await browser.close()
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
    await sleep(5000)
    const note = await killBackground(b)
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    await sleep(1000)
    return note
  },
}
const defaults = ['navigate', 'close-tab', 'force-stop', 'home-kill', 'home-30s-kill']

let browsers
try {
  browsers = setUp([PORT]).filter((b) => !pick || pick.includes(b.name))
} catch (e) {
  console.error(e.message)
  server.close()
  process.exit(1)
}
try {
  const model = adb('shell', 'getprop', 'ro.product.model')
  const release = adb('shell', 'getprop', 'ro.build.version.release')
  console.log(`# ${model}, Android ${release}, ${RUNS} runs, 5,000 records/s. lost = logged - on disk (logged is reported before each batch, so lost can read up to 50 high)`)
  const stamp = Date.now().toString(36)
  for (const b of browsers) {
    console.log(`## ${b.name}`)
    for (const name of only ?? defaults) {
      if (!scenarios[name]) throw new Error(`unknown scenario: ${name}`)
      for (let run = 0; run < RUNS; run++) {
        const ns = `${b.name}-${name}-${stamp}-${run}`
        try {
          const note = await scenarios[name](b, ns)
          const r = await countOnDisk(b, ns)
          const line = [name, `#${run}`, `logged ${r.logged}`, `on disk ${r.onDisk}`, `lost ${r.lost}`, `gaps ${r.gaps}`, `partial lines ${r.partial}`]
          line.push(`events ${r.events.join(' ')}`)
          if (note) line.push(note)
          console.log(line.join('\t'))
        } catch (e) {
          console.log(`${name}\t#${run}\terror: ${e.message}`)
        }
      }
    }
    // the browser is in front again here, so it answers; then close tabs it restored after a kill
    await openTab(b, pageUrl('idle', 'cleanup')).then(({ browser }) => browser.close()).catch(() => {})
    console.log(`## ${b.name} version: ${await version(b)}`)
    await closeTabsOn(b, ORIGIN)
  }
} finally {
  tearDown()
  server.close()
}
process.exit(0)
