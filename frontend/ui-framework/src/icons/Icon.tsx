import { forwardRef, type SVGAttributes } from 'react'
import { cx } from '../utils/cx'

/* ---------------------------------------------------------------------------
 * Icons
 *
 * One outline set on a 24x24 grid, 1.75 stroke, round caps and joins. A single
 * geometric system is what makes a toolbar read as one family rather than as
 * assorted clip art, and stroke icons stay legible at 14px in a dense table
 * where a filled glyph turns into a blob.
 *
 * API SHAPE
 * ---------
 * A `name` registry rather than one export per icon. The trade-off is real —
 * a registry cannot tree-shake, so every consumer ships all of them — but the
 * whole set is a few kilobytes of path data before compression, and the
 * ergonomics of `<Icon name="mic" />` in feature code (and the ability to store
 * an icon name in data, which a status map genuinely needs) is worth more here
 * than shaving those bytes.
 * ------------------------------------------------------------------------- */

const PATHS = {
  /* -- Navigation -------------------------------------------------------- */
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 5v4h4M12 7.5V12l3 2',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M16.2 16.2 20.5 20.5',
  filter: 'M4 6h16l-6 7v5l-4 2v-7z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5',

  /* -- Direction --------------------------------------------------------- */
  chevronUp: 'm7 14 5-5 5 5',
  chevronDown: 'm7 10 5 5 5-5',
  chevronLeft: 'm14 7-5 5 5 5',
  chevronRight: 'm10 7 5 5-5 5',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowBoth: 'M8 7 4 11l4 4M4 11h16M16 7l4 4-4 4',

  /* -- Actions ----------------------------------------------------------- */
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  copy: 'M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l2 2',
  trash: 'M4 7h16M10 4h4M9 7l.7 12a1 1 0 0 0 1 1h2.6a1 1 0 0 0 1-1L15 7M10.5 10.5v6M13.5 10.5v6',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4',
  download: 'M12 4v11M8 11l4 4 4-4M4 19h16',
  upload: 'M12 19V8M8 12l4-4 4 4M4 4h16',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  moreVertical: 'M12 6v.01M12 12v.01M12 18v.01',
  printer: 'M7 9V4h10v5M7 18H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 15h10v5H7z',

  /* -- Media / session --------------------------------------------------- */
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5v14M15 5v14',
  stop: 'M6.5 6.5h11v11h-11z',
  microphone: 'M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6',
  microphoneOff: 'M9.5 6.2A2.5 2.5 0 0 1 14.5 6.5v4M14.5 14.3a2.5 2.5 0 0 1-5-1.3v-2M6 11a6 6 0 0 0 9.3 5M18 11v.6M12 17v3M9 20h6M4 4l16 16',
  wave: 'M3 12h2M7 8v8M11 5v14M15 8.5v7M19 10.5v3M21.5 12H21',
  volume: 'M4 9.5h3L11 6v12L7 14.5H4zM15 9.8a3.2 3.2 0 0 1 0 4.4M17.6 7.4a6.5 6.5 0 0 1 0 9.2',
  headphones: 'M4 14v-2a8 8 0 1 1 16 0v2M4 14a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 14a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z',
  languages: 'M3 6h9M7.5 4v2M9.5 6c0 3.5-2.5 7-6 8.5M6 10.5c1 2 3 3.6 5 4.4M12.5 20l4-9 4 9M14.2 16.5h4.6',

  /* -- Identity / security ----------------------------------------------- */
  user: 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5M4.5 20a7.5 7.5 0 0 1 15 0',
  users: 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M3 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.6M17.5 13.8A6.5 6.5 0 0 1 21 20',
  admin: 'M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M4.5 20a7.5 7.5 0 0 1 11-6.7M17 15v5M14.5 17.5h5',
  shield: 'M12 3.5 5 6.2v5.1c0 4.2 2.8 7.7 7 9.2 4.2-1.5 7-5 7-9.2V6.2z',
  key: 'M15.5 3.5a5 5 0 1 1-4.3 7.6L4 18.3V21h3v-2h2v-2h2l1.4-1.4a5 5 0 0 0 3.1.4M16.8 7.8h.01',
  lock: 'M6.5 10.5h11a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1M8.5 10.5V8a3.5 3.5 0 1 1 7 0v2.5',
  unlock: 'M6.5 10.5h11a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2',
  eye: 'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  eyeOff: 'M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.9 3.7M6.3 6.8A17 17 0 0 0 2.5 12S6 19 12 19a9.4 9.4 0 0 0 3.8-.8M10.4 10.4a2.5 2.5 0 0 0 3.4 3.4M4 4l16 16',
  logout: 'M14 8V6a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2M9.5 12H21M17.5 8.5 21 12l-3.5 3.5',

  /* -- Status ------------------------------------------------------------ */
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5M12 7.8h.01',
  warning: 'M10.7 4.3 2.9 17.6a1.5 1.5 0 0 0 1.3 2.3h15.6a1.5 1.5 0 0 0 1.3-2.3L13.3 4.3a1.5 1.5 0 0 0-2.6 0M12 9.5v4M12 16.8h.01',
  alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 8v5M12 16.2h.01',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8.5 12.2l2.4 2.4 4.6-4.9',
  closeCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7.2V12l3 1.8',
  spark: 'M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2zM18.5 4v3M17 5.5h3',

  /* -- System ------------------------------------------------------------ */
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.2 14a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-2.55 1.06V20a1.8 1.8 0 0 1-3.6 0v-.1A1.5 1.5 0 0 0 7.75 18.6l-.05.05A1.8 1.8 0 1 1 5.15 16.1l.05-.05A1.5 1.5 0 0 0 4.19 13.5H4a1.8 1.8 0 0 1 0-3.6h.1A1.5 1.5 0 0 0 5.4 7.75l-.05-.05A1.8 1.8 0 1 1 7.9 5.15l.05.05A1.5 1.5 0 0 0 10 4.19V4a1.8 1.8 0 0 1 3.6 0v.1a1.5 1.5 0 0 0 2.55 1.05l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05A1.5 1.5 0 0 0 19.81 10.5H20a1.8 1.8 0 0 1 0 3.6h-.1a1.5 1.5 0 0 0-1.38.9z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8',
  moon: 'M20 14.3A8.5 8.5 0 0 1 9.7 4a8.5 8.5 0 1 0 10.3 10.3',
  /** Day and night together, for a theme that follows the system. */
  sunMoon: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M8 2.2v1.3M8 12.5v1.3M2.2 8h1.3M12.5 8h1.3M3.9 3.9l.92.92M12.1 3.9l-.92.92M3.9 12.1l.92-.92M21.8 17.6A5.5 5.5 0 0 1 15.4 11.2a5.5 5.5 0 1 0 6.4 6.4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.2 9.5h17.6M3.2 14.5h17.6M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  database: 'M12 8.5c4.4 0 8-1.2 8-2.75S16.4 3 12 3 4 4.2 4 5.75 7.6 8.5 12 8.5M4 5.75v12.5C4 19.8 7.6 21 12 21s8-1.2 8-2.75V5.75M20 12c0 1.5-3.6 2.75-8 2.75S4 13.5 4 12',
  calendar: 'M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 10.5h16M8.5 4v4M15.5 4v4',
  mail: 'M3.5 7a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1zM3.8 7.4l8.2 6 8.2-6',
  terminal: 'M5 6.5 10 12l-5 5.5M12.5 18h6.5',
} as const

export type IconName = keyof typeof PATHS

/** Every icon name, in registry order. Useful for a gallery or a picker. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[]

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, 'name'> {
  name: IconName
  /** Edge length in px. Defaults to 1em so it tracks the surrounding type. */
  size?: number | string
  /**
   * Accessible label. Omit for decorative icons — the default is
   * `aria-hidden`, which is correct whenever adjacent text already carries the
   * meaning. Supplying a label switches the element to `role="img"`.
   */
  label?: string
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = '1em', label, className, strokeWidth = 1.75, ...rest },
  ref,
) {
  const d = PATHS[name]

  if (import.meta.env?.DEV && !d) {
    console.error(`[t-lingual/ui] Unknown icon "${name}".`)
  }

  return (
    <svg
      ref={ref}
      className={cx('tl-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {d ? <path d={d} /> : null}
    </svg>
  )
})
