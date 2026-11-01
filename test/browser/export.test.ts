// exportLogs() through the public API, against real OPFS and workers (step 8, unit 9).

import { afterEach, describe, expect, it } from 'vitest'
import { close, exportLogs, flush, init, logger, setContext } from '../../src/index'
import { activeName, closedName } from '../../src/names'
import { serializeRecord } from '../../src/record'
import { headerLine } from '../../src/segment'

const workerUrl = new URL('../../src/worker.ts', import.meta.url)
let ns = ''

afterEach(async () => {
  await close()
  const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('opfslogd', { create: true })
  await top.removeEntry(ns, { recursive: true }).catch(() => {})
})

function start(context?: Record<string, unknown>): void {
  ns = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  init({ namespace: ns, workerUrl, context })
}

/** Writes a segment file as another tab would have left it. */
async function put(state: 'active' | 'pending' | 'done', name: string, tab: string, seq0: number, records: [number, string][], context = '{}'): Promise<void> {
  const opfs = await navigator.storage.getDirectory()
  const top = await opfs.getDirectoryHandle('opfslogd', { create: true })
  const dir = await (await top.getDirectoryHandle(ns, { create: true })).getDirectoryHandle(state, { create: true })
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
  await w.write([headerLine(tab, seq0, context), ...records.map(([ts, msg]) => serializeRecord(ts, 'info', msg))].join('\n') + '\n')
  await w.close()
}

async function lines(file: Blob): Promise<Record<string, unknown>[]> {
  const text = await file.text()
  return text ? text.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []
}

describe('exportLogs', () => {
  it("includes this tab's active segment, in the exported shape (#033, #054)", async () => {
    start({ version: '1' })
    logger.info('a', { k: 1 })
    setContext({ userId: 'u42' }) // closes the first segment
    logger.warn('b')
    const { file, skipped } = await exportLogs() // flushes by itself
    expect(file.type).toBe('application/x-ndjson')
    expect(skipped).toEqual({ activeOtherTabs: 0, unreadable: 0 })
    const rs = await lines(file)
    expect(rs.map((r) => [r.msg, r.seq])).toEqual([
      ['a', 0],
      ['b', 1],
    ])
    expect(rs[0]).toMatchObject({ ctx: { k: 1 }, context: { version: '1' } })
    expect(rs[1]).toMatchObject({ context: { version: '1', userId: 'u42' } })
  })

  it('merges tabs in time order and keeps each file in its own order (#056)', async () => {
    start()
    await flush()
    const t = Date.now() - 60_000
    await put('done', closedName(t, t + 50, 'tabaaaaa'), 'tabaaaaa', 0, [
      [t, 'A1'],
      [t + 20, 'A2'],
      [t + 50, 'A3'],
    ])
    // B's clock jumped back between B2 and B3: B3 must still come after B2
    await put('pending', closedName(t + 5, t + 40, 'tabbbbbb'), 'tabbbbbb', 10, [
      [t + 10, 'B1'],
      [t + 40, 'B2'],
      [t + 5, 'B3'],
    ])
    const { file } = await exportLogs()
    const rs = await lines(file)
    expect(rs.map((r) => r.msg)).toEqual(['A1', 'B1', 'A2', 'B2', 'B3', 'A3'])
    expect(rs.find((r) => r.msg === 'B3')).toMatchObject({ tab: 'tabbbbbb', seq: 12 })
  })

  it('limits the time range by file name and by line (#055)', async () => {
    start()
    await flush()
    const t = Date.now() - 60_000
    await put('done', closedName(t, t + 30, 'tabaaaaa'), 'tabaaaaa', 0, [
      [t, 'early'],
      [t + 10, 'in 1'],
      [t + 20, 'in 2'],
      [t + 30, 'late'],
    ])
    await put('done', closedName(t + 1000, t + 2000, 'tabbbbbb'), 'tabbbbbb', 0, [[t + 1000, 'other file']])
    const { file } = await exportLogs({ from: t + 10, to: t + 20 })
    expect((await lines(file)).map((r) => r.msg)).toEqual(['in 1', 'in 2'])
  })

  it("counts other tabs' active segments and newer-format files as skipped (#054, #013)", async () => {
    start()
    logger.info('mine')
    await flush()
    const t = Date.now() - 60_000
    await put('active', activeName(t, 'othertab'), 'othertab', 0, [[t, 'not exported']])
    const opfs = await navigator.storage.getDirectory()
    const done = await (await (await opfs.getDirectoryHandle('opfslogd')).getDirectoryHandle(ns)).getDirectoryHandle('done')
    const w = await (await done.getFileHandle(closedName(t, t, 'newertab'), { create: true })).createWritable()
    await w.write('{"format":9,"minReader":9,"tab":"newertab","seq0":0,"context":{}}\n???\n')
    await w.close()

    const { file, skipped } = await exportLogs()
    expect(skipped).toEqual({ activeOtherTabs: 1, unreadable: 1 })
    expect((await lines(file)).map((r) => r.msg)).toEqual(['mine'])
  })

  it('builds large exports in pieces without losing lines', async () => {
    start()
    const n = 12_000 // about 2.5MB of output, several 1MB pieces
    for (let i = 0; i < n; i++) logger.info(`line ${i}`, { pad: 'x'.repeat(150) })
    const { file } = await exportLogs()
    const rs = await lines(file)
    expect(rs).toHaveLength(n)
    expect(rs.map((r) => r.seq)).toEqual(rs.map((_, i) => i))
  })

  it('resolves empty after close() (#063)', async () => {
    start()
    logger.info('x')
    await close()
    const { file, skipped } = await exportLogs()
    expect(file.size).toBe(0)
    expect(skipped).toEqual({ activeOtherTabs: 0, unreadable: 0 })
  })
})
