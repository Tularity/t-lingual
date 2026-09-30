import { api } from '../api/client'
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from '../platform/storage'

/**
 * A link that asked its opener to sign in first, kept for this tab only so it
 * opens once they have — and forgotten as soon as it is used.
 */
const key = 't-lingual:pending-share'

export function rememberShare(token: string) {
  writeBrowserStorage('session', key, token)
}

/** Where to go after signing in: the waiting link's session, or the workspace. */
export async function afterSignIn(): Promise<string> {
  const token = readBrowserStorage('session', key)
  if (!token) return '/sessions'
  removeBrowserStorage('session', key)
  try {
    const { sessionId } = await api.sharing.join(token)
    return `/sessions/${encodeURIComponent(sessionId)}`
  } catch {
    return '/sessions'
  }
}
