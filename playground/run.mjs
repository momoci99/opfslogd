// Serves the playground with Vite from the repo root, so it loads src/ directly (no build).
//   pnpm playground          http://localhost:5181/playground/ (opens a browser)
//   pnpm playground --host   also on the LAN; phones need https or localhost for OPFS

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Use the Vite that Vitest already depends on, so this adds no dependency.
const require = createRequire(import.meta.url)
const vitestDir = join(require.resolve('vitest/package.json'), '..')
const vite = await import(pathToFileURL(createRequire(join(vitestDir, 'x.js')).resolve('vite')).href)

const host = process.argv.includes('--host')
const server = await vite.createServer({
  root: join(import.meta.dirname, '..'),
  configFile: false,
  optimizeDeps: { entries: ['playground/index.html'] },
  server: { port: 5181, host: host ? true : 'localhost', open: '/playground/' },
})
await server.listen()
server.printUrls()
console.log('Ctrl+C to stop.')
