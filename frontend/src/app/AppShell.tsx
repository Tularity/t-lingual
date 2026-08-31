import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon, useToast } from '../design-system'
import type { IconName } from '../design-system/icons'
import { useAuth } from './auth'
import { Link, useRouter } from './router'
import { errorMessage } from './utils'
import './app.css'

const mainNav: Array<{ href: string; label: string; icon: IconName; matches: (path: string) => boolean }> = [
  { href: '/sessions', label: 'Sessions', icon: 'home', matches: (path) => path === '/' || path.startsWith('/sessions') || path.startsWith('/live') },
  { href: '/history', label: 'History', icon: 'history', matches: (path) => path.startsWith('/history') },
  { href: '/settings', label: 'Settings', icon: 'settings', matches: (path) => path.startsWith('/settings') },
]

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><span className="brand__mark" aria-hidden="true"><span /><span /><span /></span>{!compact && <span className="brand__word">T Lingual</span>}</span>
}

export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useRouter()
  const { user, logout } = useAuth()
  const { push } = useToast()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const drawerCloseRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const previousPathRef = useRef(path)
  useEffect(() => setMobileOpen(false), [path])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => {
    if (!mobileOpen) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusTimer = window.setTimeout(() => drawerCloseRef.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileOpen(false)
        return
      }
      if (event.key !== 'Tab' || !drawerRef.current) return
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && (document.activeElement === first || !drawerRef.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !drawerRef.current.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.body.classList.add('mobile-drawer-open')
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('mobile-drawer-open')
      previouslyFocused?.focus()
    }
  }, [mobileOpen])
  useEffect(() => {
    if (previousPathRef.current === path) return
    previousPathRef.current = path
    const focusTimer = window.setTimeout(() => mainRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [path])
  const signOut = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logout()
    } catch (caught) {
      push({ tone: 'error', title: 'Couldn’t sign out', message: errorMessage(caught) })
    } finally {
      setLoggingOut(false)
    }
  }
  const nav = (mobile = false) => <>
    <nav className="app-nav" aria-label="Main navigation">
      {mainNav.map((item) => <Link key={item.href} className="app-nav__link" data-active={item.matches(path) || undefined} aria-current={item.matches(path) ? 'page' : undefined} href={item.href} onClick={() => { if (mobile) setMobileOpen(false) }}><Icon name={item.icon} size={19} /><span>{item.label}</span></Link>)}
      {user?.role === 'admin' && <Link className="app-nav__link" data-active={path.startsWith('/admin') || undefined} aria-current={path.startsWith('/admin') ? 'page' : undefined} href="/admin" onClick={() => { if (mobile) setMobileOpen(false) }}><Icon name="admin" size={19} /><span>Administration</span></Link>}
    </nav>
    <div className="app-sidebar__footer">
      <div className="user-chip"><span className="user-chip__avatar">{user?.displayName.charAt(0).toUpperCase()}</span><span className="user-chip__body"><strong><bdi>{user?.displayName}</bdi></strong><small>@<bdi>{user?.username}</bdi></small></span></div>
      <Button variant="ghost" icon="logout" iconOnly aria-label="Sign out" loading={loggingOut} onClick={() => void signOut()} />
    </div>
    {mobile && <div className="mobile-nav-safe" />}
  </>
  return <div className="app-frame">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="app-sidebar" inert={mobileOpen || undefined} aria-hidden={mobileOpen || undefined}><Link className="app-sidebar__brand" href="/sessions"><Brand /></Link>{nav()}</aside>
    <header className="mobile-header" inert={mobileOpen || undefined} aria-hidden={mobileOpen || undefined}><Button ref={menuButtonRef} variant="ghost" icon="more" iconOnly aria-label="Open navigation" aria-controls={mobileOpen ? 'mobile-navigation' : undefined} aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} /><Link href="/sessions"><Brand /></Link><span className="mobile-header__spacer" /></header>
    {mobileOpen && <div className="mobile-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false) }}><aside ref={drawerRef} id="mobile-navigation" className="mobile-drawer" role="dialog" aria-modal="true" aria-label="Mobile navigation"><div className="mobile-drawer__header"><Brand /><Button ref={drawerCloseRef} variant="ghost" icon="close" iconOnly aria-label="Close navigation" onClick={() => setMobileOpen(false)} /></div>{nav(true)}</aside></div>}
    {!online && <div className="offline-banner" role="status" inert={mobileOpen || undefined} aria-hidden={mobileOpen || undefined}><Icon name="warning" size={17} />You’re offline. Live audio and changes cannot sync until the connection returns.</div>}
    <main ref={mainRef} id="main-content" className="app-main" tabIndex={-1} inert={mobileOpen || undefined} aria-hidden={mobileOpen || undefined}>{children}</main>
  </div>
}
