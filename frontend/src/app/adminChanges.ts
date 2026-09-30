/** A change an administrator makes to someone else's account. */
export type AdminChangeKind = 'limits' | 'profile' | 'settings'

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The exact body of one change to one account, and the passkey scope that
 * authorizes only that body: the server hashes what it receives and accepts
 * the authorization only if the digests match, so the body must be sent as
 * serialized here, not serialized again.
 */
export async function adminChange(kind: AdminChangeKind, userId: string, value: unknown) {
  const body = JSON.stringify(value)
  return { body, scope: `admin:user:${kind}:${userId}:${await sha256(body)}` }
}

/** The passkey scope for removing exactly one passkey or signed-in browser of one account. */
export async function adminRemovalScope(kind: 'passkey' | 'session', userId: string, targetId: string) {
  return `admin:user:${kind}:${userId}:${await sha256(targetId)}`
}

/** The exact body of a change to the default limits, and the scope that authorizes only it. */
export async function defaultLimitsChange(value: unknown) {
  const body = JSON.stringify(value)
  return { body, scope: `admin:limits:update:${await sha256(body)}` }
}
