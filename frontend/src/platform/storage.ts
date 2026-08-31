export type BrowserStorageKind = 'local' | 'session'

// A failed write must override an older persistent value for the rest of the
// tab. `null` is an in-memory tombstone for a remove that browser policy
// prevented us from persisting.
const memoryFallback: Record<BrowserStorageKind, Map<string, string | null>> = {
  local: new Map(),
  session: new Map(),
}

function browserStorage(kind: BrowserStorageKind) {
  return kind === 'local' ? window.localStorage : window.sessionStorage
}

export function readBrowserStorage(kind: BrowserStorageKind, key: string) {
  if (memoryFallback[kind].has(key)) return memoryFallback[kind].get(key) ?? null
  try {
    return browserStorage(kind).getItem(key)
  } catch {
    return null
  }
}

export function writeBrowserStorage(kind: BrowserStorageKind, key: string, value: string) {
  try {
    browserStorage(kind).setItem(key, value)
    memoryFallback[kind].delete(key)
    return true
  } catch {
    memoryFallback[kind].set(key, value)
    return false
  }
}

export function removeBrowserStorage(kind: BrowserStorageKind, key: string) {
  try {
    browserStorage(kind).removeItem(key)
    memoryFallback[kind].delete(key)
    return true
  } catch {
    memoryFallback[kind].set(key, null)
    return false
  }
}
