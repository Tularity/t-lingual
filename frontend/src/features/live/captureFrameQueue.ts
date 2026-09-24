/** A short bounded bridge between native audio capture and WebSocket readiness.
 * Never silently discard PCM during a handshake or short reconnect. */
export class CaptureFrameQueue {
  private frames: ArrayBuffer[] = []
  private bytes = 0
  constructor(readonly maxBytes: number) {}
  enqueue(frame: ArrayBuffer): boolean {
    if (frame.byteLength === 0 || frame.byteLength % 4 !== 0 || this.bytes + frame.byteLength > this.maxBytes) return false
    this.frames.push(frame)
    this.bytes += frame.byteLength
    return true
  }
  drain(send: (frame: ArrayBuffer) => void) {
    while (this.frames.length > 0) {
      const frame = this.frames[0]!
      send(frame)
      this.frames.shift()
      this.bytes -= frame.byteLength
    }
  }
  clear() { this.frames = []; this.bytes = 0 }
  get length() { return this.frames.length }
  get byteLength() { return this.bytes }
}
