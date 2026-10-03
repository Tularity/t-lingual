import { Avatar, AvatarGroup, Popover, Tooltip } from '@tular/ui'
import type { Presence, PresenceList } from '../../api/contracts'
import { useI18n } from '../../app/i18n'
import { UserAvatar } from '../../app/UserAvatar'
import { Icon } from '../../design-system'
import './presence.css'

/** Faces shown before the rest are counted. */
const VISIBLE = 4

/**
 * Who else has the session open, by their faces alone: each is named on
 * hover, and the whole list — past the "+N" too — opens on a click. Guests
 * have no picture and no name, so they share one plain face. Nothing shows
 * while nobody else is here.
 */
export function PresenceStack({ sessionId, presence }: { sessionId: string; presence?: PresenceList }) {
  const { t } = useI18n()
  const people = presence?.people ?? []
  const others = people.filter((person) => !person.isMe)
  if (!presence || others.length === 0) return null
  const ordered = [...others, ...people.filter((person) => person.isMe)]
  const unseen = Math.max(0, presence.total - people.length)
  const name = (person: Presence) => person.kind === 'guest' ? t('Guest') : person.name
  const describe = (person: Presence) => [person.isMe ? t('{name} (you)', { name: name(person) }) : name(person), person.recording ? t('Recording') : ''].filter(Boolean).join(' · ')
  const face = (person: Presence, alt: string) => person.kind === 'user' && person.userId
    ? <UserAvatar user={{ id: person.userId, displayName: person.name, avatarVersion: person.avatarVersion }} sessionId={sessionId} alt={alt} data-recording={person.recording || undefined} />
    : <Avatar name={t('Guest')} alt={alt} fallback={<Icon name="user" size={15} />} data-guest="" data-recording={person.recording || undefined} />
  return <Popover placement="bottom-end" className="presence-panel" aria-label={t('Here now')} trigger={
    <button type="button" className="presence" aria-label={t('{count} people here', { count: presence.total })}>
      <AvatarGroup size="md" max={VISIBLE} total={presence.total} overflowLabel={(count) => t('{count} more', { count })}>
        {ordered.map((person) => <Tooltip key={person.key} content={describe(person)} placement="bottom">{face(person, describe(person))}</Tooltip>)}
      </AvatarGroup>
    </button>
  }>
    <p className="presence-panel__title">{t('Here now')}</p>
    <ul className="presence-panel__list">
      {ordered.map((person) => <li key={person.key}>
        {face(person, '')}
        <span className="presence-panel__name" dir="auto">{name(person)}</span>
        {person.isMe && <small>{t('You')}</small>}
        {person.recording && <small data-recording="">{t('Recording')}</small>}
      </li>)}
    </ul>
    {unseen > 0 && <p className="presence-panel__more">{t('And {count} more', { count: unseen })}</p>}
  </Popover>
}
