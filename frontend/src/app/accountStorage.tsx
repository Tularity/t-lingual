import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { AccountStorage } from '../api/contracts'
import { STORAGE_CHANGED } from './storageEvents'

const REFRESH_MS = 60_000

interface AccountStorageValue {
  storage: AccountStorage | null
  /** The account's storage limit is used up: no new sessions, and no recording into its sessions. */
  quotaFull: boolean
}

const Context = createContext<AccountStorageValue>({ storage: null, quotaFull: false })

/**
 * The signed-in account's storage, read once for the sidebar and every page
 * that must know whether it is full; read again on focus, every minute, and
 * whenever something may have changed it (see storageEvents).
 */
export function AccountStorageProvider({ userId, children }: { userId: string | undefined; children: ReactNode }) {
  const [state, setState] = useState<{ userId: string; value: AccountStorage } | null>(null)
  useEffect(() => {
    if (!userId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      clearTimeout(timer)
      if (!document.hidden) {
        try {
          const value = await api.usage?.storage()
          if (active && value) setState({ userId, value })
        } catch { /* The last reading stays; the next one may succeed. */ }
      }
      if (active) timer = setTimeout(() => void read(), REFRESH_MS)
    }
    void read()
    const again = () => { if (!document.hidden) void read() }
    window.addEventListener('focus', again)
    window.addEventListener(STORAGE_CHANGED, again)
    document.addEventListener('visibilitychange', again)
    return () => {
      active = false; clearTimeout(timer)
      window.removeEventListener('focus', again)
      window.removeEventListener(STORAGE_CHANGED, again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [userId])
  // Another account's figures are never shown while this one's load.
  const storage = state && state.userId === userId ? state.value : null
  const quotaFull = !!storage && storage.limitBytes > 0 && storage.usedBytes >= storage.limitBytes
  return <Context.Provider value={{ storage, quotaFull }}>{children}</Context.Provider>
}

/** The signed-in account's storage; empty outside the provider or before it is read. */
export function useAccountStorage() {
  return useContext(Context)
}
