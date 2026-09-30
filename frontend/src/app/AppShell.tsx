import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Avatar, Drawer, DrawerHeader, DrawerTitle, DrawerBody, DrawerFooter, Icon as UIIcon, irisTransition } from '@t-lingual/ui'
import { Button, Dialog, Icon, useTheme, useToast } from '../design-system'
import { useI18n } from './i18n'
import { InterfaceLanguageMenu } from './i18n/InterfaceLanguageMenu'
import type { IconName } from '../design-system/icons'
import type { Workspace } from '../api/contracts'
import { useAuth } from './auth'
import { Link, matchPath, useRouter } from './router'
import { errorMessage } from './utils'
import { pageDirection, pageKey } from './pageTransition'
import { useStageControls } from './stage'
import { useWorkspaces, workspaceIcon } from './workspaces'
import { UserAvatar } from './UserAvatar'
import { SidebarStorage } from './SidebarStorage'
import { AccountStorageProvider } from './accountStorage'
import { WorkspaceDialog } from '../features/workspaces/WorkspaceDialogs'
import { adminSections } from '../features/admin/AdminRoute'
import './app.css'

/** One step of the breadcrumb; the last is the page itself. */
interface Crumb { label: string; href?: string }
export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><img className="brand__mark" src="/brand/tularity.svg" alt="" width="44" height="40" />{!compact && <span className="brand__word">t-lingual<span>by Tularity</span></span>}</span>
}
/** The theme's three modes, in the order the toggle steps through them. */
const themeOrder = ['system', 'light', 'dark'] as const
/** The mode the theme toggle steps to from `mode`. */
export const nextThemeMode = (mode: (typeof themeOrder)[number]) => themeOrder[(themeOrder.indexOf(mode) + 1) % themeOrder.length] ?? 'system'
/**
 * The colour theme, one click per step: following the system, light, dark,
 * and round again. Its icon is the mode it is in — day and night together
 * while it follows the system. A change the eye can see opens over the page
 * as a circle from the button.
 */
