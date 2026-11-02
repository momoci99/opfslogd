// Checks that the built package starts its worker in apps built with other bundlers
// (docs/design/benchmark.html#bundlers, docs/decisions.md #009, #084).
// Each case makes a fresh app with opfslogd copied into node_modules, as npm install would
// leave it, builds (or starts a dev server), opens it in Chromium, and reads the record back.
// The bundlers live in this folder's own package.json, not the root devDependencies.
// Run: pnpm build && pnpm check:bundlers [--only=webpack,next]

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const here = import.meta.dirname
const repo = join(here, '..', '..')
const bin = (name) => join(here, 'node_modules', '.bin', name)
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')

if (!existsSync(join(repo, 'dist', 'worker.js'))) {
  console.error('dist/worker.js is missing. Run pnpm build first.')
  process.exit(1)
}
if (!existsSync(join(here, 'node_modules'))) {
  console.log('Installing the bundlers into test/bundler-check/node_modules (once)...')
  execFileSync('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], { cwd: here, stdio: 'inherit' })
}

const versions = JSON.parse(await readFile(join(here, 'package.json'), 'utf8')).devDependencies

// Apps go in .apps/ inside this folder, so they resolve react and next from node_modules here.
async function makeApp(name) {
  const root = join(here, '.apps', name)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const pkg = join(root, 'node_modules', 'opfslogd')
  await cp(join(repo, 'dist'), join(pkg, 'dist'), { recursive: true })
  await cp(join(repo, 'package.json'), join(pkg, 'package.json'))
  await cp(join(here, 'app', 'main.js'), join(root, 'main.js'))
  await cp(join(here, 'app', 'entry.js'), join(root, 'entry.js'))
  return root
}

const html = (script) => `<!doctype html>\n<meta charset="utf-8">\n<title>bundler check</title>\n${script}\n`

// Only worker.js, nothing next to it: it must work alone (#081).
const copyWorker = (dir) => cp(join(repo, 'dist', 'worker.js'), join(dir, 'copied', 'worker.js'))

const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env }, encoding: 'utf8', stdio: 'pipe' })

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain' }
function serveStatic(dir) {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (path.endsWith('/')) path += 'index.html'
    for (const p of [path, `${path}.html`]) {
      try {
        const body = await readFile(join(dir, p))
        return res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(body)
      } catch {}
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://localhost:${server.address().port}/`, close: () => server.close() })),
  )
}

