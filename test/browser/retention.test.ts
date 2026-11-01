// Retention runs in the worker against real OPFS and Web Locks (step 8, unit 7).

import { describe, expect, it } from 'vitest'
import { activeName, closedName } from '../../src/names'
import type { FromWorker } from '../../src/protocol'
import { serializeRecord } from '../../src/record'
import { headerLine } from '../../src/segment'
import { NS, dir, list, read, start, type Harness } from './worker-harness'

const DAY = 86_400_000

/** Writes a file from the main thread, as another tab would have left it. */
async function put(h: Harness, state: 'active' | 'pending' | 'done', name: string, content: string | Uint8Array): Promise<void> {
  const file = await (await dir(h, state)).getFileHandle(name, { create: true })
  const w = await file.createWritable()
  await w.write(typeof content === 'string' ? content : new Blob([content as Uint8Array<ArrayBuffer>]))
  await w.close()
}

function segment(tab: string, records: [number, string][], tail = ''): string {
  return [headerLine(tab, 0, '{}'), ...records.map(([ts, msg]) => serializeRecord(ts, 'info', msg))].join('\n') + '\n' + tail
}

async function maintain(h: Harness): Promise<Extract<FromWorker, { type: 'maintained' }>> {
  h.send({ type: 'maintain' })
  return (await h.next('maintained')) as Extract<FromWorker, { type: 'maintained' }>
}

describe('orphan recovery (#012, #016, #067)', () => {
  it('cuts a partial last line and moves the file out of active/, named by its ts range', async () => {
    const h = await start()
    const t = Date.now() - 10_000 // recent, so the age limit keeps it
    await put(h, 'active', activeName(t, 'deadtab1'), segment('deadtab1', [[t + 200, 'a'], [t, 'b'], [t + 400, 'c']], '{"ts":95'))
    expect(await maintain(h)).toMatchObject({ ran: true })
    expect(await list(h, 'active')).toEqual([])
    const name = closedName(t, t + 400, 'deadtab1')
    expect(await list(h, 'done')).toEqual([name])
    const lines = await read(h, 'done', name)
    expect(lines).toHaveLength(4)
    expect(lines.at(-1)).toContain('"msg":"c"')
  })

  it('sends recovered files to pending/ when this tab uploads (#068)', async () => {
    const h = await start({ upload: true })
    const t = Date.now() - 10_000
    await put(h, 'active', activeName(t, 'deadtab1'), segment('deadtab1', [[t, 'a']]))
    await maintain(h)
    expect(await list(h, 'pending')).toEqual([closedName(t, t, 'deadtab1')])
  })

  it('deletes files without records or with a broken header (#016, #075)', async () => {
    const h = await start()
    await put(h, 'active', activeName(1, 'headonly'), segment('headonly', []))
    await put(h, 'active', activeName(2, 'brokenhd'), '{"format":1,"minR')
    await put(h, 'active', activeName(3, 'zeroes00'), new Uint8Array(64))
    await maintain(h)
    expect(await list(h, 'active')).toEqual([])
    expect(await list(h, 'done')).toEqual([])
  })

  it('leaves a file in a newer format alone (#013)', async () => {
    const h = await start()
    const name = activeName(1, 'newertab')
    await put(h, 'active', name, '{"format":9,"minReader":9,"tab":"newertab","seq0":0,"context":{}}\n')
    await maintain(h)
    expect(await list(h, 'active')).toEqual([name])
  })

  it('does not touch the active file of a live tab', async () => {
    const h = await start()
    await h.write([[100, 'info', 'mine']]) // this tab's own active file
    const other = activeName(200, 'livetab1')
    await put(h, 'active', other, segment('livetab1', [[200, 'x']]))
    let release = (): void => {}
    const held = new Promise<void>((granted) => {
      void navigator.locks.request(`opfslogd:${NS}:tab:livetab1`, () => {
        granted()
        return new Promise<void>((r) => (release = r))
      })
    })
    await held
    try {
      await maintain(h)
      expect(await list(h, 'active')).toEqual([activeName(100, h.tabId), other].sort())
    } finally {
      release()
    }
  })
})

describe('limits (#050 - #052)', () => {
  it('deletes closed segments past the age limit and reports deleted pending ones (#061, #070)', async () => {
    const h = await start({ retentionMaxAgeMs: DAY })
    const now = Date.now()
    const oldDone = closedName(now - 3 * DAY, now - 2 * DAY, 'aaaaaaaa')
    const oldPending = closedName(now - 5 * DAY, now - 4 * DAY, 'bbbbbbbb')
    const recent = closedName(now - 1000, now - 500, 'cccccccc')
    await put(h, 'done', oldDone, segment('aaaaaaaa', [[now - 2 * DAY, 'x']]))
    await put(h, 'pending', oldPending, segment('bbbbbbbb', [[now - 4 * DAY, 'y']]))
    await put(h, 'pending', recent, segment('cccccccc', [[now - 500, 'z']]))
    const pendingSize = (await (await (await dir(h, 'pending')).getFileHandle(oldPending)).getFile()).size

    const r = await maintain(h)
    expect(await list(h, 'done')).toEqual([])
    expect(await list(h, 'pending')).toEqual([recent])
    expect(r.dropped).toEqual({ segments: 1, bytes: pendingSize, from: now - 5 * DAY, to: now - 4 * DAY })
  })

  it('over the size limit, deletes done before pending, oldest first; keeps active (#007, #052)', async () => {
    const h = await start({ retentionMaxBytes: 1000 })
    const now = Date.now()
    const pad = 'p'.repeat(300)
    const names = {
      done1: closedName(now - 5000, now - 4900, 'aaaaaaaa'),
      done2: closedName(now - 3000, now - 2900, 'aaaaaaaa'),
      pend1: closedName(now - 4000, now - 3900, 'bbbbbbbb'),
      pend2: closedName(now - 2000, now - 1900, 'bbbbbbbb'),
    }
    await put(h, 'done', names.done1, segment('aaaaaaaa', [[now - 4900, pad]]))
    await put(h, 'done', names.done2, segment('aaaaaaaa', [[now - 2900, pad]]))
    await put(h, 'pending', names.pend1, segment('bbbbbbbb', [[now - 3900, pad]]))
    await put(h, 'pending', names.pend2, segment('bbbbbbbb', [[now - 1900, pad]]))
    await h.write([[now, 'info', pad]]) // active, about 450 bytes, never deleted

    const r = await maintain(h)
    expect(await list(h, 'done')).toEqual([])
    expect(await list(h, 'pending')).toEqual([names.pend2])
    expect(await list(h, 'active')).toHaveLength(1)
    expect(r.dropped).toMatchObject({ segments: 1, from: now - 4000, to: now - 3900 })
  })

  it('skips the run while another tab holds the retention lock (#022)', async () => {
    const h = await start({ retentionMaxAgeMs: DAY })
    const old = closedName(1000, 2000, 'aaaaaaaa')
    await put(h, 'done', old, segment('aaaaaaaa', [[2000, 'x']]))
    let release = (): void => {}
    await new Promise<void>((granted) => {
      void navigator.locks.request(`opfslogd:${NS}:retention`, () => {
        granted()
        return new Promise<void>((r) => (release = r))
      })
    })
    try {
      expect(await maintain(h)).toEqual({ type: 'maintained', ran: false })
      expect(await list(h, 'done')).toEqual([old])
    } finally {
      release()
    }
  })
})
