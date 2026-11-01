// Worker write path against real OPFS, Workers, and Web Locks (step 8, unit 4).

import { describe, expect, it } from 'vitest'
import { activeName, closedName } from '../../src/names'
import type { ToWorker } from '../../src/protocol'
import { header, list, read, start, NS, type Harness } from './worker-harness'

describe('worker write path', () => {
  it('holds the tab lock once ready (#012)', async () => {
    const h = await start()
    const { held = [] } = await navigator.locks.query()
    expect(held.map((l) => l.name)).toContain(`opfslogd:${NS}:tab:${h.tabId}`)
  })

  it('opens a segment at the first write, named by the batch min ts (#064, #067)', async () => {
    const h = await start()
    expect(await list(h, 'active')).toEqual([])
    expect(
      await h.write([
        [1500, 'info', 'a'],
        [1200, 'warn', 'b'],
      ]),
    ).toEqual({ type: 'ack', id: 1, ok: true })
    expect(await h.write([[1600, 'error', 'c']])).toEqual({ type: 'ack', id: 2, ok: true })

    const name = activeName(1200, h.tabId)
    expect(await list(h, 'active')).toEqual([name])
    const lines = await read(h, 'active', name)
    expect(header(lines[0])).toEqual({ format: 1, minReader: 1, tab: h.tabId, seq0: 0, context: {} })
    expect(lines.slice(1).map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['a', 'b', 'c'])
  })

  it('rotates at the size limit into done/ without upload, and continues seq0 (#021, #068)', async () => {
    const h = await start({ rotateMaxBytes: 150 })
    await h.write([
      [100, 'info', 'x'.repeat(40)],
      [300, 'info', 'y'.repeat(40)],
    ])
    expect(await list(h, 'active')).toEqual([])
    expect(await list(h, 'done')).toEqual([closedName(100, 300, h.tabId)])

    await h.write([[400, 'info', 'z']])
    const [active] = await list(h, 'active')
    expect(header((await read(h, 'active', active ?? ''))[0]).seq0).toBe(2)
  })

  it('moves closed segments to pending/ with upload (#068)', async () => {
    const h = await start({ rotateMaxBytes: 10, upload: true })
    await h.write([[100, 'info', 'a']])
    expect(await list(h, 'pending')).toEqual([closedName(100, 100, h.tabId)])
    expect(await list(h, 'done')).toEqual([])
  })

  it('rotates by age (#021)', async () => {
    const h = await start({ rotateMaxAgeMs: 100 })
    await h.write([[100, 'info', 'a']])
    await expect.poll(() => list(h, 'done'), { timeout: 3000 }).toEqual([closedName(100, 100, h.tabId)])
    expect(await list(h, 'active')).toEqual([])
  })

  it('starts a new segment with the new context (#031)', async () => {
    const h = await start({ context: '{"v":1}' })
    await h.write([[100, 'info', 'a']])
    h.send({ type: 'context', context: '{"v":1,"userId":"u42"}' })
    await h.write([[200, 'info', 'b']])

    expect(await list(h, 'done')).toEqual([closedName(100, 100, h.tabId)])
    const [active] = await list(h, 'active')
    expect(header((await read(h, 'active', active ?? ''))[0])).toMatchObject({
      seq0: 1,
      context: { v: 1, userId: 'u42' },
    })
  })

  it('does not write a file for a context change with no records', async () => {
    const h = await start()
    h.send({ type: 'context', context: '{"a":1}' })
    h.send({ type: 'close' })
    await h.next('closed')
    expect(await list(h, 'active')).toEqual([])
    expect(await list(h, 'done')).toEqual([])
  })

  it('keeps both segments when their names would clash', async () => {
    const h = await start()
    await h.write([[100, 'info', 'a']])
    h.send({ type: 'context', context: '{"a":1}' })
    await h.write([[100, 'info', 'b']])
    h.send({ type: 'close' })
    await h.next('closed')
    expect(await list(h, 'done')).toEqual([closedName(100, 100, h.tabId), closedName(100, 101, h.tabId)])
  })

  it('on close, moves the active segment and releases the lock (#030)', async () => {
    const h = await start({ upload: true })
    await h.write([[100, 'info', 'a']])
    h.send({ type: 'close' })
    expect(await h.next('closed')).toEqual({ type: 'closed' })
    expect(await list(h, 'active')).toEqual([])
    expect(await list(h, 'pending')).toEqual([closedName(100, 100, h.tabId)])
    const { held = [] } = await navigator.locks.query()
    expect(held.map((l) => l.name)).not.toContain(`opfslogd:${NS}:tab:${h.tabId}`)
  })

  it('releases the lock when the worker is terminated', async () => {
    const h = await start()
    await h.write([[100, 'info', 'a']])
    h.stop()
    const lock = `opfslogd:${NS}:tab:${h.tabId}`
    await expect
      .poll(async () => ((await navigator.locks.query()).held ?? []).some((l) => l.name === lock), { timeout: 3000 })
      .toBe(false)
    // the file stays in active/ for orphan recovery (#020)
    expect(await list(h, 'active')).toEqual([activeName(100, h.tabId)])
  })

  describe('failed writes (#064)', () => {
    /** Makes a sync handle write fail after `skip` successful ones. */
    function failWrite(h: Harness, name: string, skip = 0): void {
      h.send({ type: 'test-fail', name, skip } as unknown as ToWorker)
    }

    it('rolls back the partial write, acks as failed, and rotates', async () => {
      const h = await start({}, true)
      await h.write([[100, 'info', 'kept']])
      failWrite(h, 'QuotaExceededError')
      expect(
        await h.write([
          [200, 'info', 'lost'],
          [210, 'info', 'lost'],
        ]),
      ).toEqual({ type: 'ack', id: 2, ok: false, reason: 'quota' })

      // the rotated segment holds only the good line: no partial line left behind
      expect(await list(h, 'active')).toEqual([])
      const done = closedName(100, 100, h.tabId)
      expect(await list(h, 'done')).toEqual([done])
      const lines = await read(h, 'done', done)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[1] ?? '')).toMatchObject({ msg: 'kept' })

      // the next segment's seq0 counts the lost lines, so the gap falls between segments
      expect(await h.write([[300, 'info', 'next']])).toMatchObject({ ok: true })
      expect(header((await read(h, 'active', activeName(300, h.tabId)))[0]).seq0).toBe(3)
    })

    it('treats a short write as quota, and rolls it back', async () => {
      const h = await start({}, true)
      await h.write([[100, 'info', 'kept']])
      failWrite(h, 'short')
      expect(await h.write([[200, 'info', 'lost']])).toMatchObject({ ok: false, reason: 'quota' })
      const lines = await read(h, 'done', closedName(100, 100, h.tabId))
      expect(lines).toHaveLength(2)
    })

    it('reports other errors as write-failed', async () => {
      const h = await start({}, true)
      await h.write([[100, 'info', 'a']])
      failWrite(h, 'InvalidStateError')
      expect(await h.write([[200, 'info', 'b']])).toMatchObject({ ok: false, reason: 'write-failed' })
    })

    it('leaves no file when the header write fails', async () => {
      const h = await start({}, true)
      failWrite(h, 'QuotaExceededError') // first write call is the header
      expect(await h.write([[100, 'info', 'a']])).toMatchObject({ ok: false, reason: 'quota' })
      expect(await list(h, 'active')).toEqual([])
      expect(await list(h, 'done')).toEqual([])
      // the next write opens a segment normally, with seq0 after the lost line
      await h.write([[200, 'info', 'b']])
      expect(header((await read(h, 'active', activeName(200, h.tabId)))[0]).seq0).toBe(1)
    })

    it('deletes a segment whose first batch failed', async () => {
      const h = await start({}, true)
      failWrite(h, 'QuotaExceededError', 1) // header passes, batch fails
      expect(await h.write([[100, 'info', 'a']])).toMatchObject({ ok: false, reason: 'quota' })
      expect(await list(h, 'active')).toEqual([])
      expect(await list(h, 'done')).toEqual([])
    })
  })
})
