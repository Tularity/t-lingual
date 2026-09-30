import { Avatar, type AvatarProps } from '@t-lingual/ui'
import { api } from '../api/client'
import type { User } from '../api/contracts'

/**
 * A person's picture, or their initials while they have none or it cannot be
 * read. Beside a session, `sessionId` reads it as someone who may see that
 * session — the way the people sharing it see each other.
 */
export function UserAvatar({ user, sessionId, ...props }: { user: Pick<User, 'id' | 'displayName' | 'avatarVersion'>; sessionId?: string } & Omit<AvatarProps, 'name' | 'src'>) {
  const version = user.avatarVersion
  const src = version ? (sessionId ? api.sharing.personAvatarUrl(sessionId, user.id, version) : api.account.avatarUrl(user.id, version)) || undefined : undefined
  return <Avatar name={user.displayName} src={src} {...props} />
}
