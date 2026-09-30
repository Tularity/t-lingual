import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { RecordingAdmission } from '../../api/contracts'
import { STORAGE_CHANGED } from '../../app/storageEvents'

/** How often it is asked: sooner while refused, to offer recording again promptly. */
const CHECK_ALLOWED_MS = 15_000
const CHECK_REFUSED_MS = 5_000

/**
 * Whether this session could be recorded now, asked while `enabled` — while
 * the page could start a recording. The server answers with the rules
 * recording itself applies: recognition must be able to take it, and the
 * session's owner must have storage and recording time left. Undefined until
 * first known, and left as it was when asking fails: the server decides in
 * the end, when recording starts.
 */
export function useRecordingAdmission(sessionId: string, enabled: boolean) {
  const [admission, setAdmission] = useState<{ sessionId: string; value: RecordingAdmission } | null>(null)
  const refusedRef = useRef(false)
  useEffect(() => { refusedRef.current = admission?.value.allowed === false })
  useEffect(() => {
    if (!enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      clearTimeout(timer)
      if (!document.hidden) {
        try {
          const value = await api.sessions.recordingAdmission?.(sessionId)
          if (active && value) setAdmission({ sessionId, value })
        } catch { /* Unknown: keep what was known. */ }
      }
      if (active) timer = setTimeout(() => void check(), refusedRef.current ? CHECK_REFUSED_MS : CHECK_ALLOWED_MS)
    }
    void check()
    const again = () => { if (!document.hidden) void check() }
    document.addEventListener('visibilitychange', again)
    window.addEventListener(STORAGE_CHANGED, again)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', again); window.removeEventListener(STORAGE_CHANGED, again) }
  }, [enabled, sessionId])
  return enabled && admission?.sessionId === sessionId ? admission.value : undefined
}

export type RecordingRefusal = NonNullable<RecordingAdmission['reason']>

/** What the page says when a session cannot be recorded, as a notice and as a short line. */
export function refusalText(reason: RecordingRefusal, owner: boolean): { notice: string; short: string } | null {
  switch (reason) {
    case 'recognition_unavailable':
      return { notice: 'Speech recognition is unavailable right now, so recording can’t start. It will be offered again as soon as recognition is back.', short: 'Speech recognition is unavailable' }
    case 'storage_full':
      return owner
        ? { notice: 'Your storage is full, so recording can’t start. Delete sessions you no longer need to make room.', short: 'Your storage is full' }
        : { notice: 'This session’s owner has no storage left, so it can’t be recorded until they make room.', short: 'The owner’s storage is full' }
    case 'recording_time_used':
      return owner
        ? { notice: 'You’ve used this month’s recording time, so recording can’t start.', short: 'This month’s recording time is used' }
        : { notice: 'This session’s owner has used this month’s recording time, so it can’t be recorded.', short: 'The owner’s recording time is used' }
    case 'recording_limit':
      return owner
        ? { notice: 'You’re already recording as many sessions at once as you may. Stop another recording first.', short: 'Already recording elsewhere' }
        : { notice: 'This session’s owner is already recording as many sessions at once as they may.', short: 'The owner is recording elsewhere' }
    default:
      // Archived and not-permitted sessions say so themselves.
      return null
  }
}
