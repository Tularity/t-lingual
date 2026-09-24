import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar, Drawer, DrawerHeader, DrawerTitle, DrawerBody, DrawerFooter, Icon as UIIcon, Kbd, Menu, MenuRadioGroup, MenuRadioItem } from '@t-lingual/ui'
import { Button, Dialog, Icon, useTheme, useToast } from '../design-system'
import { useI18n } from './i18n'
import { InterfaceLanguageMenu } from './i18n/InterfaceLanguageMenu'
import type { IconName } from '../design-system/icons'
import { useAuth } from './auth'
import { Link, useRouter } from './router'
import { errorMessage } from './utils'
import './app.css'

const mainNav: Array<{ href: string; label: string; icon: IconName; matches: (path: string) => boolean }> = [
  { href: '/sessions', label: 'Sessions', icon: 'grid', matches: (path) => path === '/' || path.startsWith('/sessions') || path.startsWith('/live') },
  { href: '/history', label: 'History', icon: 'history', matches: (path) => path.startsWith('/history') },
  { href: '/settings', label: 'Settings', icon: 'settings', matches: (path) => path.startsWith('/settings') },
]
export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><img className="brand__mark" src="/brand/tularity.svg" alt="" width="44" height="40" />{!compact && <span className="brand__word">t-lingual<span>by Tularity</span></span>}</span>
}
export function InterfaceMenus() {
  const { t, setThemePreference } = useI18n()
  const { mode, resolved, system } = useTheme()
  return <div className="app-preferences">
    <InterfaceLanguageMenu />
    <Menu aria-label={t('Colour theme')} placement="bottom-end" trigger={<Button variant="ghost" iconOnly className="app-preferences__trigger" aria-label={t('Colour theme')} title={t('Colour theme')}><Icon name={resolved === 'dark' ? 'moon' : 'sun'} size={18} /></Button>}>
      <MenuRadioGroup value={mode} onValueChange={(value) => setThemePreference(value as 'system' | 'light' | 'dark')}>
        <MenuRadioItem value="system"><span className="app-preferences__option"><Icon name={system === 'dark' ? 'moon' : 'sun'} size={17} />{t('System theme')} <small>{system === 'dark' ? t('Dark') : t('Light')}</small></span></MenuRadioItem>
        <MenuRadioItem value="light"><span className="app-preferences__option"><Icon name="sun" size={17} />{t('Light')}</span></MenuRadioItem>
        <MenuRadioItem value="dark"><span className="app-preferences__option"><Icon name="moon" size={17} />{t('Dark')}</span></MenuRadioItem>
      </MenuRadioGroup>
    </Menu>
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
  const signOut = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try { await logout() }
    catch (caught) { push({ tone: 'error', title: t('Couldn’t sign out'), message: errorMessage(caught) }) }
    finally { setLoggingOut(false) }
  }
  const nav = () => <nav className="app-nav" aria-label={t("Main navigation")}>
    <p className="app-nav__label">{t("Workspace")}</p>
    {mainNav.map(item => <Link key={item.href} className="app-nav__link" data-active={item.matches(path) || undefined} aria-current={item.matches(path) ? 'page' : undefined} href={item.href} onClick={() => setMobileOpen(false)}><Icon name={item.icon} size={18} /><span>{t(item.label)}</span>{item.matches(path) && <span className="app-nav__active" />}</Link>)}
    {user?.role === 'admin' && <><p className="app-nav__label app-nav__label--admin">{t("Manage")}</p><Link className="app-nav__link" data-active={path.startsWith('/admin') || undefined} aria-current={path.startsWith('/admin') ? 'page' : undefined} href="/admin" onClick={() => setMobileOpen(false)}><Icon name="admin" size={18} /><span>{t("Administration")}</span></Link></>}
  </nav>
  const account = () => <div className="app-sidebar__footer"><Link className="user-chip" href="/settings" onClick={() => setMobileOpen(false)} aria-label={t("Account settings")}><Avatar name={user?.displayName || t('User')} size="sm" /><span className="user-chip__body"><strong><bdi>{user?.displayName}</bdi></strong><small>{user?.role === 'admin' ? t('Administrator') : t('Personal workspace')}</small></span></Link><Button variant="ghost" icon="logout" iconOnly aria-label={t("Sign out")} loading={loggingOut} onClick={() => void signOut()} /></div>
  const pageName = path.startsWith('/live/') ? 'Live interpretation' : path.startsWith('/history/') ? 'Session transcript' : path === '/setup' ? 'Quick setup' : path.startsWith('/admin') ? 'Administration' : mainNav.find(item => item.matches(path))?.label || 'Workspace'
  const parentPage = path.startsWith('/live/') ? { href: '/sessions', label: 'Sessions' } : path.startsWith('/history/') ? { href: '/history', label: 'History' } : null
  return <div className="app-frame">
    <a className="skip-link" href="#main-content">{t("Skip to content")}</a>
    <aside className="app-sidebar"><Link className="app-sidebar__brand" href="/sessions" aria-label={t("T Lingual home")}><Brand /></Link>{nav()}<div className="app-sidebar__note"><UIIcon name="shield" size={17} /><strong>{t("Yours, by design.")}</strong><p>{t("A private space for every conversation.")}</p></div>{account()}</aside>
    <header className="mobile-header"><Button ref={menuButtonRef} variant="ghost" icon="list" iconOnly aria-label={t("Open navigation")} aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} /><div className="mobile-header__context"><Link href={parentPage?.href ?? '/sessions'} aria-label={t(parentPage?.label ?? 'T Lingual home')}><Brand compact /></Link><strong>{t(pageName)}</strong></div><InterfaceMenus /><Button variant="ghost" icon="info" iconOnly aria-label={t("Workspace guide")} onClick={() => setHelpOpen(true)} /></header>
    <Drawer open={mobileOpen} onOpenChange={setMobileOpen} side="left" size="sm" closeLabel={t("Close navigation")}><DrawerHeader><DrawerTitle>{t("Mobile navigation")}</DrawerTitle></DrawerHeader><DrawerBody><Brand />{nav()}</DrawerBody><DrawerFooter>{account()}</DrawerFooter></Drawer>
    <div className="app-topbar"><nav className="app-breadcrumb" aria-label={t("Breadcrumb")}><Link href="/sessions">{t("My workspace")}</Link><UIIcon name="chevronRight" size={14} />{parentPage && <><Link href={parentPage.href}>{t(parentPage.label)}</Link><UIIcon name="chevronRight" size={14} /></>}<strong aria-current="page">{t(pageName)}</strong></nav><div className="app-topbar__actions">{demo && <span className="environment-label"><i />{t("Demo workspace")}</span>}<InterfaceMenus /><Button variant="ghost" icon="info" iconOnly aria-label={t("Workspace guide")} onClick={() => setHelpOpen(true)} /></div></div>
    {!online && <div className="offline-banner" role="status"><Icon name="warning" size={17} />{t("You’re offline. Live audio and changes cannot sync until the connection returns.")}</div>}
    <main ref={mainRef} id="main-content" className="app-main" tabIndex={-1}>{children}</main>
    <Dialog open={helpOpen} title={t("A little help, right here")} description={t("From the first word to the final transcript.")} onClose={() => setHelpOpen(false)} footer={<><Button icon="settings" onClick={()=>{setHelpOpen(false);navigate('/setup')}}>{t('Quick setup')}</Button><Button variant="primary" onClick={() => setHelpOpen(false)}>{t("Got it")}</Button></>}>
      <div className="workspace-guide"><div><span>01</span><section><h3>{t("Set up a conversation")}</h3><p>{t("Create a session, give it a name and choose the languages you need.")}</p></section></div><div><span>02</span><section><h3>{t("Stay in the conversation")}</h3><p>{t("Start interpretation to follow speech and its translation side by side. Pause whenever you need a moment.")}</p></section></div><div><span>03</span><section><h3>{t("Take your words with you")}</h3><p>{t("Stop recording to save your words. Continue the same session whenever you need. Search, copy or export the transcript whenever you need it.")}</p></section></div>{demo && <aside><strong>{t("You’re exploring the demo")}</strong><p>{t("Audio and passkey ceremonies are simulated. Sample conversations stream automatically; your changes stay in this browser. No microphone is recorded.")}</p></aside>}<footer><Kbd>?</Kbd><span>{t("Open this guide from anywhere")}</span></footer></div>
    </Dialog>
  </div>
}
