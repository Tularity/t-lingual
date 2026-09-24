import { captureModeDefaults, defaultLocalPreferences, loadLocalPreferences, saveLocalPreferences } from './preferences'
import { removeBrowserStorage } from '../platform/storage'

afterEach(() => {
  vi.restoreAllMocks()
  removeBrowserStorage('local', 't-lingual.local-preferences')
})

describe('local audio preferences', () => {
  it('uses native high-fidelity capture defaults if browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    expect(loadLocalPreferences()).toEqual(defaultLocalPreferences)
    expect(defaultLocalPreferences).toMatchObject({ captureMode: 'studio', microphoneGain: 12.5, echoCancellation: false, noiseSuppression: false })
  })

  it('migrates existing echo and noise choices without silently changing them', () => {
    localStorage.setItem('t-lingual.local-preferences', JSON.stringify({ inputDeviceId: 'old-mic', echoCancellation: false, noiseSuppression: true }))
    expect(loadLocalPreferences()).toEqual({ inputDeviceId: 'old-mic', echoCancellation: false, noiseSuppression: true, captureMode: 'communication', microphoneGain: 2 })
  })

  it('uses a safe gain when stored data is invalid and keeps valid customised gain', () => {
    localStorage.setItem('t-lingual.local-preferences', JSON.stringify({ captureMode: 'studio', microphoneGain: 100, inputDeviceId: 'mic-2' }))
    expect(loadLocalPreferences()).toMatchObject({ captureMode: 'studio', microphoneGain: 12.5, inputDeviceId: 'mic-2' })
    expect(captureModeDefaults('communication')).toEqual({ echoCancellation: true, noiseSuppression: true, microphoneGain: 2 })
    expect(saveLocalPreferences({ ...defaultLocalPreferences, microphoneGain: 3.4 })).toBe(true)
    expect(loadLocalPreferences().microphoneGain).toBe(3.4)
    expect(saveLocalPreferences({ ...defaultLocalPreferences, microphoneGain: 16 })).toBe(true)
    expect(loadLocalPreferences().microphoneGain).toBe(16)
  })

  it('keeps saving non-fatal when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
    const value = { ...defaultLocalPreferences, inputDeviceId: 'mic-2', echoCancellation: false, noiseSuppression: true }
    expect(saveLocalPreferences(value)).toBe(false)
    expect(loadLocalPreferences()).toEqual(value)
  })

  it('prefers a failed-write fallback over an older persistent value', () => {
    const original = { ...defaultLocalPreferences, inputDeviceId: 'old-mic' }
    const replacement = { ...defaultLocalPreferences, inputDeviceId: 'new-mic', noiseSuppression: true }
    expect(saveLocalPreferences(original)).toBe(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
    expect(saveLocalPreferences(replacement)).toBe(false)
    expect(loadLocalPreferences()).toEqual(replacement)
  })
})
