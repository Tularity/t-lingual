import type { AuditEvent, Invitation, User } from '../../api/contracts'
import { describeDevice } from '../../app/deviceName'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Where an access code stands at `now`. */
export type CodeStatus = 'scheduled' | 'active' | 'used' | 'expired' | 'revoked'

export function invitationCreateScope(expiresInHours: number) { return `admin:invitation:create:${expiresInHours}` }
export function invitationRevokeScope(invitationId: string) { return `admin:invitation:revoke:${invitationId}` }
export function userUpdateScope(userId: string, input: Partial<Pick<User, 'role' | 'status'>>) { return `admin:user:update:${userId}:${input.role ?? '-'}:${input.status ?? '-'}` }
export function userDeleteScope(userId: string) { return `admin:user:delete:${userId}` }

export function invitationStatus(invitation: Invitation, now = Date.now()): CodeStatus {
  if (invitation.revokedAt) return 'revoked'
  if (invitation.usedAt) return 'used'
  if (new Date(invitation.expiresAt).getTime() <= now) return 'expired'
  if (invitation.notBefore && new Date(invitation.notBefore).getTime() > now) return 'scheduled'
  return 'active'
}

/** When a code starts working: its own start, or the moment it was made. */
export function invitationStart(invitation: Invitation) {
  return invitation.notBefore ?? invitation.createdAt
}

/**
 * A stable number for each code, in the order they were made — so a code
 * keeps its number however the list is sorted or filtered, and a new code
 * never renumbers the old ones. The internal identifier is never shown.
 */
export function numberCodes(invitations: readonly Invitation[]): Map<string, number> {
  const ordered = [...invitations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return new Map(ordered.map((invitation, index) => [invitation.id, index + 1]))
}

export function summarizeAuditMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return ''
  return Object.entries(metadata as Record<string, unknown>).slice(0, 3).map(([key, value]) => {
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/gu, '').slice(0, 30)
    const rendered = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).slice(0, 80) : value === null ? 'null' : '[details]'
    return `${safeKey}: ${rendered}`
  }).join(' · ')
}

/** The kind of thing an audit event is about, for filtering. */
export type AuditKind = 'codes' | 'accounts' | 'settings'
export function auditKind(event: AuditEvent): AuditKind {
  if (event.action.startsWith('invitation.')) return 'codes'
  if (event.action.startsWith('user.')) return 'accounts'
  return 'settings'
}

export function actionTitle(action: string, t: Translate) {
  const names: Record<string, string> = {
    'invitation.create': 'Access code created', 'invitation.revoke': 'Access code revoked', 'invitation.use': 'Access code redeemed',
    'site_settings.update': 'Site settings saved', 'provider.update': 'Engines updated',
    'user.role.set': 'Role changed', 'user.status.set': 'Account access changed',
    'user.limits.set': 'Limits changed', 'user.profile.update': 'Profile corrected', 'user.settings.update': 'Preferences changed',
    'user.passkey.delete': 'Passkey removed', 'user.session.revoke': 'Browser signed out', 'limits.defaults.set': 'Default limits changed',
    'user.delete': 'Account deleted',
  }
  return names[action] ? t(names[action]) : action.replace(/[._]/gu, ' ').replace(/^./u, (letter) => letter.toUpperCase())
}

export function auditDetail(event: AuditEvent, t: Translate, localDate: (value: string) => string) {
  if (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) return ''
  const metadata = event.metadata as Record<string, unknown>
  if (event.action === 'user.role.set' && (metadata.role === 'admin' || metadata.role === 'user')) return t('Role set to {role}', { role: metadata.role === 'admin' ? t('Administrator') : t('Member') })
  if (event.action === 'user.status.set' && (metadata.status === 'active' || metadata.status === 'disabled')) return t('Access {status}', { status: metadata.status === 'active' ? t('enabled') : t('disabled') })
  if (event.action === 'user.limits.set' || event.action === 'limits.defaults.set') {
    const names: Array<[string, string]> = [['concurrentRecordings', 'Recordings at once'], ['monthlyRecordingMinutes', 'Recording minutes a month'], ['storageMb', 'Storage in MB'], ['workspaces', 'Workspaces'], ['guestLinks', 'Links for guests']]
    const set = names.filter(([key]) => metadata[key] !== null && metadata[key] !== undefined)
      .map(([key, label]) => `${t(label)}: ${typeof metadata[key] === 'boolean' ? t(metadata[key] ? 'Allowed' : 'Not allowed') : String(metadata[key]).slice(0, 12)}`)
    return set.length ? set.join(' · ') : t('Every limit back to the default')
  }
  if (event.action === 'user.delete') {
    const username = typeof metadata.username === 'string' ? `@${metadata.username.slice(0, 40)}` : ''
    const sessions = typeof metadata.sessions === 'number' ? t(metadata.sessions === 1 ? '{count} session' : '{count} sessions', { count: metadata.sessions }) : ''
    return [username, sessions].filter(Boolean).join(' · ')
  }
  if (event.action === 'user.passkey.delete') {
    const name = typeof metadata.name === 'string' ? metadata.name.slice(0, 60) : ''
    const left = typeof metadata.remaining === 'number' ? metadata.remaining : null
    return [name, left === 0 ? t('It was their last passkey') : left !== null ? t(left === 1 ? '{count} passkey left' : '{count} passkeys left', { count: left }) : ''].filter(Boolean).join(' · ')
  }
  if (event.action === 'user.session.revoke' && typeof metadata.userAgent === 'string' && metadata.userAgent) {
    const device = describeDevice(metadata.userAgent)
    return 'raw' in device ? device.raw : t('{browser} on {system}', device)
  }
  if (event.action === 'invitation.create' && typeof metadata.expiresAt === 'string' && Number.isFinite(Date.parse(metadata.expiresAt))) return t('Expires {date}', { date: localDate(metadata.expiresAt) })
  return ''
}

/** "3 h", "2 d", "45 min": how far away `target` is from `now`, rounded to one unit. */
export function durationWords(milliseconds: number, t: Translate) {
  const minutes = Math.max(1, Math.round(Math.abs(milliseconds) / 60_000))
  if (minutes < 60) return t('{count} min', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('{count} h', { count: hours })
  return t('{count} d', { count: Math.round(hours / 24) })
}
