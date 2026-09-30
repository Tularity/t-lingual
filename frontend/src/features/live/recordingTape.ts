/**
 * Everything captured in one recording until the server is known to have it.
 *
 * Audio is numbered by its byte position from the recording's start. Each
 * time a connection is ready, the server says where the session's saved
 * audio ends; the tape is anchored there, and sending goes on from exactly
 * that byte — nothing the server already has is sent twice, and nothing it
 * missed is skipped. Sent audio is kept for a while in case the connection
 * drops before it arrives; audio not yet sent is kept up to a limit, past
 * which the oldest is let go and counted.
 */
export class RecordingTape {
  /** Frames not yet known to be saved, oldest first, each with its byte position. */
  private frames: Array<{ start: number; data: ArrayBuffer }> = []
  /** Bytes captured so far: the position of the next frame. */
  private captured = 0
  /** Bytes handed to the connection so far. */
  private sent = 0
  /** Where byte 0 lies on the session's timeline, once a connection has said. */
  private baseMs: number | null = null
  /** Bytes let go before they could be sent. */
  private lost = 0

  /**
   * @param bytesPerMs audio bytes per millisecond: the sample rate × sampleBytes / 1000
   * @param maxBytes most audio kept, sent and unsent together
   * @param keepSentBytes how much sent audio is kept in case it did not arrive
   * @param sampleBytes bytes in one sample: audio is only ever cut between samples
   */
  constructor(readonly bytesPerMs: number, readonly maxBytes: number, readonly keepSentBytes: number, readonly sampleBytes = 4) {}

  /** Adds newly captured audio. */
  push(data: ArrayBuffer) {
    if (data.byteLength === 0 || data.byteLength % this.sampleBytes !== 0) return
    this.frames.push({ start: this.captured, data })
    this.captured += data.byteLength
    this.trim()
  }

  /**
   * A connection is ready, and the server's saved audio ends at `offsetMs` on
   * the session's timeline. Returns how much kept audio is to be sent, in ms.
   */
  anchor(offsetMs: number): number {
    if (this.baseMs === null) this.baseMs = offsetMs
    const saved = Math.max(0, Math.round((offsetMs - this.baseMs) * this.bytesPerMs / this.sampleBytes) * this.sampleBytes)
    const first = this.frames[0]?.start ?? this.captured
    // What the server lacks but was no longer kept cannot be sent again.
    if (saved < first) this.lost += first - saved
    this.sent = Math.min(this.captured, Math.max(saved, first))
    this.frames = this.frames.filter(frame => frame.start + frame.data.byteLength > this.sent)
    return this.pendingMs
  }

  /** The next audio to send, at most `limit` bytes, or null when all is sent. */
  next(limit: number): ArrayBuffer | null {
    const frame = this.frames.find(item => item.start + item.data.byteLength > this.sent)
    if (!frame) return null
    const from = this.sent - frame.start
    const size = Math.min(frame.data.byteLength - from, Math.max(this.sampleBytes, limit - limit % this.sampleBytes))
    return from === 0 && size === frame.data.byteLength ? frame.data : frame.data.slice(from, from + size)
  }

  /** Records that `bytes` more were handed to the connection. */
  markSent(bytes: number) {
    this.sent = Math.min(this.captured, this.sent + bytes)
    this.trim()
  }

  /** Audio captured but not yet sent, in ms. */
  get pendingMs() { return (this.captured - this.sent) / this.bytesPerMs }
  /** Audio let go before it could be sent, in ms. */
  get lostMs() { return this.lost / this.bytesPerMs }
  get anchored() { return this.baseMs !== null }

  /** Sent audio past what is kept goes; past the limit, the oldest goes even unsent. */
  private trim() {
    const keepFrom = this.sent - this.keepSentBytes
    while (this.frames.length > 1 && this.frames[0]!.start + this.frames[0]!.data.byteLength <= keepFrom) this.frames.shift()
    let held = this.captured - (this.frames[0]?.start ?? this.captured)
    while (this.frames.length > 1 && held > this.maxBytes) {
      const oldest = this.frames.shift()!
      const unsent = Math.max(0, oldest.start + oldest.data.byteLength - Math.max(this.sent, oldest.start))
      this.lost += unsent
      this.sent = Math.max(this.sent, oldest.start + oldest.data.byteLength)
      held -= oldest.data.byteLength
    }
  }
}
