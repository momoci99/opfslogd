// Checks that browser APIs behave as the design assumes (#058).

import { afterEach, describe, expect, it } from 'vitest'
import { server } from 'vitest/browser'
import { type OpfsWorker, WorkerError, removeRoot, startOpfsWorker, uniqueRoot } from './opfs-worker-client'

let root: string
const workers: OpfsWorker[] = []

function worker(): OpfsWorker {
  const w = startOpfsWorker()
  workers.push(w)
  return w
}

afterEach(async () => {
  for (const w of workers.splice(0)) w.terminate()
  await removeRoot(root)
})

describe('FileSystemFileHandle.move() inside OPFS', () => {
  // Segments go active/ -> pending/ -> done/ by move() (#012). The design depends on this.
  it('moves a closed segment to another directory, keeping its contents', async () => {
    root = uniqueRoot()
    const w = worker()
    const name = 'segment.jsonl'

    await w.call({ op: 'openAndWrite', dir: [root, 'active'], name, text: 'line 1\n' })
    await w.call({ op: 'close' })
    await w.call({ op: 'move', fromDir: [root, 'active'], toDir: [root, 'pending'], name })

    expect(await w.call({ op: 'read', dir: [root, 'pending'], name })).toBe('line 1\n')
    expect(await w.call({ op: 'exists', dir: [root, 'active'], name })).toBe(false)
  })
})

describe('getFile() on a file another worker holds a sync access handle on', () => {
  // #054 holds either way; this records which case each engine is in.
  it('records whether the read succeeds', async ({ annotate }) => {
    root = uniqueRoot()
    const writer = worker()
    const reader = worker()
    const name = 'segment.jsonl'

    await writer.call({ op: 'openAndWrite', dir: [root, 'active'], name, text: 'line 1\n' })

    let result: string
    try {
      const text = await reader.call({ op: 'read', dir: [root, 'active'], name })
      result = `read ok, contents ${JSON.stringify(text)}`
    } catch (e) {
      if (!(e instanceof WorkerError)) throw e
      result = `read failed: ${e.name}: ${e.message}`
    }
    await annotate(`${server.browser}: ${result}`)
    console.log(`[getFile while locked] ${server.browser}: ${result}`)
  })
})
