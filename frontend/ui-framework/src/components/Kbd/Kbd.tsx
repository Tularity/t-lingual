import {
  forwardRef,
  Fragment,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import { isApplePlatform, parseShortcut } from './shortcut'
import './Kbd.css'

export type KbdSize = 'sm' | 'md'

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** A combination, written with `+`: `Mod+K`, `Shift+Enter`, `Mod++`. */
  keys?: string
  /** Painted between keys. */
  separator?: ReactNode
  size?: KbdSize
  /** Pins the modifier set instead of detecting it. Useful in tests and docs. */
  platform?: 'auto' | 'apple' | 'other'
}

/** The platform never changes mid-session, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {}

/**
 * Keyboard keys, rendered the way the user's own keyboard is labelled.
 *
 * WHY THE DETECTION GOES THROUGH useSyncExternalStore
 * ---------------------------------------------------
 * The platform is only knowable on the client, and a component that reads it
 * during render produces different HTML on the server than on the client, which
 * is a hydration mismatch — React discards the server markup and warns.
 * `useSyncExternalStore` exists for exactly this: it renders the server
 * snapshot during hydration, then immediately re-renders with the client one,
 * so a server-rendered page hydrates cleanly and then corrects itself in the
 * same commit. The server snapshot is non-Apple, which is the majority default
 * and, more usefully, the one whose glyphs are words rather than symbols — a
 * frame of "Ctrl" that turns into "⌘" is a smaller lie than the reverse.
 *
 * SYMBOLS ARE NOT NAMES
 * ---------------------
 * ⌘ is announced by most screen readers as "place of interest sign", ⌥ as
 * "option key" only if the voice happens to know it, and ⇧ as "up arrow". So a
 * key whose glyph is a symbol paints the symbol, hides it from assistive
 * technology, and carries the spoken name beside it — "Command", "Option",
 * "Shift". A key whose glyph is already a word or a letter gets neither, since
 * duplicating "K" as both hidden and visible text would have it read twice.
 *
 * The markup is a `<kbd>` per key nested inside an outer `<kbd>`, which is what
 * HTML specifies for a combination rather than a single keystroke.
 */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd(
  { keys, separator = '+', size = 'md', platform = 'auto', className, children, ...rest },
  ref,
) {
  const detectedApple = useSyncExternalStore(
    subscribeToNothing,
    isApplePlatform,
    () => false,
  )
  const apple = platform === 'auto' ? detectedApple : platform === 'apple'

  return (
    <kbd
      ref={ref}
      data-tl="kbd"
      data-size={size}
      data-platform={apple ? 'apple' : 'other'}
      className={cx('tl-kbd', className)}
      {...rest}
    >
      {keys
        ? parseShortcut(keys, apple).map((key, index) => (
            <Fragment key={`${key.name}-${index}`}>
              {index > 0 && (
                <span className="tl-kbd__separator" aria-hidden="true">
                  {separator}
                </span>
              )}
              <kbd className="tl-kbd__key">
                {key.glyph === key.name ? (
                  key.glyph
                ) : (
                  <>
                    <span aria-hidden="true">{key.glyph}</span>
                    <VisuallyHidden>{key.name}</VisuallyHidden>
                  </>
                )}
              </kbd>
            </Fragment>
          ))
        : // A single key given as children still gets the key treatment; the
          // outer <kbd> is the combination, the inner one is the keystroke,
          // and a combination of one is still a combination.
          children != null && <kbd className="tl-kbd__key">{children}</kbd>}
    </kbd>
  )
})
