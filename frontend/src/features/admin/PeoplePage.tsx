import { useMemo, useState, type MouseEvent } from 'react'
import { DataTable, Select, SelectOption, type DataTableColumn } from '@t-lingual/ui'
import type { User } from '../../api/contracts'
import { Badge, Button, Card, EmptyState, Icon, Input, LoadingState, Switch } from '../../design-system'
import { useAuth } from '../../app/auth'
import { UserAvatar } from '../../app/UserAvatar'
import { useDataTableLabels, useTablePreferences } from '../../app/dataTable'
import { useI18n } from '../../app/i18n'
import { ADMIN_LIST_LIMIT, useAdminList } from './AdminData'
import { AdminUserDrawer } from './AdminUserDrawer'
import { DefaultLimitsDialog } from './DefaultLimitsDialog'
import { useAccessUpdate } from './useAccessUpdate'
import './admin.css'

type RoleFilter = 'all' | 'admin' | 'user'
type AccessFilter = 'all' | 'active' | 'disabled'

/** Everyone with an account: who they are, what they may do, whether they may sign in. */
export function PeoplePage() {
  const { t, formatDate } = useI18n()
  const { user: currentUser } = useAuth()
  const labels = useDataTableLabels()
  const preferences = useTablePreferences('admin-people', { hidden: ['updated'] })
  const users = useAdminList('users')
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<RoleFilter>('all')
  const [access, setAccess] = useState<AccessFilter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const replace = (updated: User) => users.update((items) => items.map((item) => item.id === updated.id ? updated : item))
  const { update: updateUser, busy, dialog } = useAccessUpdate(replace)
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const [defaultsVersion, setDefaultsVersion] = useState(0)
  const open = openId ? users.items.find((user) => user.id === openId) ?? null : null
  // A click anywhere on a row opens it, except on the controls the row holds —
  // or in their menus, which React delivers here though they sit elsewhere.
  const openRow = (user: User) => (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as HTMLElement
    if (!event.currentTarget.contains(target) || target.closest('button, a, input, [role="switch"], [role="combobox"], label')) return
    setOpenId(user.id)
  }

  const search = query.trim().toLocaleLowerCase()
  const rows = useMemo(() => users.items.filter((user) =>
    (role === 'all' || user.role === role) && (access === 'all' || user.status === access)
    && (!search || `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(search))), [users.items, role, access, search])
  const counts = { admins: users.items.filter((user) => user.role === 'admin').length, disabled: users.items.filter((user) => user.status === 'disabled').length }

  const columns: DataTableColumn<User>[] = [
    { id: 'person', header: t('Person'), hideable: false, sortValue: (user) => user.displayName, cell: (user) => <button type="button" className="admin-user admin-user--button" aria-haspopup="dialog" aria-label={t('Open {name}', { name: user.displayName })} onClick={() => setOpenId(user.id)}><UserAvatar user={user} size="sm" alt="" /><div><strong><bdi>{user.displayName}</bdi>{user.id === currentUser?.id && <Badge tone="accent">{t('You')}</Badge>}</strong><small>@<bdi>{user.username}</bdi></small></div><Icon name="chevronRight" size={16} className="admin-user__open" /></button> },
    { id: 'role', header: t('Role'), sortValue: (user) => user.role, width: '190px', cell: (user) => <Select size="sm" fullWidth aria-label={t('Role for {name}', { name: user.displayName })} value={user.role} disabled={user.id === currentUser?.id || busy} onValueChange={(value) => updateUser(user, { role: value as User['role'] })}><SelectOption value="user">{t('Member')}</SelectOption><SelectOption value="admin">{t('Administrator')}</SelectOption></Select> },
    { id: 'access', header: t('Access'), sortValue: (user) => user.status, width: '150px', cell: (user) => <span className="admin-access"><Switch ariaLabel={t('Account access for {name}', { name: user.displayName })} label={t('Account access for {name}', { name: user.displayName })} checked={user.status === 'active'} disabled={user.id === currentUser?.id || busy} onChange={(enabled) => updateUser(user, { status: enabled ? 'active' : 'disabled' })} /><span aria-hidden="true">{user.status === 'disabled' ? t('Disabled') : t('Enabled')}</span></span> },
    { id: 'joined', header: t('Member since'), firstSort: 'descending', align: 'end', sortValue: (user) => user.createdAt, cell: (user) => <time className="admin-cell-date" dateTime={user.createdAt}>{formatDate(user.createdAt, { dateStyle: 'medium' })}</time> },
    { id: 'updated', header: t('Last changed'), firstSort: 'descending', align: 'end', sortValue: (user) => user.updatedAt, cell: (user) => <time className="admin-cell-date" dateTime={user.updatedAt}>{formatDate(user.updatedAt)}</time> },
  ]

  return <div className="admin-page">
    <h1 className="sr-only">{t('People')}</h1>
    <div className="admin-section-heading"><div><h2>{t('People')} <span className="admin-section-count">{t(users.items.length === 1 ? '{count} person' : '{count} people', { count: users.items.length })}{counts.admins ? ` · ${t('{count} administrators', { count: counts.admins })}` : ''}{counts.disabled ? ` · ${t('{count} disabled', { count: counts.disabled })}` : ''}</span></h2><p>{t('Open someone to see their use and change their limits, profile and preferences. Changes require your passkey.')}</p></div></div>
    <LoadingState loading={users.status === 'loading' || users.status === 'idle'} label={t('Loading people')}>
      {users.status === 'error' ? <Card><EmptyState icon="warning" title={t('People couldn’t be loaded')} description={users.error} action={<Button icon="refresh" onClick={() => void users.reload()}>{t('Try again')}</Button>} /></Card>
        : <DataTable caption={t('People')} columns={columns} rows={rows} rowKey={(user) => user.id} labels={labels} {...preferences}
          defaultSort={{ column: 'person', direction: 'ascending' }} resetPageKey={`${search}|${role}|${access}`} stackBelow={760}
          rowProps={(user) => ({ interactive: true, selected: user.id === openId, onClick: openRow(user) })}
          footerNote={!users.complete ? t('Loading more…') : users.truncated ? t('Showing the first {count}', { count: ADMIN_LIST_LIMIT }) : undefined}
          empty={<><Icon name="search" size={22} /><p>{users.items.length ? t('No matching people') : t('No people yet')}</p></>}
          toolbar={<>
            <div className="admin-search"><Input dir="auto" label={t('Search people')} icon="search" placeholder={t('Search by name or username')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            <Select aria-label={t('Role')} value={role} onValueChange={(value) => setRole(value as RoleFilter)}><SelectOption value="all">{t('All roles')}</SelectOption><SelectOption value="admin">{t('Administrators')}</SelectOption><SelectOption value="user">{t('Members')}</SelectOption></Select>
            <Select aria-label={t('Access')} value={access} onValueChange={(value) => setAccess(value as AccessFilter)}><SelectOption value="all">{t('Any access')}</SelectOption><SelectOption value="active">{t('Enabled')}</SelectOption><SelectOption value="disabled">{t('Disabled')}</SelectOption></Select>
            <Button className="admin-toolbar-end" icon="sliders" onClick={() => setDefaultsOpen(true)}>{t('Default limits')}</Button>
          </>} />}
    </LoadingState>
    <AdminUserDrawer user={open} onClose={() => setOpenId(null)} onUserChange={replace} onUserDeleted={(deleted) => users.update((items) => items.filter((item) => item.id !== deleted.id))} onUpdateAccess={updateUser} busy={busy} defaultsVersion={defaultsVersion} onEditDefaults={() => setDefaultsOpen(true)} />
    <DefaultLimitsDialog open={defaultsOpen} onClose={() => setDefaultsOpen(false)} onSaved={() => setDefaultsVersion((version) => version + 1)} />
    {dialog}
  </div>
}
