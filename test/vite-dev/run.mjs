// Checks whether a package that starts its worker with
// `new Worker(new URL('./worker.js', import.meta.url))` (#009) works in a Vite app
// that installed it from npm (docs/design/benchmark.html).
// Run: pnpm build && pnpm check:vite

import { existsSync } from 'node:fs'
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

const repo = join(here, '..', '..')

// A fresh app per case, with the package copied (not linked) into node_modules,
// as an npm install would leave it. Vite pre-bundles only real dependencies.
// 'fake': the step-6 stand-in package. 'real': the built opfslogd (package.json + dist/).
async function makeApp(pkg, copyWorker) {
  const root = await mkdtemp(join(tmpdir(), 'opfslogd-vite-'))
  if (pkg === 'fake') {
    await cp(join(here, 'app'), root, { recursive: true })
    await cp(join(here, 'fake-pkg'), join(root, 'node_modules', 'fake-opfslogd'), { recursive: true })
  } else {
    await cp(join(here, 'real-app'), root, { recursive: true })
    const dest = join(root, 'node_modules', 'opfslogd')
    await cp(join(repo, 'dist'), join(dest, 'dist'), { recursive: true })
    await cp(join(repo, 'package.json'), join(dest, 'package.json'))
  }
  // Only worker.js, nothing next to it: it must work alone (#081).
  if (copyWorker) await cp(join(repo, 'dist', 'worker.js'), join(root, 'public', 'copied', 'worker.js'))
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

if (!existsSync(join(repo, 'dist', 'worker.js'))) {
  console.error('dist/worker.js is missing. Run pnpm build first.')
  process.exit(1)
}

const cases = [
  { name: 'fake pkg: dev, no config', pkg: 'fake', mode: 'dev', config: {} },
  { name: 'fake pkg: dev, optimizeDeps.exclude', pkg: 'fake', mode: 'dev', config: { optimizeDeps: { exclude: ['fake-opfslogd'] } } },
  { name: 'fake pkg: build + preview', pkg: 'fake', mode: 'build', config: {} },
  { name: 'opfslogd dist: dev, no config', pkg: 'real', mode: 'dev', config: {} },
  { name: 'opfslogd dist: build + preview', pkg: 'real', mode: 'build', config: {} },
  { name: 'opfslogd dist: build, workerUrl to a copied worker.js', pkg: 'real', mode: 'build', config: {}, copyWorker: true },
]

const browser = await chromium.launch()
try {
  for (const c of cases) {
    const root = await makeApp(c.pkg, c.copyWorker)
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
      const r = await openInBrowser(browser, c.copyWorker ? `${url}?workerUrl=/copied/worker.js` : url)
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
