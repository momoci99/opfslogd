// Checks two storage behaviors that need a real browser process (docs/design/benchmark.html#impl):
//   1. #074: writes acked by the worker, with no handle.flush(), survive killing the browser.
//   2. #064: whether a write that hits the quota leaves part of its data in the file,
//      and that the library rolls it back. Chromium (CDP quota override) and Firefox (pref).
// Run: pnpm build && pnpm check:storage

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'

const repo = join(import.meta.dirname, '..', '..')
// --only=3,4 runs some sections
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const runs = (n) => !only || only.includes(String(n))
if (!existsSync(join(repo, 'dist', 'worker.js'))) {
  console.error('dist/worker.js is missing. Run pnpm build first.')
  process.exit(1)
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' }
const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname)
  if (!path.startsWith('/dist/') && !path.startsWith('/test/storage-check/')) return res.writeHead(404).end()
  try {
    const body = await readFile(join(repo, path))
    // Cross-origin isolation for every response: measureUserAgentSpecificMemory() needs it,
    // and the worker script must carry the same COEP as its page.
    res.writeHead(200, {
      'content-type': types[extname(path)] ?? 'text/plain',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://localhost:${server.address().port}`
const pageUrl = (mode, extra = '') => `${origin}/test/storage-check/page.html?mode=${mode}${extra}`

async function result(page, mode, extra) {
  await page.goto(pageUrl(mode, extra))
  return page.evaluate(() => window.__result, undefined, { timeout: 0 })
}

const engines = [
  { name: 'chromium', type: chromium },
  { name: 'firefox', type: firefox },
  { name: 'webkit', type: webkit },
]

// 1. Kill the whole browser with SIGKILL right after the last ack, then read the files back.
const BATCHES = 40
console.log(`\n# 1. acked writes after SIGKILL (#074): ${BATCHES} batches of 1,300 lines`)
for (const { name, type } of runs(1) ? engines : []) {
  const profile = await mkdtemp(join(tmpdir(), `opfslogd-check-${name}-`))
  try {
    let context = await type.launchPersistentContext(profile)
    let page = context.pages()[0] ?? (await context.newPage())
    const wrote = await result(page, 'write', `&batches=${BATCHES}`)
    if (wrote.error) throw new Error(JSON.stringify(wrote.error))
    const closed = new Promise((r) => context.once('close', r))
    try {
      execFileSync('pkill', ['-9', '-f', profile])
    } catch {
      // pkill exits 1 when nothing matched
    }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))])

    context = await type.launchPersistentContext(profile)
    page = context.pages()[0] ?? (await context.newPage())
    const read = await result(page, 'read')
    await context.close()
    const kept = read.lines === wrote.acked && read.badTail === 0
    console.log(`${name}\tacked ${wrote.acked} lines (${wrote.bytes} B)\ton disk ${read.lines} lines (${read.bytes} B), partial tail files ${read.badTail}\t${kept ? 'KEPT' : 'LOST'}`)
  } catch (e) {
    console.log(`${name}\terror: ${e.message}`)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

// 2. Quota. Chromium: CDP override. Firefox: fixed storage limit pref.
// WebKit has no way to lower the quota from Playwright; it stays on the device list.
console.log('\n# 2. writes that hit the quota (#064)')
const QUOTA = 8 * 1024 * 1024
for (const { name, type } of runs(2) ? engines.slice(0, 2) : []) {
  for (const mode of ['raw-quota', 'lib-quota']) {
    const browser = await type.launch(
      name === 'firefox'
        ? { firefoxUserPrefs: { 'dom.quotaManager.temporaryStorage.fixedLimit': 50 * 1024 } } // KB
        : {},
    )
    try {
      const page = await browser.newPage()
      if (name === 'chromium') {
        const cdp = await page.context().newCDPSession(page)
        await page.goto(`${origin}/test/storage-check/page.html`)
        await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: QUOTA })
      }
      console.log(`${name}\t${mode}\t${JSON.stringify(await result(page, mode))}`)
    } catch (e) {
      console.log(`${name}\t${mode}\terror: ${e.message}`)
    } finally {
      await browser.close()
    }
  }
}

// 3. pagehide (#020): log 5,000 records/s, leave the page at a random moment, count what reached disk.
//    'navigate' goes to another page; 'close' closes the tab.
const libUrl = (mode, ns) => `${origin}/test/storage-check/lib-page.html?mode=${mode}&ns=${ns}`
console.log('\n# 3. records on disk after leaving the page (#020): 5 runs each, 5,000 records/s')
for (const { name, type } of runs(3) ? engines : []) {
  const profile = await mkdtemp(join(tmpdir(), `opfslogd-check-${name}-`))
  const context = await type.launchPersistentContext(profile)
  try {
    for (const how of ['navigate', 'close']) {
      const results = []
      let forced = 0
      for (let run = 0; run < 5; run++) {
        const ns = `pagehide-${how}-${run}`
        const page = await context.newPage()
        await page.goto(libUrl('log', ns))
        await page.evaluate(() => window.__result)
        await page.waitForTimeout(500 + Math.random() * 500)
        if (how === 'navigate') await page.goto(`${origin}/test/storage-check/page.html`)
        else {
          // With runBeforeUnload, close() does not wait for the page to go away, and in
          // WebKit under Playwright it never goes away; force a plain close after 5s.
          const gone = new Promise((r) => page.once('close', () => r(true)))
          await page.close({ runBeforeUnload: true })
          if (!(await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 5000))]))) {
            forced++
            await page.close()
          }
        }
        const reader = how === 'navigate' ? page : await context.newPage()
        await reader.waitForTimeout(300) // let the old worker finish
        await reader.goto(libUrl('count', ns))
        results.push(await reader.evaluate(() => window.__result))
        await reader.close()
      }
      const lost = results.map((r) => r.lost ?? r.error)
      const logged = results.map((r) => r.logged)
      const note = forced ? `\t(${forced} forced: closed without pagehide)` : ''
      console.log(`${name}\t${how}\tlogged ${logged.join(', ')}\tlost ${lost.join(', ')}${note}`)
    }
  } catch (e) {
    console.log(`${name}	error: ${e.message}`)
  } finally {
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
}

// 4. Worker memory: Chromium only (measureUserAgentSpecificMemory needs cross-origin isolation).
console.log('\n# 4. worker memory (Chromium)')
if (runs(4)) {
  // The headless shell lacks measureUserAgentSpecificMemory(); full Chromium has it.
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] })
  try {
    const page = await browser.newPage()
    await page.goto(libUrl('memory', 'memory'))
    console.log(JSON.stringify(await page.evaluate(() => window.__result, undefined, { timeout: 0 })))
  } finally {
    await browser.close()
  }
}

server.close()
