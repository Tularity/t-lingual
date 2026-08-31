import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from './storage'

const key = 't-lingual.storage-test'

afterEach(() => {
  vi.restoreAllMocks()
  removeBrowserStorage('session', key)
})

describe('safe browser storage', () => {
  it('uses an in-memory tombstone when a persisted value cannot be removed', () => {
    expect(writeBrowserStorage('session', key, 'signed-in')).toBe(true)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })

    expect(removeBrowserStorage('session', key)).toBe(false)
    expect(readBrowserStorage('session', key)).toBeNull()
  })
})
