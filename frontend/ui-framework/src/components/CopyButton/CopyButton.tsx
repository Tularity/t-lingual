import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { Portal } from '../../primitives/Portal'
import { Button, type ButtonProps } from '../Button/Button'
import './CopyButton.css'

/**
 * Writes `text` to the system clipboard, or throws.
 *
 * Exported on its own because the hard part of copying has nothing to do with
 * a button: a "copy link" item in a context menu, a keyboard shortcut, and a
 * cell action in a table all need the same fallback chain, and none of them
 * should have to render a CopyButton off-screen to get it.
 *
 * `navigator.clipboard` is not merely old-browser-gated. It is `undefined` on
 * every `http://` origin, which includes the LAN address an operator uses to
 * reach a booth machine, and it rejects when the document is not focused or the
 * permission was denied. The `execCommand` path still works in several of those
 * cases, so a rejection from the async API is a reason to try the old way, not
 * a reason to give up.
 *
 * The function rejects rather than returning `false` on failure. A silent
 * no-op is the worst possible outcome here: the user believes they have the
 * text, pastes nothing, and blames the paste target.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Swallowed on purpose so the legacy path below gets its turn.
    }
  }

  if (!copyBySelection(text)) {
    throw new Error('[t-lingual/ui] The browser refused to write to the clipboard.')
  }
}

function copyBySelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const area = document.createElement('textarea')
  area.value = text
  // Off-screen but genuinely rendered. `display: none`, `visibility: hidden`
  // and a zero-size box each make the contents unselectable, and an
  // unselectable element cannot be copied from. `position: fixed` keeps the
  // page from scrolling to reach it, which `absolute` at a large offset does.
  // The font size is not cosmetic: iOS zooms the viewport when focus lands in
  // a control smaller than 16px, and never zooms back out.
  area.style.cssText =
    'position:fixed;top:0;inset-inline-start:-9999px;opacity:0;font-size:12pt;border:0;padding:0;'
  // `readonly` is what keeps the iOS software keyboard down; the element is
  // still selectable because selection does not require editability.
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.tabIndex = -1

  const previouslyFocused = document.activeElement as HTMLElement | null
  const selection = document.getSelection()
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  document.body.appendChild(area)
  area.select()
  // iOS ignores `select()` on a readonly control and copies an empty string
  // unless the range is set explicitly as well.
  area.setSelectionRange(0, text.length)

  let copied: boolean
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }

  area.remove()

  // Whatever the user had selected before pressing the button is theirs, and
  // losing it mid-task is a real irritation. Focus is restored for the same
  // reason: appending and selecting moved it off the button a keyboard user
  // was standing on.
  if (previousRange) {
    selection?.removeAllRanges()
    selection?.addRange(previousRange)
  }
  previouslyFocused?.focus?.()

  return copied
}

export type CopyStatus = 'idle' | 'copied' | 'error'

export interface CopyButtonProps extends Omit<ButtonProps, 'children' | 'icon'> {
  /** The text placed on the clipboard. */
  value: string
  /** Resting label, and the accessible name whenever the button is icon-only. */
  label?: string
  copiedLabel?: string
  errorLabel?: string
  icon?: ReactNode
  /** Falls back to `icon`. */
  copiedIcon?: ReactNode
  /** Falls back to `icon`. */
  errorIcon?: ReactNode
  /** Milliseconds the confirmation stays up before the button returns to rest. */
  resetAfter?: number
  onCopied?: (value: string) => void
  onCopyError?: (error: unknown) => void
}

/**
 * Copies a string and confirms that it worked.
 *
 * WHY THE ANNOUNCEMENT IS PORTALLED
 * ---------------------------------
 * The confirmation has to reach a screen reader, and a colour change does not.
 * The obvious placements for the live region are both wrong. Inside the button
 * it becomes part of name-from-content, so the button's accessible name grows a
 * trailing "Copied". Beside the button it becomes a sibling element, which
 * silently breaks `:last-child` — and that selector is exactly what ButtonGroup
 * relies on to square the right-hand corners. Portalling the region to
 * `<body>` keeps the button a leaf in its own layout and leaves the DOM around
 * it untouched. The region is mounted from the start rather than created with
 * its message, because a live region that appears at the same moment as its
 * content is frequently not announced at all.
 *
 * The button's visible label also changes, which means a focused button's
 * accessible name changes with it, and some screen readers will report that on
 * top of the live region. The duplication is accepted deliberately: name-change
 * reporting is inconsistent across the combinations we care about, and it does
 * not exist at all for the icon-only case, where the name is pinned to `label`
 * so the control never stops describing what it does.
 */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    value,
    label = 'Copy',
    copiedLabel = 'Copied',
    errorLabel = 'Copy failed',
    icon,
    copiedIcon,
    errorIcon,
    resetAfter = 1600,
    onCopied,
    onCopyError,
    iconOnly = false,
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)

  if (import.meta.env?.DEV) {
    if (iconOnly && !icon) {
      console.error(
        '[t-lingual/ui] <CopyButton iconOnly> renders no visible label, so it needs an `icon`.',
      )
    }
    if (iconOnly && icon && !copiedIcon) {
      console.error(
        '[t-lingual/ui] <CopyButton iconOnly> without a `copiedIcon` confirms the copy with a ' +
          'colour change and nothing else — the glyph and the label both stay put, which fails ' +
          'WCAG 1.4.1. Pass a `copiedIcon`, or drop `iconOnly` so the label can change.',
      )
    }
  }

  useEffect(() => {
    // Reset on mount rather than relying on the initial value: StrictMode mounts,
    // unmounts and remounts, and a `false` left behind by the first teardown
    // would leave the remounted button unable to show a confirmation.
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current !== undefined) clearTimeout(timer.current)
    }
  }, [])

  const settle = (next: Exclude<CopyStatus, 'idle'>) => {
    // The clipboard write is awaited, so this can be reached after the button
    // has gone. Scheduling the reset anyway would leave a timer running with
    // nothing left to clear it.
    if (!alive.current) return
    setStatus(next)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = undefined
      setStatus('idle')
    }, resetAfter)
  }

  const handleClick = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    // Read before the await: a consumer who cancels the default action wants the
    // copy cancelled too, and after the first await the flag is meaningless.
    if (event.defaultPrevented) return

    try {
      await copyTextToClipboard(value)
      settle('copied')
      onCopied?.(value)
    } catch (error) {
      settle('error')
      onCopyError?.(error)
    }
  }

  const currentLabel =
    status === 'copied' ? copiedLabel : status === 'error' ? errorLabel : label
  const currentIcon =
    status === 'copied' ? (copiedIcon ?? icon) : status === 'error' ? (errorIcon ?? icon) : icon

  return (
    <>
      <Button
        {...rest}
        ref={ref}
        icon={currentIcon}
        iconOnly={iconOnly}
        // Pinned to the action, not the outcome. A control whose name flips to
        // "Copied" has stopped telling a screen-reader user what pressing it
        // will do. The labelled variant gets its name from its visible text
        // instead, which is what WCAG 2.5.3 requires.
        aria-label={iconOnly ? label : undefined}
        data-state={status}
        className={cx('tl-copy-button', className)}
        onClick={handleClick}
      >
        {iconOnly ? undefined : currentLabel}
      </Button>

      <Portal>
        <span className="tl-visually-hidden" role="status" aria-live="polite">
          {status === 'idle' ? '' : currentLabel}
        </span>
      </Portal>
    </>
  )
})
