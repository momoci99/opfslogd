// Checks whether a page enters bfcache while its worker holds an OPFS sync access
// handle, or while it holds a Web Lock (docs/design/benchmark.html).
// Run: pnpm check:bfcache  (opens a Chromium window)
//
// Chromium only, headed. Under Playwright, headless Chromium, Firefox, and WebKit
// never restore even an empty page from bfcache, so they are checked by hand.

import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { chromium } from 'playwright'

const dir = import.meta.dirname
const types = { '.html': 'text/html', '.js': 'text/javascript' }

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try {
    const body = await readFile(join(dir, path))
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/plain' })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://localhost:${server.address().port}`

// empty: control. If it is not restored, bfcache is off in this setup and the
// other rows say nothing.
const cases = ['empty', 'worker', 'sah', 'lock']

async function check(context, kase) {
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/a.html?case=${kase}`)
    const setup = await page.evaluate(() => window.__ready)
    if (setup !== 'ok') return { kase, result: setup }

    await page.goto(`${origin}/b.html`)
    await page.waitForTimeout(300)
    // A page restored from bfcache fires no load event, so wait for commit only.
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForTimeout(500)

    const restored = await page.evaluate(() => window.__restored)
    const row = { kase, result: restored ? 'restored' : 'not restored' }
    if (restored && kase === 'sah') {
      const res = await page.evaluate(() => window.__call({ op: 'write' }))
      row.writeAfterBack = res.ok ? `ok (file size ${res.size})` : res.error
    }
    if (!restored) {
      // Why the page was not restored.
      row.reasons = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        const r = nav?.notRestoredReasons
        if (!r) return undefined
        const collect = (n) => [...(n.reasons ?? []).map((x) => x.reason), ...(n.children ?? []).flatMap(collect)]
        return collect(r).join(', ') || undefined
      })
    }
    return row
  } finally {
    await page.close()
  }
}

try {
  // Persistent context, like the tests: a throwaway context may change storage behavior.
  const profile = await mkdtemp(join(tmpdir(), 'opfslogd-bfcache-'))
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    // Playwright turns bfcache off in Chromium by default.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  })
  const version = context.browser()?.version() ?? ''
  for (const kase of cases) {
    const row = await check(context, kase)
    const extra = [row.writeAfterBack && `write after back: ${row.writeAfterBack}`, row.reasons && `reasons: ${row.reasons}`]
      .filter(Boolean)
      .join('; ')
    console.log(`chromium ${version}\t${kase}\t${row.result}${extra ? `\t${extra}` : ''}`)
  }
  await context.close()
  await rm(profile, { recursive: true, force: true })
} finally {
  server.close()
}
