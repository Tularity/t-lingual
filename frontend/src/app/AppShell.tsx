import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Avatar, Drawer, DrawerHeader, DrawerTitle, DrawerBody, DrawerFooter, Icon as UIIcon, Kbd, irisTransition } from '@t-lingual/ui'
import { Button, Dialog, Icon, useTheme, useToast } from '../design-system'
import { useI18n } from './i18n'
import { InterfaceLanguageMenu } from './i18n/InterfaceLanguageMenu'
import type { IconName } from '../design-system/icons'
import { useAuth } from './auth'
import { Link, useRouter } from './router'
import { errorMessage } from './utils'
import { pageDirection, pageKey } from './pageTransition'
import { useSignOutStage } from './stage'
import './app.css'

const mainNav: Array<{ href: string; label: string; icon: IconName; matches: (path: string) => boolean }> = [
  { href: '/sessions', label: 'Sessions', icon: 'grid', matches: (path) => path === '/' || path.startsWith('/sessions') || path.startsWith('/live') },
  { href: '/history', label: 'History', icon: 'history', matches: (path) => path.startsWith('/history') },
  { href: '/settings', label: 'Settings', icon: 'settings', matches: (path) => path.startsWith('/settings') },
]
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
  const { beginSignOut, cancelSignOut } = useSignOutStage()
  // Each page is its own element, keyed by where it is, so it mounts fresh and
  // plays its entrance; the direction is settled while rendering the move.
  const currentPage = pageKey(path)
  const [page, setPage] = useState({ key: currentPage, direction: 1 as 1 | -1 })
  if (page.key !== currentPage) setPage({ key: currentPage, direction: pageDirection(page.key, currentPage) })
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
  const nav = () => <nav className="app-nav" aria-label={t("Main navigation")}>
    <p className="app-nav__label">{t("Workspace")}</p>
    {mainNav.map(item => <Link key={item.href} className="app-nav__link" data-active={item.matches(path) || undefined} aria-current={item.matches(path) ? 'page' : undefined} href={item.href} onClick={() => setMobileOpen(false)}><Icon name={item.icon} size={18} /><span>{t(item.label)}</span></Link>)}
    {user?.role === 'admin' && <><p className="app-nav__label app-nav__label--admin">{t("Manage")}</p><Link className="app-nav__link" data-active={path.startsWith('/admin') || undefined} aria-current={path.startsWith('/admin') ? 'page' : undefined} href="/admin" onClick={() => setMobileOpen(false)}><Icon name="admin" size={18} /><span>{t("Administration")}</span></Link></>}
  </nav>
  const account = () => <div className="app-sidebar__footer"><Link className="user-chip" href="/settings" onClick={() => setMobileOpen(false)} aria-label={t("Account settings")}><Avatar name={user?.displayName || t('User')} size="sm" /><span className="user-chip__body"><strong><bdi>{user?.displayName}</bdi></strong><small>{user?.role === 'admin' ? t('Administrator') : t('Personal workspace')}</small></span></Link><Button variant="ghost" icon="logout" iconOnly aria-label={t("Sign out")} loading={loggingOut} onClick={(event) => void signOut(event.currentTarget)} /></div>
  const pageName = path.startsWith('/live/') ? 'Live interpretation' : path.startsWith('/history/') ? 'Session transcript' : path === '/setup' ? 'Quick setup' : path.startsWith('/admin') ? 'Administration' : mainNav.find(item => item.matches(path))?.label || 'Workspace'
  const parentPage = path.startsWith('/live/') ? { href: '/sessions', label: 'Sessions' } : path.startsWith('/history/') ? { href: '/history', label: 'History' } : null
  return <div className="app-frame">
    <a className="skip-link" href="#main-content">{t("Skip to content")}</a>
    <aside className="app-sidebar"><button type="button" className="app-sidebar__brand" aria-label={t("Workspace guide")} title={t("Workspace guide")} onClick={() => setHelpOpen(true)}><Brand /></button>{nav()}<div className="app-sidebar__note"><UIIcon name="shield" size={17} /><strong>{t("Yours, by design.")}</strong><p>{t("A private space for every conversation.")}</p></div>{account()}</aside>
    <header className="mobile-header"><Button ref={menuButtonRef} variant="ghost" icon="list" iconOnly aria-label={t("Open navigation")} aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} /><div className="mobile-header__context"><Link href={parentPage?.href ?? '/sessions'} aria-label={t(parentPage?.label ?? 'T Lingual home')}><Brand compact /></Link><strong>{t(pageName)}</strong></div><InterfaceMenus /></header>
    <Drawer open={mobileOpen} onOpenChange={setMobileOpen} side="left" size="sm" closeLabel={t("Close navigation")}><DrawerHeader><DrawerTitle>{t("Mobile navigation")}</DrawerTitle></DrawerHeader><DrawerBody><button type="button" className="app-sidebar__brand" aria-label={t("Workspace guide")} title={t("Workspace guide")} onClick={() => { setMobileOpen(false); setHelpOpen(true) }}><Brand /></button>{nav()}</DrawerBody><DrawerFooter>{account()}</DrawerFooter></Drawer>
    <div className="app-topbar"><nav className="app-breadcrumb" aria-label={t("Breadcrumb")}><Link href="/sessions">{t("My workspace")}</Link><UIIcon name="chevronRight" size={14} />{parentPage && <><Link href={parentPage.href}>{t(parentPage.label)}</Link><UIIcon name="chevronRight" size={14} /></>}<strong aria-current="page">{t(pageName)}</strong></nav><div className="app-topbar__actions">{demo && <span className="environment-label">{t("Demo workspace")}</span>}<InterfaceMenus /></div></div>
    {!online && <div className="offline-banner" role="status"><Icon name="warning" size={17} />{t("You’re offline. Live audio and changes cannot sync until the connection returns.")}</div>}
    <main ref={mainRef} id="main-content" className="app-main" tabIndex={-1}><div key={page.key} className="app-page" style={{ '--_dir': page.direction } as CSSProperties}>{children}</div></main>
    <Dialog open={helpOpen} title={t("A little help, right here")} description={t("From the first word to the final transcript.")} onClose={() => setHelpOpen(false)} footer={<><Button icon="settings" onClick={()=>{setHelpOpen(false);navigate('/setup')}}>{t('Quick setup')}</Button><Button variant="primary" onClick={() => setHelpOpen(false)}>{t("Got it")}</Button></>}>
      <div className="workspace-guide"><div><span>01</span><section><h3>{t("Set up a conversation")}</h3><p>{t("Create a session, give it a name and choose the languages you need.")}</p></section></div><div><span>02</span><section><h3>{t("Stay in the conversation")}</h3><p>{t("Start interpretation to follow speech and its translation side by side. Pause whenever you need a moment.")}</p></section></div><div><span>03</span><section><h3>{t("Take your words with you")}</h3><p>{t("Stop recording to save your words. Continue the same session whenever you need. Search, copy or export the transcript whenever you need it.")}</p></section></div>{demo && <aside><strong>{t("You’re exploring the demo")}</strong><p>{t("Audio and passkey ceremonies are simulated. Sample conversations stream automatically; your changes stay in this browser. No microphone is recorded.")}</p></aside>}<footer><Kbd>?</Kbd><span>{t("Open this guide from anywhere")}</span></footer></div>
    </Dialog>
  </div>
}
