import { describe, expect, it } from 'vitest'
import { RecordingTape } from './recordingTape'

// 1 byte per ms keeps the arithmetic readable; frames are whole samples.
const frame = (bytes: number, fill = 1) => new Float32Array(bytes / 4).fill(fill).buffer
const drain = (tape: RecordingTape, limit = 1_000) => {
  const out: number[] = []
  for (let next = tape.next(limit); next; next = tape.next(limit)) { out.push(next.byteLength); tape.markSent(next.byteLength) }
  return out
}

describe('the recording tape', () => {
  it('sends what the server has not saved, from exactly where its audio ends', () => {
    const tape = new RecordingTape(4, 1_000_000, 1_000)
    tape.push(frame(400)); tape.push(frame(400))
    expect(tape.anchor(1_000)).toBe(200)
    expect(drain(tape)).toEqual([400, 400])
    tape.push(frame(400))
    expect(drain(tape)).toEqual([400])
    // The connection drops; the server saved only the first 150 ms of this recording.
    tape.push(frame(400))
    expect(tape.anchor(1_150)).toBe(250)
    expect(drain(tape)).toEqual([200, 400, 400])
    expect(tape.pendingMs).toBe(0)
    expect(tape.lostMs).toBe(0)
  })

  it('counts what the server lacks but was no longer kept', () => {
    const tape = new RecordingTape(4, 1_000_000, 400)
    tape.anchor(0)
    for (let index = 0; index < 3; index += 1) { tape.push(frame(400)); drain(tape) }
    // The server saved 100 ms of the 300 sent; only the last 100 ms are still kept.
    expect(tape.anchor(100)).toBe(100)
    expect(tape.lostMs).toBe(100)
  })

  it('never sends twice what the server already has', () => {
    const tape = new RecordingTape(4, 1_000_000, 4_000)
    tape.anchor(0)
    tape.push(frame(800)); drain(tape)
    tape.push(frame(400))
    expect(tape.anchor(200)).toBe(100)
    expect(drain(tape)).toEqual([400])
  })

  it('lets the oldest audio go past its limit, and counts it', () => {
    const tape = new RecordingTape(4, 800, 0)
    tape.push(frame(400)); tape.push(frame(400)); tape.push(frame(400))
    expect(tape.lostMs).toBe(100)
    expect(tape.anchor(0)).toBe(200)
    expect(drain(tape)).toEqual([400, 400])
  })

  it('keeps no more sent audio than it is asked to', () => {
    const tape = new RecordingTape(4, 1_000_000, 400)
    tape.anchor(0)
    for (let index = 0; index < 5; index += 1) { tape.push(frame(400)); drain(tape) }
    // Only the last 400 sent bytes remain to be sent again if they were lost.
    expect(tape.anchor(0)).toBe(100)
  })

  it('splits a frame to fit what the connection takes', () => {
    const tape = new RecordingTape(4, 1_000_000, 0)
    tape.anchor(0); tape.push(frame(1_000))
    expect(drain(tape, 300)).toEqual([300, 300, 300, 100])
  })

  it('keeps 16-bit audio whole samples at a time, whatever their count', () => {
    // 441 samples a frame, as at 22.05 kHz: an odd count of 2-byte samples.
    const tape = new RecordingTape(2 * 22.05, 1_000_000, 1_000_000, 2)
    tape.push(new ArrayBuffer(882)); tape.push(new ArrayBuffer(882))
    // The server saved 10 ms: 220.5 samples, so the tape goes on from a sample's start.
    expect(tape.anchor(0)).toBeCloseTo(40, 0)
    tape.markSent(882)
    tape.anchor(10)
    expect(drain(tape, 301).every(size => size % 2 === 0)).toBe(true)
  })
})
