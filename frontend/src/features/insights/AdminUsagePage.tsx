import { useEffect, useMemo, useState } from 'react'
import { BarList, DataTable, DonutChart, LineChart, SearchSelect, SegmentedControl, type DataTableColumn } from '@tular/ui'
import { api } from '../../api/client'
import type { SiteUsage, UsageReport, User } from '../../api/contracts'
import { Badge, Button, Card, EmptyState, Icon, LoadingState } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { useDataTableLabels, useTablePreferences } from '../../app/dataTable'
import { UserAvatar } from '../../app/UserAvatar'
import { errorMessage } from '../../app/utils'
import { useAdminList } from '../admin/AdminData'
import { AdminUserDrawer } from '../admin/AdminUserDrawer'
import { useAccessUpdate } from '../admin/useAccessUpdate'
import { localOffsetMinutes, useInsightFormat, type InsightFormat } from './format'
import { Allowance, InsightCard } from './InsightParts'
import { UsageCharts, UsageStats, useChartSpeech } from './UsageCharts'
import { usePeriodItems } from './UsagePage'

type Person = NonNullable<UsageReport['users']>[number]

/** Everyone's use together, or one person's, for the administrators. */
export function AdminUsagePage() {
  const { t } = useI18n()
  const format = useInsightFormat()
  const periods = usePeriodItems()
  const users = useAdminList('users')
  const [days, setDays] = useState(30)
  const [person, setPerson] = useState('')
  const [managing, setManaging] = useState<User | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${days}|${person}|${attempt}`
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: SiteUsage; error?: string; key: string }>({ status: 'loading', key })
  if (state.key !== key && state.status !== 'loading') setState({ ...state, status: 'loading', key })
  const access = useAccessUpdate((updated) => { users.update((items) => items.map((item) => item.id === updated.id ? updated : item)); setManaging((current) => current?.id === updated.id ? updated : current) })

  useEffect(() => {
    let active = true
    api.admin.usage({ days, offset: localOffsetMinutes(), user: person || undefined })
      .then((data) => { if (active) setState({ status: 'ready', data, key }) })
      .catch((caught) => { if (active) setState((current) => ({ ...current, status: 'error', error: errorMessage(caught), key })) })
    return () => { active = false }
  }, [days, person, key])

  const options = useMemo(() => [
    { value: '', label: t('Everyone'), textValue: t('Everyone'), icon: <Icon name="users" size={16} /> },
    ...users.items.map((user) => ({ value: user.id, label: <bdi>{user.displayName}</bdi>, textValue: `${user.displayName} ${user.username}`, description: `@${user.username}`, icon: <UserAvatar user={user} size="xs" alt="" /> })),
  ], [users.items, t])

  const data = state.data
  // A person's figures belong to the person asked for, not one asked for before.
  const shown = data && (person ? data.user?.id === person : !data.user) ? data : state.status === 'ready' ? data : undefined
  return <div className="insights-page">
    <header className="insights-heading">
      <div><h1>{t('Usage')}</h1><p>{t('What everyone has recorded, recognized and translated. Narrow it to one person to see their allowance.')}</p></div>
      <div className="insights-filters" role="group" aria-label={t('Filters')}>
        <SearchSelect size="sm" className="insights-person" aria-label={t('Person')} options={options} value={person} onValueChange={setPerson}
          searchLabel={t('Search people')} emptyLabel={t('No matching people')} placeholder={t('Everyone')} />
        <SegmentedControl size="sm" aria-label={t('Period')} items={periods} value={String(days)} onChange={(value) => setDays(Number(value))} />
      </div>
    </header>
    {!shown && state.status === 'error'
      ? <Card><EmptyState icon="warning" title={t('Usage couldn’t be loaded')} description={state.error ?? ''} action={<Button icon="refresh" onClick={() => setAttempt((value) => value + 1)}>{t('Try again')}</Button>} /></Card>
      : !shown ? <LoadingState label={t('Loading usage')} />
      : <div className="insights-body" aria-busy={state.status === 'loading' || undefined} data-stale={state.status === 'loading' || undefined}>
        {shown.user ? <PersonHeader data={shown} format={format} onManage={() => setManaging(users.items.find((user) => user.id === shown.user?.id) ?? shown.user ?? null)} onClear={() => setPerson('')} /> : null}
        <UsageStats report={shown.report} format={format} site={!shown.user} />
        <UsageCharts report={shown.report} format={format} site extra={shown.user ? null : <SiteCharts report={shown.report} format={format} onPick={setPerson} />} />
      </div>}
    <AdminUserDrawer user={managing} onClose={() => setManaging(null)} onUserChange={(updated) => { users.update((items) => items.map((item) => item.id === updated.id ? updated : item)); setManaging(updated) }}
      onUserDeleted={(deleted) => { users.update((items) => items.filter((item) => item.id !== deleted.id)); setPerson(''); setAttempt((value) => value + 1) }}
      onUpdateAccess={access.update} busy={access.busy} />
    {access.dialog}
  </div>
}

function PersonHeader({ data, format, onManage, onClear }: { data: SiteUsage; format: InsightFormat; onManage: () => void; onClear: () => void }) {
  const { t } = useI18n()
  const user = data.user!
  return <div className="insights-grid">
    <InsightCard span={12} className="insight-person" title={<span className="insight-person__name"><UserAvatar user={user} size="md" alt="" /><span><bdi>{user.displayName}</bdi><small>@<bdi>{user.username}</bdi></small></span>
      {user.role === 'admin' ? <Badge tone="accent">{t('Administrator')}</Badge> : null}{user.status === 'disabled' ? <Badge tone="danger">{t('Disabled')}</Badge> : null}</span>}
      actions={<div className="insight-person__actions"><Button size="sm" icon="close" onClick={onClear}>{t('Everyone')}</Button><Button size="sm" variant="primary" icon="sliders" onClick={onManage}>{t('Manage account')}</Button></div>}>
      {data.limits && data.standing ? <Allowance limits={data.limits} standing={data.standing} format={format} /> : null}
    </InsightCard>
  </div>
}

const FAILURES: Record<string, string> = {
  translator_unavailable: 'Translation service unavailable',
  capacity_exhausted: 'Translation service at capacity',
  engine_unavailable: 'Translation engine unavailable',
  source_language_unsupported: 'Language not supported',
  target_language_unsupported: 'Language not supported',
  interrupted: 'Interrupted',
  busy: 'Translation service busy',
}
const STATUSES: Record<string, string> = { completed: 'Completed', archived: 'Archived', failed: 'Failed', created: 'Not started', live: 'Recording now', recording: 'Recording now' }

/** What only the whole site shows: who is active, what fails, how sessions end, and who uses most. */
function SiteCharts({ report, format, onPick }: { report: UsageReport; format: InsightFormat; onPick: (id: string) => void }) {
  const { t, formatDate } = useI18n()
  const speech = useChartSpeech()
  const labels = useDataTableLabels()
  const preferences = useTablePreferences('admin-usage-people', { pageSize: 10 })
  const dates = report.days.map((day) => day.date)
  const failures = report.days.reduce((sum, day) => sum + day.translationFailures, 0)
  const columns: DataTableColumn<Person>[] = [
    { id: 'person', header: t('Person'), hideable: false, sortValue: (row) => row.displayName, cell: (row) => <button type="button" className="admin-user admin-user--button" onClick={() => onPick(row.id)}>
      <UserAvatar user={{ id: row.id, displayName: row.displayName, avatarVersion: row.avatarVersion }} size="sm" alt="" /><div><strong><bdi>{row.displayName}</bdi></strong><small>@<bdi>{row.username}</bdi></small></div></button> },
    { id: 'recorded', header: t('Recorded'), align: 'end', firstSort: 'descending', sortValue: (row) => row.recordedSeconds, cell: (row) => <span className="admin-nowrap">{format.duration(row.recordedSeconds)}</span> },
    { id: 'sessions', header: t('Sessions'), align: 'end', firstSort: 'descending', sortValue: (row) => row.sessions, cell: (row) => format.whole(row.sessions) },
    { id: 'translations', header: t('Translations'), align: 'end', firstSort: 'descending', sortValue: (row) => row.translations, cell: (row) => format.whole(row.translations) },
    { id: 'storage', header: t('Storage'), align: 'end', firstSort: 'descending', sortValue: (row) => row.storageBytes, cell: (row) => <span className="admin-nowrap">{format.bytes(row.storageBytes)}</span> },
    { id: 'seen', header: t('Last seen'), align: 'end', firstSort: 'descending', sortValue: (row) => row.lastSeen ?? '', cell: (row) => row.lastSeen ? <time className="admin-cell-date" dateTime={row.lastSeen}>{formatDate(row.lastSeen)}</time> : <span className="admin-cell-none">{t('Never')}</span> },
  ]
  return <>
    <InsightCard span={8} title={t('People each day')} description={t('Who recorded, who signed in, and guests who opened a link.')}>
      <LineChart label={t('People each day')} x={dates} formatX={(value) => format.day(String(value))} formatY={format.whole} height={200} describeSeries={speech.line} xTicks={6}
        series={[
          { id: 'active', label: t('Recorded'), values: report.days.map((day) => day.activeUsers ?? 0), area: true },
          { id: 'signins', label: t('Signed in'), values: report.days.map((day) => day.signIns ?? 0) },
          { id: 'guests', label: t('Guest visits'), values: report.days.map((day) => day.guestViews ?? 0), dashed: true },
        ]} />
    </InsightCard>
    <InsightCard span={4} title={t('How sessions ended')} description={t('Sessions started in this period.')}>
      <DonutChart label={t('How sessions ended')} formatValue={format.whole} emptyLabel={t('No sessions in this period')}
        items={(report.sessionStatuses ?? []).map((slice) => ({ id: slice.key, label: t(STATUSES[slice.key] ?? slice.key), textLabel: t(STATUSES[slice.key] ?? slice.key), value: slice.count ?? slice.value,
          color: slice.key === 'failed' ? 'var(--tl-danger-solid)' : undefined }))} />
    </InsightCard>
    <InsightCard span={6} title={t('Translation failures')} description={failures ? t('{count} translations failed in this period.', { count: format.whole(failures) }) : t('No translation failed in this period.')}>
      <LineChart label={t('Translation failures')} x={dates} formatX={(value) => format.day(String(value))} formatY={format.whole} height={150} describeSeries={speech.line} xTicks={5} legend={false}
        series={[{ id: 'failures', label: t('Failed'), values: report.days.map((day) => day.translationFailures), color: 'var(--tl-danger-solid)', area: true }]} />
    </InsightCard>
    <InsightCard span={6} title={t('Why translations failed')} description={t('Failures waiting for the service are tried again once it is back.')}>
      <BarList label={t('Why translations failed')} formatValue={format.whole} emptyLabel={t('Nothing failed')}
        items={(report.translationFailures ?? []).map((slice) => ({ id: slice.key, label: t(FAILURES[slice.key] ?? slice.key), description: FAILURES[slice.key] ? slice.key : undefined, value: slice.count ?? slice.value, color: 'var(--tl-danger-solid)' }))} />
    </InsightCard>
    <InsightCard span={12} title={t('People')} description={t('Choose someone to see their use alone and manage their account.')}>
      <DataTable caption={t('People')} columns={columns} rows={report.users ?? []} rowKey={(row) => row.id} labels={labels} {...preferences}
        defaultSort={{ column: 'recorded', direction: 'descending' }} stackBelow={760}
        empty={<><Icon name="users" size={22} /><p>{t('No people yet')}</p></>} />
    </InsightCard>
  </>
}
