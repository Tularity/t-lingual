import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import './Panel.css'

export type PanelVariant = 'default' | 'sunken' | 'outline' | 'plain'

export type PanelPadding = 'none' | 'sm' | 'md' | 'lg'

export type PanelLevel = 2 | 3 | 4 | 5 | 6

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  /** Secondary line under the title. Not part of the panel's accessible name. */
  description?: ReactNode
  /** Controls for the header's trailing edge. Never nested inside the trigger. */
  actions?: ReactNode
  footer?: ReactNode
  /** Heading level for the title. Defaults to 2. */
  level?: PanelLevel
  variant?: PanelVariant
  padding?: PanelPadding
  /** Turns the title into a disclosure trigger. */
  collapsible?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * A titled section of a page.
 *
 * The root is a `<section>` labelled by its own title, which makes each panel a
 * named region landmark and lets a screen reader user jump between the sections
 * of a dense operator screen directly. That is the intent for a page holding a
 * handful of panels; a screen holding twenty collapsibles should pass
 * `role="group"` to opt out, because twenty landmarks is the same as none.
 *
 * COLLAPSING
 * ----------
 * The trigger is a real `<button>` nested inside the heading, per the APG
 * disclosure pattern, so the title keeps its level in the document outline and
 * still appears in a headings list while collapsed. `actions` sit outside that
 * button rather than inside the header's click area: making the entire header
 * row the trigger is the usual shortcut, and it produces a button that contains
 * other buttons, which is unreachable markup.
 *
 * Collapsed content is hidden with the `hidden` attribute rather than being
 * unmounted. Unmounting throws away form state, scroll position and any
 * in-flight subscription inside the panel, and a collapsed panel is expected to
 * remember where it was when it reopens. `hidden` removes the content from the
 * accessibility tree and from the tab order, which is the part that matters —
 * visually hiding it while leaving it focusable produces the "focus vanished
 * into an invisible region" bug.
 *
 * Nothing animates the collapse. Transitioning to an intrinsic height requires
 * either measuring the content in JS on every open or `interpolate-size`, which
 * is not yet broadly available; both of the usual approximations (a fixed
 * max-height, or a scale transform) misbehave the moment the content is taller
 * than expected, and a transcript panel is always taller than expected.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  {
    title,
    description,
    actions,
    footer,
    level = 2,
    variant = 'default',
    padding = 'md',
    collapsible = false,
    open: openProp,
    defaultOpen = true,
    onOpenChange,
    className,
    children,
    ...rest
  },
  ref,
) {
  const baseId = useId()
  const titleId = `${baseId}-title`
  const descriptionId = `${baseId}-description`
  const contentId = `${baseId}-content`

  const [open, setOpen] = useControllableState<boolean>({
    value: openProp,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })

  // A panel that cannot collapse is always open, whatever state says. This
  // keeps `collapsible` a pure presentation switch rather than something that
  // can strand content behind a stale `open={false}`.
  const expanded = collapsible ? open : true

  const Heading = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

  const titleContent = collapsible ? (
    <button
      type="button"
      className="tl-panel__trigger"
      aria-expanded={expanded}
      aria-controls={contentId}
      // The description is part of the trigger's context, not its name: folding
      // it into the label makes every announcement of the button a paragraph.
      aria-describedby={description ? descriptionId : undefined}
      onClick={() => setOpen(!expanded)}
    >
      <svg
        className="tl-panel__chevron"
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
      <span className="tl-panel__title-text">{title}</span>
    </button>
  ) : (
    <span className="tl-panel__title-text">{title}</span>
  )

  return (
    <section
      ref={ref}
      data-tl="panel"
      data-variant={variant}
      data-padding={padding}
      data-collapsible={collapsible || undefined}
      data-state={expanded ? 'open' : 'closed'}
      className={cx('tl-panel', className)}
      aria-labelledby={titleId}
      {...rest}
    >
      <div className="tl-panel__header">
        <div className="tl-panel__heading">
          <Heading id={titleId} className="tl-panel__title">
            {titleContent}
          </Heading>
          {description && (
            <p id={descriptionId} className="tl-panel__description">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="tl-panel__actions">{actions}</div>}
      </div>

      {/* Body and footer share one wrapper so the trigger has a single
          `aria-controls` target and one thing to hide. */}
      <div id={contentId} className="tl-panel__content" hidden={!expanded}>
        <div className="tl-panel__body">{children}</div>
        {footer && <div className="tl-panel__footer">{footer}</div>}
      </div>
    </section>
  )
})
