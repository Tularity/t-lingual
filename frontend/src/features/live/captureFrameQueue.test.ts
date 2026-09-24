import { CaptureFrameQueue } from './captureFrameQueue'

describe('bounded microphone handshake queue', () => {
  it('preserves silent and non-silent native PCM frames in order', () => {
    const queue = new CaptureFrameQueue(24)
    const first = new Float32Array([0, 0]).buffer
    const second = new Float32Array([0.4, 0.2]).buffer
    expect(queue.enqueue(first)).toBe(true)
    expect(queue.enqueue(second)).toBe(true)
    const sent: ArrayBuffer[] = []
    queue.drain(frame => sent.push(frame))
    expect(sent).toEqual([first, second])
    expect(queue.byteLength).toBe(0)
  })
  it('rejects sustained outage instead of dropping or trimming its buffered speech', () => {
    const queue = new CaptureFrameQueue(8)
    const frame = new Float32Array([1, 0]).buffer
    expect(queue.enqueue(frame)).toBe(true)
    expect(queue.enqueue(frame)).toBe(false)
    expect(queue.length).toBe(1)
    const sent: ArrayBuffer[] = []
    queue.drain(value => sent.push(value))
    expect(sent).toEqual([frame])
  })
  it('retains an unsent frame when the transport refuses backpressure', () => {
    const queue = new CaptureFrameQueue(16)
    const frame = new Float32Array([1, 2]).buffer
    queue.enqueue(frame)
    expect(() => queue.drain(() => { throw new Error('backpressure') })).toThrow('backpressure')
    expect(queue.byteLength).toBe(8)
    queue.clear()
    expect(queue.length).toBe(0)
  })
})
