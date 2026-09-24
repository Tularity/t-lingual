export interface ShortcutKey {
  /** What is painted on the key. */
  glyph: string
  /** What is read out. Equal to `glyph` whenever the glyph is already words. */
  name: string
}

/**
 * Keys whose printed form differs between an Apple keyboard and everything
 * else. Anything absent from these tables is passed through unchanged, so
 * letters, digits and function keys need no entries.
 *
 * `Mod` is the token authors should write. It resolves to the platform's
 * primary shortcut modifier — Command on Apple, Control elsewhere — which is
 * the distinction every cross-platform shortcut actually cares about, and
 * writing `Cmd` or `Ctrl` literally in a component that ships to both is how a
 * hint ends up telling half the users to press a key that does nothing.
 */
const APPLE_KEYS: Record<string, ShortcutKey> = {
  mod: { glyph: '⌘', name: 'Command' },
  cmd: { glyph: '⌘', name: 'Command' },
  command: { glyph: '⌘', name: 'Command' },
  meta: { glyph: '⌘', name: 'Command' },
  ctrl: { glyph: '⌃', name: 'Control' },
  control: { glyph: '⌃', name: 'Control' },
  alt: { glyph: '⌥', name: 'Option' },
  option: { glyph: '⌥', name: 'Option' },
  shift: { glyph: '⇧', name: 'Shift' },
  enter: { glyph: '↵', name: 'Enter' },
  return: { glyph: '↵', name: 'Return' },
  tab: { glyph: '⇥', name: 'Tab' },
  backspace: { glyph: '⌫', name: 'Backspace' },
  delete: { glyph: '⌦', name: 'Delete' },
  del: { glyph: '⌦', name: 'Delete' },
}

const OTHER_KEYS: Record<string, ShortcutKey> = {
  mod: { glyph: 'Ctrl', name: 'Control' },
  cmd: { glyph: 'Ctrl', name: 'Control' },
  command: { glyph: 'Ctrl', name: 'Control' },
  // Not "Win": the same key is Super on Linux and Meta on a generic keyboard,
  // and only Apple has a universally recognised glyph for it.
  meta: { glyph: 'Meta', name: 'Meta' },
  ctrl: { glyph: 'Ctrl', name: 'Control' },
  control: { glyph: 'Ctrl', name: 'Control' },
  alt: { glyph: 'Alt', name: 'Alt' },
  option: { glyph: 'Alt', name: 'Alt' },
  shift: { glyph: 'Shift', name: 'Shift' },
  enter: { glyph: 'Enter', name: 'Enter' },
  return: { glyph: 'Enter', name: 'Enter' },
  tab: { glyph: 'Tab', name: 'Tab' },
  backspace: { glyph: 'Backspace', name: 'Backspace' },
  delete: { glyph: 'Del', name: 'Delete' },
  del: { glyph: 'Del', name: 'Delete' },
}

/**
 * Keys that read the same on every platform. Escape stays as the word "Esc"
 * even on Apple hardware, where ⎋ is printed on the key but is not what anyone
 * calls it; the arrows go the other way, because the glyph is what is printed
 * everywhere and "Arrow Up" is what has to be said out loud.
 */
const SHARED_KEYS: Record<string, ShortcutKey> = {
  esc: { glyph: 'Esc', name: 'Escape' },
  escape: { glyph: 'Esc', name: 'Escape' },
  space: { glyph: 'Space', name: 'Space' },
  spacebar: { glyph: 'Space', name: 'Space' },
  up: { glyph: '↑', name: 'Arrow up' },
  arrowup: { glyph: '↑', name: 'Arrow up' },
  down: { glyph: '↓', name: 'Arrow down' },
  arrowdown: { glyph: '↓', name: 'Arrow down' },
  left: { glyph: '←', name: 'Arrow left' },
  arrowleft: { glyph: '←', name: 'Arrow left' },
  right: { glyph: '→', name: 'Arrow right' },
  arrowright: { glyph: '→', name: 'Arrow right' },
  pageup: { glyph: 'PgUp', name: 'Page up' },
  pagedown: { glyph: 'PgDn', name: 'Page down' },
  home: { glyph: 'Home', name: 'Home' },
  end: { glyph: 'End', name: 'End' },
}

/**
 * Splits a shortcut written as `Mod+Shift+K` into the keys to render.
 *
 * The separator can itself be a key, which is the one case that stops this from
 * being a call to `split`: `Mod++` means Command and the plus key, and naively
 * splitting produces two empty tokens instead of one plus. An empty token in
 * the final position is therefore read back as a literal `+`, and empty tokens
 * anywhere else are dropped as the stray separators they are.
 */
export function parseShortcut(keys: string, apple: boolean): ShortcutKey[] {
  const platformKeys = apple ? APPLE_KEYS : OTHER_KEYS
  const raw = keys.split('+')
  const tokens: string[] = []

  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index].trim()
    if (token === '') {
      if (index > 0 && index === raw.length - 1) tokens.push('+')
      continue
    }
    tokens.push(token)
  }

  return tokens.map((token) => {
    const lookup = token.toLowerCase()
    const known = platformKeys[lookup] ?? SHARED_KEYS[lookup]
    if (known) return known
    // A single character is a key cap and is shown uppercase; anything longer
    // is a name the author already spelled the way they want it ("F5", "Fn").
    const glyph = Array.from(token).length === 1 ? token.toLocaleUpperCase() : token
    return { glyph, name: glyph }
  })
}

let cachedApplePlatform: boolean | undefined

/**
 * Whether this machine uses the Apple modifier set.
 *
 * Resolved once and cached, for two reasons: the answer cannot change during a
 * session, and `Kbd` reads it through `useSyncExternalStore`, whose snapshot
 * function must return a referentially stable value or React will re-render
 * without end.
 *
 * `userAgentData.platform` first because `navigator.platform` is deprecated and
 * frozen in some browsers, then `navigator.platform`, then the user-agent
 * string. iPadOS reporting itself as "MacIntel" is the right answer here rather
 * than a bug to work around: an iPad with a keyboard attached has a Command
 * key, and an iPad without one is not showing keyboard hints to anybody.
 */
export function isApplePlatform(): boolean {
  if (cachedApplePlatform !== undefined) return cachedApplePlatform
  if (typeof navigator === 'undefined') return false

  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData
  const source = uaData?.platform || navigator.platform || navigator.userAgent || ''

  cachedApplePlatform = /mac|iphone|ipad|ipod/i.test(source)
  return cachedApplePlatform
}
