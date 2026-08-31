import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'admin' | 'arrowLeft' | 'arrowRight' | 'check' | 'chevronDown' | 'close'
  | 'copy' | 'folder' | 'grid' | 'history' | 'home' | 'key' | 'list'
  | 'logout' | 'microphone' | 'moon' | 'more' | 'pause' | 'play' | 'plus'
  | 'printer' | 'search' | 'settings' | 'shield' | 'spark' | 'stop' | 'sun' | 'trash'
  | 'user' | 'users' | 'wave' | 'warning'

const paths: Record<IconName, ReactNode> = {
  admin: <><path d="M12 3 4.5 6.4v5.1c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6.4L12 3Z"/><path d="M9 12.2 11 14l4-4.5"/></>,
  arrowLeft: <path d="m15 18-6-6 6-6"/>,
  arrowRight: <path d="m9 18 6-6-6-6"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  chevronDown: <path d="m6 9 6 6 6-6"/>,
  close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/></>,
  home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></>,
  key: <><circle cx="8" cy="12" r="4"/><path d="M12 12h9"/><path d="M18 12v3"/><path d="M15 12v2"/></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".5" fill="currentColor"/><circle cx="4.5" cy="12" r=".5" fill="currentColor"/><circle cx="4.5" cy="18" r=".5" fill="currentColor"/></>,
  logout: <><path d="M10 5H5v14h5"/><path d="m14 8 4 4-4 4"/><path d="M18 12H9"/></>,
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  pause: <><path d="M9 5v14M15 5v14"/></>,
  play: <path d="m8 5 11 7-11 7V5Z"/>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  printer: <><path d="M7 9V3h10v6"/><path d="M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  shield: <><path d="M12 3 5 6v5c0 4.5 2.8 7.7 7 10 4.2-2.3 7-5.5 7-10V6l-7-3Z"/><path d="M9.5 12 11 13.5l3.5-4"/></>,
  spark: <><path d="m12 3 1.3 4.2L17 9l-3.7 1.8L12 15l-1.3-4.2L7 9l3.7-1.8L12 3Z"/><path d="m19 14 .7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7L19 14Z"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5"/></>,
  wave: <><path d="M3 12h2l2-7 4 14 3-11 2 7 2-3h3"/></>,
  warning: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17.5v.1"/></>,
}

export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  )
}
