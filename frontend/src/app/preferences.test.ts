import { loadLocalPreferences, saveLocalPreferences } from './preferences'
import { removeBrowserStorage } from '../platform/storage'

afterEach(() => {
  vi.restoreAllMocks()
  removeBrowserStorage('local', 't-lingual.local-preferences')
})

describe('local audio preferences', () => {
  it('falls back to safe defaults when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })

    expect(loadLocalPreferences()).toEqual({
      inputDeviceId: 'default',
      echoCancellation: true,
      noiseSuppression: true,
    })
  })

  it('keeps saving non-fatal when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })

    const value = { inputDeviceId: 'mic-2', echoCancellation: false, noiseSuppression: true }
    expect(saveLocalPreferences(value)).toBe(false)
    expect(loadLocalPreferences()).toEqual(value)
  })

  it('prefers a failed-write fallback over an older persistent value', () => {
    const original = { inputDeviceId: 'old-mic', echoCancellation: true, noiseSuppression: true }
    const replacement = { inputDeviceId: 'new-mic', echoCancellation: false, noiseSuppression: false }
    expect(saveLocalPreferences(original)).toBe(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })

    expect(saveLocalPreferences(replacement)).toBe(false)
    expect(loadLocalPreferences()).toEqual(replacement)
  })
})
