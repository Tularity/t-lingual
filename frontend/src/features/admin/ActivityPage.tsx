import { useMemo, useState } from 'react'
import { DataTable, Select, SelectOption, type DataTableColumn } from '@t-lingual/ui'
import type { AuditEvent } from '../../api/contracts'
import { Button, Card, EmptyState, Icon, Input, LoadingState } from '../../design-system'
import { useDataTableLabels, useTablePreferences } from '../../app/dataTable'
import { useI18n } from '../../app/i18n'
import { ADMIN_LIST_LIMIT, useAdminList } from './AdminData'
import { actionTitle, auditDetail, auditKind, numberCodes, type AuditKind } from './adminModel'
import './admin.css'

const kindIcons = { codes: 'key', accounts: 'user', settings: 'settings' } as const

/** What administrators have changed, newest first, with who changed it. */
export function ActivityPage() {
  const { t, formatDate } = useI18n()
  const labels = useDataTableLabels()
  const preferences = useTablePreferences('admin-activity')
  const audit = useAdminList('audit')
  const users = useAdminList('users')
  const invites = useAdminList('invites')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AuditKind | 'all'>('all')
  const numbers = useMemo(() => numberCodes(invites.items), [invites.items])
  const person = (id: string | null) => id ? users.items.find((user) => user.id === id)?.displayName ?? t('A user') : t('Container CLI')
  const target = (event: AuditEvent) => {
    if (event.targetType === 'user') return person(event.targetId)
    if (event.targetType === 'invitation') {
      const number = numbers.get(event.targetId)
      return number ? t('Access code #{number}', { number }) : t('An access code')
    }
    return t(event.targetType === 'site_settings' ? 'Site settings' : event.targetType === 'provider' ? 'Engines' : event.targetType.replace(/[_-]/gu, ' '))
  }
  const search = query.trim().toLocaleLowerCase()
  const rows = audit.items.filter((event) => (kind === 'all' || auditKind(event) === kind)
    && (!search || `${actionTitle(event.action, t)} ${target(event)} ${person(event.actorUserId)}`.toLocaleLowerCase().includes(search)))

  const columns: DataTableColumn<AuditEvent>[] = [
    { id: 'event', header: t('Event'), hideable: false, sortValue: (event) => actionTitle(event.action, t), cell: (event) => <div className="admin-event"><span aria-hidden="true"><Icon name={kindIcons[auditKind(event)]} size={16} /></span><div><strong>{actionTitle(event.action, t)}</strong>{auditDetail(event, t, formatDate) && <small>{auditDetail(event, t, formatDate)}</small>}</div></div> },
    { id: 'target', header: t('About'), sortValue: target, cell: (event) => <bdi>{target(event)}</bdi> },
    { id: 'actor', header: t('By'), sortValue: (event) => person(event.actorUserId), cell: (event) => <bdi>{person(event.actorUserId)}</bdi> },
    { id: 'time', header: t('When'), firstSort: 'descending', sortValue: (event) => event.createdAt, align: 'end', cell: (event) => <time className="admin-cell-date" dateTime={event.createdAt}>{formatDate(event.createdAt)}</time> },
  ]

  return <div className="admin-page">
    <h1 className="sr-only">{t('Activity')}</h1>
    <div className="admin-section-heading"><div><h2>{t('Activity')} <span className="admin-section-count">{t(audit.items.length === 1 ? '{count} event' : '{count} events', { count: audit.items.length })}</span></h2><p>{t('Access codes, accounts and settings changed by administrators, as the server recorded them.')}</p></div></div>
    <LoadingState loading={audit.status === 'loading' || audit.status === 'idle'} label={t('Loading activity')}>
      {audit.status === 'error' ? <Card><EmptyState icon="warning" title={t('Activity couldn’t be loaded')} description={audit.error} action={<Button icon="refresh" onClick={() => void audit.reload()}>{t('Try again')}</Button>} /></Card>
        : <DataTable caption={t('Activity')} columns={columns} rows={rows} rowKey={(event) => event.id} labels={labels} {...preferences}
          defaultSort={{ column: 'time', direction: 'descending' }} resetPageKey={`${search}|${kind}`} stackBelow={760}
          footerNote={!audit.complete ? t('Loading more…') : audit.truncated ? t('Showing the latest {count}', { count: ADMIN_LIST_LIMIT }) : undefined}
          empty={<><Icon name="history" size={22} /><p>{audit.items.length ? t('No activity in this view') : t('No activity yet')}</p></>}
          toolbar={<>
            <div className="admin-search"><Input dir="auto" label={t('Search activity')} icon="search" placeholder={t('Search by event, person or code')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            <Select aria-label={t('Kind of activity')} value={kind} onValueChange={(value) => setKind(value as AuditKind | 'all')}><SelectOption value="all">{t('All activity')}</SelectOption><SelectOption value="codes">{t('Access codes')}</SelectOption><SelectOption value="accounts">{t('Accounts')}</SelectOption><SelectOption value="settings">{t('Settings')}</SelectOption></Select>
          </>} />}
    </LoadingState>
  </div>
}
