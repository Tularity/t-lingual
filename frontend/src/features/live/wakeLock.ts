import { useEffect } from 'react'

type WakeLockSentinel = { released: boolean; release(): Promise<void>; addEventListener(type: 'release', listener: () => void): void }
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } }

/**
 * Keeps the screen on while `active`. A phone that locks its screen puts the
 * page in the background, and the page's microphone stops with it; a lock the
 * browser lets go when the page is hidden is asked for again when it returns.
 */
export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    const wakeLock = (navigator as WakeLockNavigator).wakeLock
    if (!active || !wakeLock) return
    let sentinel: WakeLockSentinel | null = null
    let asking = false
    let stopped = false
    const request = () => {
      if (stopped || asking || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return
      asking = true
      wakeLock.request('screen').then(lock => {
        if (stopped) { void lock.release().catch(() => undefined); return }
        sentinel = lock
      }).catch(() => undefined).finally(() => { asking = false })
    }
    request()
    document.addEventListener('visibilitychange', request)
    window.addEventListener('pageshow', request)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', request)
      window.removeEventListener('pageshow', request)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined)
    }
  }, [active])
}
