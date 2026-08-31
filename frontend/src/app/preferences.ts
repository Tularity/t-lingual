import { readBrowserStorage, writeBrowserStorage } from '../platform/storage'

export interface LocalPreferences {
  inputDeviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
}

const STORAGE_KEY = 't-lingual.local-preferences'
const defaults: LocalPreferences = { inputDeviceId: 'default', echoCancellation: true, noiseSuppression: true }

export function loadLocalPreferences(): LocalPreferences {
  try {
    const value = JSON.parse(readBrowserStorage('local', STORAGE_KEY) ?? '{}') as Partial<LocalPreferences>
    return {
      inputDeviceId: typeof value.inputDeviceId === 'string' ? value.inputDeviceId : defaults.inputDeviceId,
      echoCancellation: typeof value.echoCancellation === 'boolean' ? value.echoCancellation : defaults.echoCancellation,
      noiseSuppression: typeof value.noiseSuppression === 'boolean' ? value.noiseSuppression : defaults.noiseSuppression,
    }
  } catch { return { ...defaults } }
}

export function saveLocalPreferences(value: LocalPreferences) {
  return writeBrowserStorage('local', STORAGE_KEY, JSON.stringify(value))
}
