class TLingualPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetFrames = Math.max(128, Math.round(sampleRate * 0.02))
    this.chunks = []
    this.frames = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel?.length) return true

    const copy = new Float32Array(channel.length)
    copy.set(channel)
    this.chunks.push(copy)
    this.frames += copy.length

    if (this.frames >= this.targetFrames) {
      const output = new Float32Array(this.frames)
      let offset = 0
      for (const chunk of this.chunks) {
        output.set(chunk, offset)
        offset += chunk.length
      }
      this.chunks = []
      this.frames = 0
      this.port.postMessage(output.buffer, [output.buffer])
    }
    return true
  }
}

registerProcessor('t-lingual-pcm', TLingualPCMProcessor)
