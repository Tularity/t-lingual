import type { LocalPreferences } from '../../app/preferences'

/** Advisory constraints: never require a 16 kHz device or resample in the browser. */
export function microphoneConstraints(preferences: LocalPreferences): MediaTrackConstraints {
  return {
    channelCount: { ideal: 1 }, sampleRate: { ideal: 48_000 },
    echoCancellation: preferences.captureMode==='studio'?false:preferences.echoCancellation,
    noiseSuppression: preferences.captureMode==='studio'?false:preferences.noiseSuppression,
    autoGainControl: preferences.captureMode === 'communication',
    ...(preferences.inputDeviceId === 'default' ? {} : { deviceId: { exact: preferences.inputDeviceId } }),
  }
}

/**
 * Narrows the worklet's float samples to little-endian 16-bit, as they are
 * sent: half the bandwidth, and nothing a voice loses. The server widens
 * them again.
 */
export function toPcm16(samples: ArrayBuffer): ArrayBuffer {
  const input = new Float32Array(samples)
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index++) {
    const value = Math.max(-1, Math.min(1, input[index] || 0))
    output[index] = Math.round(value < 0 ? value * 32768 : value * 32767)
  }
  return output.buffer
}

/** Connects microphone DSP to the native-rate worklet. No playback is audible. */
export function connectMicrophoneCapture(context: AudioContext, stream: MediaStream, worklet: AudioWorkletNode, preferences: LocalPreferences) {
  const source = context.createMediaStreamSource(stream)
  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = preferences.captureMode === 'studio' ? 75 : 90
  highpass.Q.value = 0.707
  source.connect(highpass)

  const makeup = context.createGain()
  makeup.gain.value = preferences.microphoneGain
  if (preferences.captureMode === 'studio') {
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -30
    compressor.knee.value = 18
    compressor.ratio.value = 3
    compressor.attack.value = 0.01
    compressor.release.value = 0.2
    highpass.connect(compressor).connect(makeup)
  } else {
    // Browser AGC already levels the communication mode. Avoid compressing it
    // a second time, which can pump noise and dull the signal.
    highpass.connect(makeup)
  }

  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -2
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.003
  limiter.release.value = 0.12
  makeup.connect(limiter).connect(worklet)
  return { source, highpass, makeup, limiter }
}
