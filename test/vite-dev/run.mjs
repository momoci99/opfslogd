// Checks whether a package that starts its worker with
// `new Worker(new URL('./worker.js', import.meta.url))` (#009) works in a Vite app
// that installed it from npm (docs/design/benchmark.html).
// Run: pnpm check:vite

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

// Use the Vite that Vitest already depends on, so this check adds no dependency.
const require = createRequire(import.meta.url)
const vitestDir = join(require.resolve('vitest/package.json'), '..')
const vite = await import(pathToFileURL(createRequire(join(vitestDir, 'x.js')).resolve('vite')).href)

const here = import.meta.dirname

// A fresh app per case, with the package copied (not linked) into node_modules,
// as an npm install would leave it. Vite pre-bundles only real dependencies.
async function makeApp() {
  const root = await mkdtemp(join(tmpdir(), 'opfslogd-vite-'))
  await cp(join(here, 'app'), root, { recursive: true })
  await cp(join(here, 'fake-pkg'), join(root, 'node_modules', 'fake-opfslogd'), { recursive: true })
  return root
}

async function openInBrowser(browser, url) {
  const page = await browser.newPage()
  const errors = []
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()))
  page.on('requestfailed', (req) => errors.push(`request failed: ${req.url()}`))
  page.on('response', (res) => res.status() >= 400 && errors.push(`${res.status()} ${res.url()}`))
  await page.goto(url)
  const result = await page.evaluate(() => window.__result)
  await page.close()
  return { ...result, errors }
}

const cases = [
  { name: 'dev, no config', mode: 'dev', config: {} },
  { name: 'dev, optimizeDeps.exclude', mode: 'dev', config: { optimizeDeps: { exclude: ['fake-opfslogd'] } } },
  { name: 'build + preview', mode: 'build', config: {} },
]

const browser = await chromium.launch()
try {
  for (const c of cases) {
    const root = await makeApp()
    const base = { root, configFile: false, logLevel: 'silent', ...c.config }
    let server
    try {
      if (c.mode === 'dev') {
        server = await vite.createServer({ ...base, server: { port: 0, host: '127.0.0.1' } })
        await server.listen()
      } else {
        await vite.build(base)
        server = await vite.preview({ ...base, preview: { port: 0, host: '127.0.0.1' } })
      }
      const url = server.resolvedUrls.local[0]
      const r = await openInBrowser(browser, url)
      const where = r.location ? `worker at ${r.location.replace(url, '/').slice(0, 80)}` : ''
      console.log(`${c.name}\t${r.ok ? 'worker ok, OPFS ok' : `FAILED: ${r.error ?? `OPFS ${r.opfs}`}`}\t${where}`)
      for (const e of r.errors) console.log(`\t${e}`)
    } finally {
      await (server?.close?.() ?? server?.httpServer?.close())
      await rm(root, { recursive: true, force: true })
    }
  }
} finally {
  await browser.close()
}
