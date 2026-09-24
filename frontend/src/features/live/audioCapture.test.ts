import { captureModeDefaults, defaultLocalPreferences } from '../../app/preferences'
import { connectMicrophoneCapture, microphoneConstraints } from './audioCapture'

function node() {
  return { connect: vi.fn((destination: unknown) => destination), type: '', frequency: { value: 0 }, Q: { value: 0 },
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, gain: { value: 0 } }
}

describe('microphone capture modes', () => {
  it('asks for native 48 kHz ideally rather than forcing low-bandwidth 16 kHz', () => {
    expect(microphoneConstraints(defaultLocalPreferences)).toEqual({
      channelCount: { ideal: 1 }, sampleRate: { ideal: 48_000 }, echoCancellation: false,
      noiseSuppression: false, autoGainControl: false,
    })
    expect(microphoneConstraints({ ...defaultLocalPreferences, ...captureModeDefaults('communication'), captureMode: 'communication', inputDeviceId: 'headset' })).toEqual({
      channelCount: { ideal: 1 }, sampleRate: { ideal: 48_000 }, echoCancellation: true,
      noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'headset' },
    })
  })

  it('uses gentle studio compression and a final limiter after adjustable gain', () => {
    const source = node(), highpass = node(), compressor = node(), makeup = node(), limiter = node(), worklet = node()
    const context = { createMediaStreamSource: vi.fn(() => source), createBiquadFilter: vi.fn(() => highpass),
      createDynamicsCompressor: vi.fn().mockReturnValueOnce(compressor).mockReturnValueOnce(limiter), createGain: vi.fn(() => makeup) } as unknown as AudioContext
    connectMicrophoneCapture(context, {} as MediaStream, worklet as unknown as AudioWorkletNode, { ...defaultLocalPreferences, microphoneGain: 3 })
    expect(source.connect).toHaveBeenCalledWith(highpass)
    expect(highpass.frequency.value).toBe(75)
    expect(highpass.connect).toHaveBeenCalledWith(compressor)
    expect(compressor.ratio.value).toBe(3)
    expect(compressor.connect).toHaveBeenCalledWith(makeup)
    expect(makeup.gain.value).toBe(3)
    expect(makeup.connect).toHaveBeenCalledWith(limiter)
    expect(limiter.ratio.value).toBe(20)
    expect(limiter.connect).toHaveBeenCalledWith(worklet)
  })

  it('retains the previously effective 12.5× studio make-up gain with a limiter after it', () => {
    const context = { createMediaStreamSource: vi.fn(() => node()), createBiquadFilter: vi.fn(() => node()),
      createDynamicsCompressor: vi.fn(() => node()), createGain: vi.fn(() => node()) } as unknown as AudioContext
    const graph = connectMicrophoneCapture(context, {} as MediaStream, node() as unknown as AudioWorkletNode, defaultLocalPreferences)
    expect(graph.makeup.gain.value).toBe(12.5)
    expect(graph.makeup.connect).toHaveBeenCalledWith(graph.limiter)
  })

  it('avoids double-compressing communication audio already using browser AGC', () => {
    const source = node(), highpass = node(), makeup = node(), limiter = node(), worklet = node()
    const context = { createMediaStreamSource: vi.fn(() => source), createBiquadFilter: vi.fn(() => highpass),
      createDynamicsCompressor: vi.fn(() => limiter), createGain: vi.fn(() => makeup) } as unknown as AudioContext
    connectMicrophoneCapture(context, {} as MediaStream, worklet as unknown as AudioWorkletNode,
      { ...defaultLocalPreferences, ...captureModeDefaults('communication'), captureMode: 'communication' })
    expect(context.createDynamicsCompressor).toHaveBeenCalledTimes(1)
    expect(highpass.frequency.value).toBe(90)
    expect(highpass.connect).toHaveBeenCalledWith(makeup)
    expect(makeup.gain.value).toBe(2)
    expect(makeup.connect).toHaveBeenCalledWith(limiter)
  })
})
