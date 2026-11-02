// Runs bench/index.html in desktop engines and prints the medians side by side.
//   pnpm bench              Chromium, Firefox, WebKit, and Chromium with 4x CPU throttling
//   pnpm bench --android    Chrome and Samsung Internet on a phone over USB (adb)
//   pnpm bench:serve        serve the page on the LAN to open it by hand

import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'

// Use the Vite that Vitest already depends on, so this adds no dependency.
const require = createRequire(import.meta.url)
const vitestDir = join(require.resolve('vitest/package.json'), '..')
const vite = await import(pathToFileURL(createRequire(join(vitestDir, 'x.js')).resolve('vite')).href)

const serveOnly = process.argv.includes('--serve')
const android = process.argv.includes('--android')
const ANDROID_PORT = 5180 // fixed: the phone reaches it through adb reverse
const server = await vite.createServer({
  root: import.meta.dirname,
  configFile: false,
  logLevel: serveOnly ? 'info' : 'silent',
  server: { port: serveOnly || android ? ANDROID_PORT : 0, strictPort: android, host: serveOnly ? true : '127.0.0.1' },
})
await server.listen()

if (serveOnly) {
  server.printUrls()
  // http on a LAN address is not a secure context: no OPFS, so cases 7, 8, and 10 fail there.
  console.log('On a phone, OPFS needs https or localhost; for Android use pnpm bench --android. Ctrl+C to stop.')
} else {
  const url = server.resolvedUrls.local[0]
  // --only=webkit runs one setup (for debugging).
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
  let runs = [
    { label: 'chromium', type: chromium },
    { label: 'firefox', type: firefox },
    { label: 'webkit', type: webkit },
    // Rough stand-in for a low-end phone; real phones: --android
    { label: 'chromium 4x slow', type: chromium, throttle: 4 },
  ]
  let phone
  if (android) {
    phone = await import('../test/android-check/adb.mjs')
    try {
      runs = phone.setUp([ANDROID_PORT]).map((b) => ({ label: b.label, android: b }))
    } catch (e) {
      console.error(e.message)
      await server.close()
      process.exit(1)
    }
  }
  runs = runs.filter((r) => !only || r.label === only)
  const table = new Map()
  const versions = []
  try {
    for (const run of runs) {
      if (run.android) {
        // The page runs on load; the browser stays in front until the results are read.
        const pageUrl = `http://localhost:${ANDROID_PORT}/?run=${Date.now()}`
        const { browser, page } = await phone.openTab(run.android, pageUrl)
        page.on('console', (m) => process.stderr.write(`  [${run.label}] ${m.text()}\n`))
        page.on('pageerror', (e) => process.stderr.write(`  [${run.label}] page error: ${e.message}\n`))
        versions.push(`${run.label} ${await phone.version(run.android)}`)
        const rows = await page.evaluate(() => window.__results, undefined, { timeout: 0 })
        for (const row of rows) {
          const key = `${row.group}\t${row.name}`
          if (!table.has(key)) table.set(key, { notes: {}, values: {} })
          table.get(key).values[run.label] = row.medianUs
          table.get(key).notes[run.label] = row.note ?? ''
        }
        await phone.closeTab(run.android, page)
        await browser.close()
        process.stderr.write(`done: ${run.label}\n`)
        continue
      }
      // WebKit blocks OPFS in a throwaway context (benchmark.html), so it gets a profile.
      const profile = run.label === 'webkit' ? await mkdtemp(join(tmpdir(), 'opfslogd-bench-')) : undefined
      const launched = profile ? undefined : await run.type.launch()
      const context = profile ? await run.type.launchPersistentContext(profile) : await launched.newContext()
      versions.push(`${run.label} ${launched?.version() ?? run.type.name()}`)
      const page = context.pages()[0] ?? (await context.newPage())
      page.on('console', (m) => process.stderr.write(`  [${run.label}] ${m.text()}\n`))
      page.on('pageerror', (e) => process.stderr.write(`  [${run.label}] page error: ${e.message}\n`))
      if (run.throttle) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: run.throttle })
      }
      await page.goto(url)
      const rows = await page.evaluate(() => window.__results, undefined, { timeout: 0 })
      for (const row of rows) {
        const key = `${row.group}\t${row.name}`
        if (!table.has(key)) table.set(key, { notes: {}, values: {} })
        table.get(key).values[run.label] = row.medianUs
        table.get(key).notes[run.label] = row.note ?? ''
      }
      await context.close()
      await launched?.close()
      if (profile) await rm(profile, { recursive: true, force: true })
      process.stderr.write(`done: ${run.label}\n`)
    }
  } finally {
    phone?.tearDown()
    await server.close()
  }

  const fmt = (us) => (us === undefined ? '-' : us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : us >= 10 ? `${us.toFixed(1)} µs` : `${us.toFixed(3)} µs`)
  console.log(versions.join(' · '))
  console.log(['group', 'case', ...runs.map((r) => r.label), 'note'].join('\t'))
  for (const [key, { notes, values }] of table) {
    // one note when every engine agrees, else one per engine
    const distinct = [...new Set(Object.values(notes))]
    const note = distinct.length <= 1 ? (distinct[0] ?? '') : runs.map((r) => `${r.label}: ${notes[r.label] ?? '-'}`).join(' | ')
    console.log([key, ...runs.map((r) => fmt(values[r.label])), note].join('\t'))
  }
}