function ThemeToggle() {
  const { t, setThemePreference } = useI18n()
  const { mode, resolved, system } = useTheme()
  const names = { system: t('System theme'), light: t('Light'), dark: t('Dark') }
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const next = nextThemeMode(mode)
    const apply = () => flushSync(() => setThemePreference(next))
    if ((next === 'system' ? system : next) === resolved) return apply()
    const box = event.currentTarget.getBoundingClientRect()
    void irisTransition(apply, { x: box.left + box.width / 2, y: box.top + box.height / 2 })
  }
  const label = `${t('Colour theme')}: ${names[mode]}`
  return <Button variant="ghost" iconOnly className="app-preferences__trigger" aria-label={label} title={label} onClick={toggle}><Icon name={mode === 'system' ? 'sunMoon' : mode === 'dark' ? 'moon' : 'sun'} size={18} /></Button>
}
export function InterfaceMenus() {
  return <div className="app-preferences">
    <InterfaceLanguageMenu />
    <ThemeToggle />
  </div>
}
export function AppShell({ children }: { children: ReactNode }) {
  const { path, navigate } = useRouter()
  const { user, logout } = useAuth()
  const { push } = useToast()
  const { t } = useI18n()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const previousPathRef = useRef(path)
  const demo = __TLINGUAL_DEVELOPMENT_MOCK__
  const { beginSignOut, cancelSignOut } = useStageControls()
  const workspaces = useWorkspaces()
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  // The workspace the page belongs to: the one open, or the one keeping the session shown.
  const openWorkspace = matchPath('/workspaces/:workspaceId', path)?.workspaceId
  const pageWorkspace = openWorkspace ? { id: openWorkspace } : workspaces.page
  const currentWorkspace = pageWorkspace && 'id' in pageWorkspace ? workspaces.find(pageWorkspace.id) : undefined
  const inShared = path === '/shared-with-you' || Boolean(pageWorkspace && 'shared' in pageWorkspace)
  // Each page is its own element, keyed by where it is, so it mounts fresh and
  // plays its entrance; the direction is settled while rendering the move.
  const currentPage = pageKey(path)
  const [page, setPage] = useState({ key: currentPage, direction: 1 as 1 | -1 })
  if (page.key !== currentPage) setPage({ key: currentPage, direction: pageDirection(page.key, currentPage, workspaces.items.map(item => item.id)) })
  useEffect(() => setMobileOpen(false), [path])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => {
    if (previousPathRef.current === path) return
    previousPathRef.current = path
    const timer = window.setTimeout(() => { if (mainRef.current) { mainRef.current.scrollTop = 0; mainRef.current.focus({ preventScroll: true }) } }, 0)
    return () => window.clearTimeout(timer)
  }, [path])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setHelpOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const signOut = async (button: HTMLElement) => {
    if (loggingOut) return
    setLoggingOut(true)
    const box = button.getBoundingClientRect()
    beginSignOut({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
    try { await logout() }
    catch (caught) { cancelSignOut(); push({ tone: 'error', title: t('Couldn’t sign out'), message: errorMessage(caught) }) }
    finally { setLoggingOut(false) }
  }
  // A pinned workspace's pin unpins it; pinning is done from the workspace's own menus.
  const unpin = async (item: Workspace) => {
    try { await workspaces.pin(item.id, false) }
    catch (caught) { push({ tone: 'error', title: t('Couldn’t unpin workspace'), message: errorMessage(caught) }) }
  }
  const navLink = (href: string, icon: IconName, label: string, active: boolean) => <Link key={href} className="app-nav__link" data-active={active || undefined} aria-current={active ? 'page' : undefined} href={href} onClick={() => setMobileOpen(false)}><Icon name={icon} size={18} /><span dir="auto">{label}</span></Link>
  // The workspaces used most recently, up to four; past four, the rest are a
  // page of their own, and until then the last place goes to making another.
  const nav = () => <nav className="app-nav" aria-label={t("Main navigation")}>
    <p className="app-nav__label">{t("Workspaces")}</p>
    {workspaces.sidebar.map(item => item.pinnedAt
      ? <div key={item.id} className="app-nav__item" data-pinned="">{navLink(`/workspaces/${item.id}`, workspaceIcon(item), workspaces.name(item), currentWorkspace?.id === item.id)}
        <button type="button" className="app-nav__pin" aria-label={t('Unpin {name}', { name: workspaces.name(item) })} title={t('Unpin')} onClick={() => void unpin(item)}><Icon name="pin" size={16} strokeWidth={2.1} /></button></div>
      : navLink(`/workspaces/${item.id}`, workspaceIcon(item), workspaces.name(item), currentWorkspace?.id === item.id))}
    {workspaces.status === 'error' ? <button type="button" className="app-nav__link app-nav__link--quiet" onClick={() => void workspaces.refresh()}><Icon name="refresh" size={18} /><span>{t("Couldn’t load · try again")}</span></button>
      : workspaces.status === 'ready' && (workspaces.overflow ? navLink('/workspaces', 'grid', t("More workspaces"), path === '/workspaces')
        : <button type="button" className="app-nav__link app-nav__link--quiet" onClick={() => { setMobileOpen(false); setCreatingWorkspace(true) }}><Icon name="plus" size={18} /><span>{t("New workspace")}</span></button>)}
    {workspaces.hasShared && navLink('/shared-with-you', 'users', t("Shared with you"), inShared)}
    <p className="app-nav__label app-nav__label--group">{t("Account")}</p>
    {navLink('/settings', 'settings', t("Settings"), path.startsWith('/settings'))}
    {navLink('/usage', 'chart', t("Usage"), path === '/usage')}
    {user?.role === 'admin' && <>
      <p className="app-nav__label app-nav__label--group">{t("Administration")}</p>
      {adminSections.map((section) => navLink(section.path, section.icon, t(section.label), path === section.path))}
    </>}
  </nav>
  const account = () => <div className="app-sidebar__footer"><Link className="user-chip" href="/settings" onClick={() => setMobileOpen(false)} aria-label={t("Account settings")}>{user ? <UserAvatar user={user} size="sm" alt="" /> : <Avatar name={t('User')} size="sm" />}<span className="user-chip__body"><strong><bdi>{user?.displayName}</bdi></strong><small>{user?.role === 'admin' ? t('Administrator') : t('Personal account')}</small></span></Link><Button variant="ghost" icon="logout" iconOnly aria-label={t("Sign out")} loading={loggingOut} onClick={(event) => void signOut(event.currentTarget)} /></div>
  // Workspaces › the workspace › the page. The list of every workspace is a
  // step of its own only once there are more than the sidebar shows.
  const home = workspaces.recent ? `/workspaces/${workspaces.recent.id}` : '/sessions'
  const root: Crumb = { label: t("Workspaces"), href: workspaces.overflow ? '/workspaces' : undefined }
  const adminSection = adminSections.find((section) => section.path === path)
  const sessionPage = path.startsWith('/live/') ? t("Live interpretation") : path.startsWith('/sessions/') ? t("Session transcript") : null
  const crumbs: Crumb[] = path === '/workspaces' ? [{ label: t("Workspaces") }]
    : openWorkspace ? [root, { label: currentWorkspace ? workspaces.name(currentWorkspace) : '' }]
    : sessionPage && inShared ? [{ label: t("Shared with you"), href: '/shared-with-you' }, { label: sessionPage }]
    : sessionPage ? [root, ...(currentWorkspace ? [{ label: workspaces.name(currentWorkspace), href: `/workspaces/${currentWorkspace.id}` }] : []), { label: sessionPage }]
    : adminSection ? [{ label: t('Administration') }, { label: t(adminSection.label) }]
    : [{ label: t(path === '/shared-with-you' ? 'Shared with you' : path === '/setup' ? 'Quick setup' : path.startsWith('/admin') ? 'Administration' : path.startsWith('/settings') ? 'Settings' : path === '/usage' ? 'Usage' : 'Workspaces') }]
  const current = crumbs[crumbs.length - 1]!
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined
  return <AccountStorageProvider userId={user?.id}><div className="app-frame">
    <a className="skip-link" href="#main-content">{t("Skip to content")}</a>
    <aside className="app-sidebar"><button type="button" className="app-sidebar__brand" aria-label={t("Workspace guide")} title={t("Workspace guide")} onClick={() => setHelpOpen(true)}><Brand /></button>{nav()}<SidebarStorage />{account()}</aside>
    <header className="mobile-header"><Button ref={menuButtonRef} variant="ghost" icon="list" iconOnly aria-label={t("Open navigation")} aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} /><div className="mobile-header__context"><Link href={parent?.href ?? home} aria-label={parent?.href ? parent.label : t('T Lingual home')}><Brand compact /></Link><strong dir="auto">{current.label}</strong></div><InterfaceMenus /></header>
    <Drawer open={mobileOpen} onOpenChange={setMobileOpen} side="left" size="sm" closeLabel={t("Close navigation")}><DrawerHeader><DrawerTitle>{t("Mobile navigation")}</DrawerTitle></DrawerHeader><DrawerBody><button type="button" className="app-sidebar__brand" aria-label={t("Workspace guide")} title={t("Workspace guide")} onClick={() => { setMobileOpen(false); setHelpOpen(true) }}><Brand /></button>{nav()}<SidebarStorage onNavigate={() => setMobileOpen(false)} /></DrawerBody><DrawerFooter>{account()}</DrawerFooter></Drawer>
    <div className="app-topbar"><nav className="app-breadcrumb" aria-label={t("Breadcrumb")}>{crumbs.slice(0, -1).map((crumb, index) => <span key={index} className="app-breadcrumb__step">{crumb.href ? <Link href={crumb.href} dir="auto">{crumb.label}</Link> : <span dir="auto">{crumb.label}</span>}<UIIcon name="chevronRight" size={14} /></span>)}<strong aria-current="page" dir="auto">{current.label}</strong></nav><div className="app-topbar__actions">{demo && <span className="environment-label">{t("Demo workspace")}</span>}<InterfaceMenus /></div></div>
    {!online && <div className="offline-banner" role="status"><Icon name="warning" size={17} />{t("You’re offline. Live audio and changes cannot sync until the connection returns.")}</div>}
    <main ref={mainRef} id="main-content" className="app-main" tabIndex={-1}><div key={page.key} className="app-page" style={{ '--_dir': page.direction } as CSSProperties}>{children}</div></main>
    <WorkspaceDialog open={creatingWorkspace} onClose={() => setCreatingWorkspace(false)} onSaved={(created) => navigate(`/workspaces/${created.id}`)} />
    <Dialog open={helpOpen} title={t("A little help, right here")} description={t("From the first word to the final transcript.")} onClose={() => setHelpOpen(false)} footer={<><Button icon="settings" onClick={()=>{setHelpOpen(false);navigate('/setup')}}>{t('Quick setup')}</Button><Button variant="primary" onClick={() => setHelpOpen(false)}>{t("Got it")}</Button></>}>
      <div className="workspace-guide"><div><span>01</span><section><h3>{t("Set up a conversation")}</h3><p>{t("Create a session, give it a name and choose the languages you need.")}</p></section></div><div><span>02</span><section><h3>{t("Stay in the conversation")}</h3><p>{t("Start interpretation to follow speech and its translation side by side. Pause whenever you need a moment.")}</p></section></div><div><span>03</span><section><h3>{t("Take your words with you")}</h3><p>{t("Stop recording to save your words. Continue the same session whenever you need. Search, copy or export the transcript whenever you need it.")}</p></section></div>{demo && <aside><strong>{t("You’re exploring the demo")}</strong><p>{t("Audio and passkey ceremonies are simulated. Sample conversations stream automatically; your changes stay in this browser. No microphone is recorded.")}</p></aside>}</div>
    </Dialog>
  </div></AccountStorageProvider>
}