// next dev: start it and wait until the page answers
async function startNextDev(root, flags) {
  const port = 5190 + Math.floor(Math.random() * 100)
  const child = spawn(process.execPath, [join(here, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', ...flags, '--port', String(port)], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'pipe',
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const url = `http://localhost:${port}/`
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if ((await fetch(url)).ok) return { url, close: () => child.kill() }
    } catch {}
  }
  child.kill()
  throw new Error(`next dev did not start:\n${log.slice(-2000)}`)
}

async function nextApp(name, config) {
  const root = await makeApp(name)
  await cp(join(here, 'next-app'), root, { recursive: true })
  // root: this folder holds node_modules with next; without it Next guesses from lockfiles
  await writeFile(
    join(root, 'next.config.mjs'),
    `export default ${JSON.stringify({ outputFileTracingRoot: here, turbopack: { root: here }, ...config })}\n`,
  )
  return root
}

const cases = {
  async 'webpack'() {
    const root = await makeApp('webpack')
    const { default: webpack } = await import(join(here, 'node_modules', 'webpack', 'lib', 'index.js'))
    const out = join(root, 'out')
    const stats = await new Promise((resolve, reject) =>
      webpack({ mode: 'production', context: root, entry: './entry.js', output: { path: out }, devtool: false }, (err, s) =>
        err ? reject(err) : resolve(s),
      ),
    )
    if (stats.hasErrors()) throw new Error(stats.toString('errors-only'))
    await writeFile(join(out, 'index.html'), html('<script src="main.js"></script>'))
    return serveStatic(out)
  },
  async 'rollup'() {
    const root = await makeApp('rollup')
    const { rollup } = await import(join(here, 'node_modules', 'rollup', 'dist', 'es', 'rollup.js'))
    const { nodeResolve } = await import(join(here, 'node_modules', '@rollup', 'plugin-node-resolve', 'dist', 'es', 'index.js'))
    const out = join(root, 'out')
    const bundle = await rollup({ input: join(root, 'entry.js'), plugins: [nodeResolve({ browser: true })], logLevel: 'silent' })
    await bundle.write({ dir: out, format: 'es' })
    await writeFile(join(out, 'index.html'), html('<script type="module" src="entry.js"></script>'))
    await copyWorker(out)
    return serveStatic(out)
  },
  async 'esbuild'() {
    const root = await makeApp('esbuild')
    const esbuild = await import(join(here, 'node_modules', 'esbuild', 'lib', 'main.js'))
    const out = join(root, 'out')
    await esbuild.build({ entryPoints: [join(root, 'entry.js')], bundle: true, format: 'esm', outdir: out, logLevel: 'silent' })
    await writeFile(join(out, 'index.html'), html('<script type="module" src="entry.js"></script>'))
    await copyWorker(out)
    return serveStatic(out)
  },
  async 'parcel'() {
    const root = await makeApp('parcel')
    await writeFile(join(root, 'index.html'), html('<script type="module" src="./entry.js"></script>'))
    const out = join(root, 'out')
    run(bin('parcel'), ['build', 'index.html', '--dist-dir', out, '--cache-dir', join(root, '.parcel-cache'), '--no-source-maps'], root)
    return serveStatic(out)
  },
  async 'next build (Turbopack)'() {
    const root = await nextApp('next-turbopack', { output: 'export' })
    run(bin('next'), ['build'], root)
    return serveStatic(join(root, 'out'))
  },
  async 'next build --webpack'() {
    const root = await nextApp('next-webpack', { output: 'export' })
    run(bin('next'), ['build', '--webpack'], root)
    return serveStatic(join(root, 'out'))
  },
  async 'next dev (Turbopack)'() {
    return startNextDev(await nextApp('next-dev-turbopack', {}), [])
  },
  async 'next dev --webpack'() {
    return startNextDev(await nextApp('next-dev-webpack', {}), ['--webpack'])
  },
}
// rollup and esbuild do not emit worker.js (#009); they also run with ?workerUrl= to a copied worker.js
const withWorkerUrl = new Set(['rollup', 'esbuild'])

async function check(browser, url) {
  const page = await browser.newPage()
  const errors = []
  const workers = []
  page.on('worker', (w) => workers.push(w.url()))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`))
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForFunction(() => window.__result, undefined, { timeout: 60_000 })
  const result = await page.evaluate(() => window.__result)
  await page.close()
  return { ...result, errors, workers }
}

console.log(Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(' · '))
const browser = await chromium.launch()
try {
  for (const [name, make] of Object.entries(cases)) {
    if (only && !only.some((o) => name.startsWith(o))) continue
    let server
    try {
      server = await make()
      const urls = [['', server.url]]
      if (withWorkerUrl.has(name)) urls.push([', workerUrl to a copied worker.js', `${server.url}?workerUrl=/copied/worker.js`])
      for (const [suffix, url] of urls) {
        const r = await check(browser, url)
        const worker = r.workers.map((w) => w.replace(server.url, '/').slice(0, 70)).join(' ')
        // without workerUrl, rollup and esbuild leave new URL('./worker.js') pointing at a file they did not emit
        const expected = !suffix && withWorkerUrl.has(name) && r.error === 'worker-load-failed'
        const status = r.ok ? 'worker ok, OPFS ok' : expected ? 'worker.js not emitted: expected, use workerUrl (#009)' : `FAILED: ${r.error}`
        console.log(`${name}${suffix}\t${status}\t${worker && `worker at ${worker}`}`)
        if (!expected) for (const e of r.errors) console.log(`\t${e}`)
      }
    } catch (e) {
      console.log(`${name}\terror: ${String(e.stderr || e.message).split('\n').slice(0, 15).join('\n\t')}`)
    } finally {
      server?.close()
    }
  }
} finally {
  await browser.close()
}
