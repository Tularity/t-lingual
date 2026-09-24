import { readBrowserStorage, writeBrowserStorage } from '../platform/storage'

export type CaptureMode = 'studio' | 'communication'
export interface LocalPreferences {
  inputDeviceId: string
  /** Browser processing switches retained for older stored preferences. */
  echoCancellation: boolean
  noiseSuppression: boolean
  captureMode: CaptureMode
  /** Linear microphone make-up gain; the capture chain limits peaks. */
  microphoneGain: number
}

const STORAGE_KEY = 't-lingual.local-preferences'
export const MIN_MICROPHONE_GAIN = 0.5
export const MAX_MICROPHONE_GAIN = 16
export const defaultLocalPreferences: LocalPreferences = {
  inputDeviceId: 'default', echoCancellation: false, noiseSuppression: false,
  captureMode: 'studio', microphoneGain: 12.5,
}

export function captureModeDefaults(mode: CaptureMode): Pick<LocalPreferences, 'echoCancellation' | 'noiseSuppression' | 'microphoneGain'> {
  return mode === 'studio'
    ? { echoCancellation: false, noiseSuppression: false, microphoneGain: 12.5 }
    : { echoCancellation: true, noiseSuppression: true, microphoneGain: 2 }
}

function normalizePreferences(value: Partial<LocalPreferences>): LocalPreferences {
  // Old installations stored only the browser processing switches. Preserve
  // those exact choices and choose the closest processing mode on migration.
  const legacy = typeof value.echoCancellation === 'boolean' || typeof value.noiseSuppression === 'boolean'
  const echoCancellation = typeof value.echoCancellation === 'boolean' ? value.echoCancellation : defaultLocalPreferences.echoCancellation
  const noiseSuppression = typeof value.noiseSuppression === 'boolean' ? value.noiseSuppression : defaultLocalPreferences.noiseSuppression
  const captureMode: CaptureMode = value.captureMode === 'studio' || value.captureMode === 'communication'
    ? value.captureMode : legacy && (echoCancellation || noiseSuppression) ? 'communication' : 'studio'
  const defaultGain = captureModeDefaults(captureMode).microphoneGain
  const microphoneGain = typeof value.microphoneGain === 'number' && Number.isFinite(value.microphoneGain)
    && value.microphoneGain >= MIN_MICROPHONE_GAIN && value.microphoneGain <= MAX_MICROPHONE_GAIN
    ? value.microphoneGain : defaultGain
  return {
    inputDeviceId: typeof value.inputDeviceId === 'string' && value.inputDeviceId.length <= 512 ? value.inputDeviceId : 'default',
    echoCancellation, noiseSuppression, captureMode, microphoneGain,
  }
}

export function loadLocalPreferences(): LocalPreferences {
  try {
    const value = JSON.parse(readBrowserStorage('local', STORAGE_KEY) ?? '{}') as Partial<LocalPreferences>
    return normalizePreferences(value && typeof value === 'object' ? value : {})
  } catch { return { ...defaultLocalPreferences } }
}

export function saveLocalPreferences(value: LocalPreferences) {
  return writeBrowserStorage('local', STORAGE_KEY, JSON.stringify(normalizePreferences(value)))
}
