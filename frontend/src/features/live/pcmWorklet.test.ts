import { readFileSync } from 'node:fs'
import { defaultLocalPreferences, captureModeDefaults } from '../../app/preferences'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

type WorkletPacket = ArrayBuffer | { type: 'flushed'; requestId: number }
function processorAt(sampleRate: number) {
  const packets: WorkletPacket[] = []
  const port = { onmessage: null as ((event: { data: { type: string; requestId: number } }) => void) | null,
    postMessage: (packet: WorkletPacket, transfer?: ArrayBuffer[]) => {
      if (packet instanceof ArrayBuffer) expect(transfer).toEqual([packet])
      packets.push(packet)
    } }
  let Processor!: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean; port: typeof port }
  const source = readFileSync(resolve(process.cwd(), 'public/pcm-worklet.js'), 'utf8')
  runInNewContext(source, {
    sampleRate, Float32Array, Math, Number, AudioWorkletProcessor: class { port = port },
    registerProcessor: (name: string, ctor: typeof Processor) => { expect(name).toBe('t-lingual-pcm'); Processor = ctor },
  })
  return { worklet: new Processor(), packets }
}

describe('native-rate PCM worklet', () => {
  it('assembles exact 20 ms transferable packets across 128-frame quanta and flushes the tail', () => {
    const { worklet, packets } = processorAt(48_000)
    const original = new Float32Array(1280)
    for (let i = 0; i < original.length; i++) original[i] = i / 2000
    for (let offset = 0; offset < original.length; offset += 128) {
      expect(worklet.process([[original.subarray(offset, offset + 128)]], [[new Float32Array(128)]])).toBe(true)
    }
    expect(packets).toHaveLength(1)
    expect((packets[0] as ArrayBuffer).byteLength).toBe(960 * 4)
    worklet.port.onmessage?.({ data: { type: 'flush', requestId: 7 } })
    expect((packets[1] as ArrayBuffer).byteLength).toBe(320 * 4)
    expect(packets[2]).toEqual({ type: 'flushed', requestId: 7 })
    const received = [...new Float32Array(packets[0] as ArrayBuffer), ...new Float32Array(packets[1] as ArrayBuffer)]
    expect(received).toEqual([...original])
  })

  it('sends silence rather than gating it and handles a missing input quantum', () => {
    const { worklet, packets } = processorAt(16_000)
    worklet.process([], [[new Float32Array(128)]])
    worklet.process([[new Float32Array(128)]], [[new Float32Array(128)]])
    worklet.process([[new Float32Array(128)]], [[new Float32Array(128)]])
    expect(packets).toHaveLength(1)
    expect(new Float32Array(packets[0] as ArrayBuffer)).toEqual(new Float32Array(320))
    worklet.port.onmessage?.({ data: { type: 'flush', requestId: 8 } })
    expect(new Float32Array(packets[1] as ArrayBuffer)).toEqual(new Float32Array(64))
  })

  it('downmixes stereo input without losing speech that exists only on the second channel', () => {
    const { worklet, packets } = processorAt(16_000)
    worklet.process([[new Float32Array(320), new Float32Array(320).fill(0.6)]], [[new Float32Array(320)]])
    const output = new Float32Array(packets[0] as ArrayBuffer)
    expect(output.length).toBe(320)
    expect(output[0]).toBeCloseTo(0.3)
  })
  it('quantifies quiet speech boost and loud peak protection at the selectable gain settings', () => {
    const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    const studio = processorAt(16_000)
    // Model a quiet signal below the compressor threshold: it reaches the
    // worklet after the configured make-up gain, with no model inference.
    const quiet = new Float32Array(320).fill(0.004 * defaultLocalPreferences.microphoneGain)
    studio.worklet.process([[quiet]], [[new Float32Array(320)]])
    const quietOutput = new Float32Array(studio.packets[0] as ArrayBuffer)
    expect(rms(quietOutput)).toBeCloseTo(0.05, 3) // 12.5× vs the raw 0.004 RMS
    expect(Math.max(...quietOutput)).toBeLessThan(0.84) // quiet detail remains linear

    const loud = new Float32Array(320).fill(0.2 * defaultLocalPreferences.microphoneGain)
    studio.worklet.process([[loud]], [[new Float32Array(320)]])
    const loudOutput = new Float32Array(studio.packets[1] as ArrayBuffer)
    expect(rms(loudOutput)).toBeGreaterThan(0.9)
    expect(Math.max(...loudOutput)).toBeLessThan(0.99) // worst-case peak stays bounded

    const communication = processorAt(16_000)
    communication.worklet.process([[new Float32Array(320).fill(0.004 * captureModeDefaults('communication').microphoneGain)]], [[new Float32Array(320)]])
    expect(rms(new Float32Array(communication.packets[0] as ArrayBuffer))).toBeCloseTo(0.008, 3)
  })
  it('keeps quiet samples unchanged while limiting peaks without digital clipping', () => {
    const { worklet, packets } = processorAt(16_000)
    const input = new Float32Array(320)
    input[0] = 0.5; input[1] = 4; input[2] = -4; input[3] = Number.NaN
    worklet.process([[input]], [[new Float32Array(320)]])
    const output = new Float32Array(packets[0] as ArrayBuffer)
    expect(output[0]).toBe(0.5)
    expect(output[1]).toBeGreaterThan(0.84)
    expect(output[1]).toBeLessThan(0.99)
    expect(output[2]).toBeLessThan(-0.84)
    expect(output[2]).toBeGreaterThan(-0.99)
    expect(output[3]).toBe(0)
  })
})
