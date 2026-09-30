import { Meter, Tooltip } from '@t-lingual/ui'
import { Icon } from '../design-system'
import { useInsightFormat } from '../features/insights/format'
import { useI18n } from './i18n'
import { Link } from './router'
import { useAccountStorage } from './accountStorage'
import './sidebar-storage.css'

/**
 * How much room the signed-in account's recordings take, above the account
 * in the sidebar: the used space against the limit, or against what is free
 * when there is no limit. Hovering or focusing it shows what the space holds;
 * it opens the usage page.
 */
export function SidebarStorage({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n()
  const format = useInsightFormat()
  const { storage } = useAccountStorage()
  if (!storage) return null
  const limited = storage.limitBytes > 0
  const available = storage.availableBytes
  // Without a limit, the meter measures against the space the account could still reach.
  const capacity = limited ? storage.limitBytes : available !== null ? storage.usedBytes + available : 0
  const full = available !== null && available <= 0
  const share = capacity > 0 ? storage.usedBytes / capacity : 0
  const summary = limited
    ? t('{used} of {limit}', { used: format.bytes(storage.usedBytes), limit: format.bytes(storage.limitBytes) })
    : t('{used} used', { used: format.bytes(storage.usedBytes) })
  const detail = full ? t('Full: new recordings can’t start')
    : available !== null ? t('{size} left', { size: format.bytes(available) })
    : t('No limit')
  const shortDetail = full ? t('Full') : detail
  const rows: Array<[string, string]> = [
    [t('Recorded audio'), format.bytes(storage.audioBytes)],
    [t('Transcripts and translations'), format.bytes(storage.transcriptBytes)],
    [t('Sessions'), storage.archivedSessions ? t('{count} ({archived} archived)', { count: format.whole(storage.sessions), archived: format.whole(storage.archivedSessions) }) : format.whole(storage.sessions)],
    [t('Sessions with recordings'), format.whole(storage.sessionsWithAudio)],
    [t('Workspaces'), t('{used} of {limit}', { used: format.whole(storage.workspaces), limit: format.whole(storage.workspaceLimit) })],
    [t('Storage limit'), limited ? format.bytes(storage.limitBytes) : t('No limit')],
    [t('Available'), available !== null ? format.bytes(available) : t('Unknown')],
  ]
  const card = <div className="storage-card">
    <strong>{t('Your storage')}</strong>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p>{limited ? t('Set by your administrator. Available space is also bounded by the server’s free disk space.') : t('No limit is set for your account; available space is the server’s free disk space.')}</p>
  </div>
  return <Tooltip content={card} placement="right" openDelay={150} className="storage-tip">
    <Link href="/usage" className="sidebar-storage" data-level={full ? 'full' : share >= 0.9 ? 'high' : undefined} onClick={onNavigate} aria-label={`${t('Storage')}: ${summary}. ${detail}`}>
      <span className="sidebar-storage__line"><Icon name="database" size={13} /><span>{summary}</span><small>{shortDetail}</small></span>
      {/* The divider above the account, drawn as far as the space is used. */}
      <Meter className="sidebar-storage__meter" label={t('Storage')} value={Math.min(storage.usedBytes, capacity)} max={Math.max(capacity, 1)} valueText={`${summary}. ${detail}`} />
    </Link>
  </Tooltip>
}
