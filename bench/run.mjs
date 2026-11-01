// Runs bench/index.html in desktop engines and prints the medians side by side.
//   pnpm bench          Chromium, Firefox, WebKit, and Chromium with 4x CPU throttling
//   pnpm bench:serve    serve the page on the LAN to open it on a phone

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'

// Use the Vite that Vitest already depends on, so this adds no dependency.
const require = createRequire(import.meta.url)
const vitestDir = join(require.resolve('vitest/package.json'), '..')
const vite = await import(pathToFileURL(createRequire(join(vitestDir, 'x.js')).resolve('vite')).href)

const serveOnly = process.argv.includes('--serve')
const server = await vite.createServer({
  root: import.meta.dirname,
  configFile: false,
  logLevel: serveOnly ? 'info' : 'silent',
  server: { port: serveOnly ? 5180 : 0, host: serveOnly ? true : '127.0.0.1' },
})
await server.listen()

if (serveOnly) {
  server.printUrls()
  console.log('Open the Network URL on the phone. Ctrl+C to stop.')
} else {
  const url = server.resolvedUrls.local[0]
  const runs = [
    { label: 'chromium', type: chromium },
    { label: 'firefox', type: firefox },
    { label: 'webkit', type: webkit },
    // Rough stand-in for a low-end phone; real phones are checked by hand.
    { label: 'chromium 4x slow', type: chromium, throttle: 4 },
  ]
  const table = new Map()
  const versions = []
  try {
    for (const run of runs) {
      const browser = await run.type.launch()
      versions.push(`${run.label} ${browser.version()}`)
      const page = await browser.newPage()
      if (run.throttle) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: run.throttle })
      }
      await page.goto(url)
      const rows = await page.evaluate(() => window.__results, undefined, { timeout: 0 })
      for (const row of rows) {
        const key = `${row.group}\t${row.name}`
        if (!table.has(key)) table.set(key, { note: row.note ?? '', values: {} })
        table.get(key).values[run.label] = row.medianUs
      }
      await browser.close()
      process.stderr.write(`done: ${run.label}\n`)
    }
  } finally {
    await server.close()
  }

  const fmt = (us) => (us === undefined ? '-' : us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : us >= 10 ? `${us.toFixed(1)} µs` : `${us.toFixed(3)} µs`)
  console.log(versions.join(' · '))
  console.log(['group', 'case', ...runs.map((r) => r.label), 'note'].join('\t'))
  for (const [key, { note, values }] of table) {
    console.log([key, ...runs.map((r) => fmt(values[r.label])), note].join('\t'))
  }
}
