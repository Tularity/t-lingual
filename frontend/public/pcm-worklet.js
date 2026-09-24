class TLingualPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Exact packet size across 128-frame render quanta. At 48 kHz this is
    // 960 samples (20 ms), while the device's native sample rate stays intact.
    this.targetFrames = Math.max(128, Math.round(sampleRate * 0.02))
    this.pending = new Float32Array(this.targetFrames)
    this.filled = 0
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return
      if (this.filled > 0) this.emit(this.filled)
      this.port.postMessage({ type: 'flushed', requestId: event.data.requestId })
    }
  }

  emit(frames) {
    const packet = frames === this.targetFrames ? this.pending : this.pending.slice(0, frames)
    this.pending = new Float32Array(this.targetFrames)
    this.filled = 0
    this.port.postMessage(packet.buffer, [packet.buffer])
  }

  // The soft limiter is only a safety net after gain and native dynamics
  // processing. Samples below the knee are untouched; above it there is no
  // hard digital clipping or non-finite sample sent to the recorder.
  limit(value) {
    if (!Number.isFinite(value)) return 0
    const absolute = Math.abs(value)
    if (absolute <= 0.84) return value
    const limited = 0.84 + 0.145 * (1 - Math.exp(-(absolute - 0.84) / 0.145))
    return Math.sign(value) * limited
  }

  process(inputs, outputs) {
    const channels = inputs[0] ?? []
    // AudioWorklet receives zero-valued samples during silence. If an input
    // render quantum is absent, keep its time as zero PCM instead of gating it.
    const length = channels.find(channel => channel?.length)?.length ?? outputs[0]?.[0]?.length ?? 128
    for (let index = 0; index < length; index++) {
      let sum = 0, count = 0
      for (const channel of channels) {
        if (index < channel.length) { sum += channel[index]; count++ }
      }
      this.pending[this.filled++] = this.limit(count ? sum / count : 0)
      if (this.filled === this.targetFrames) this.emit(this.targetFrames)
    }
    return true
  }
}

registerProcessor('t-lingual-pcm', TLingualPCMProcessor)
