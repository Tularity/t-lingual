import { forwardRef, type OlHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import './Steps.css'

export type StepStatus = 'complete' | 'current' | 'upcoming' | 'error'

export type StepsOrientation = 'horizontal' | 'vertical'

export type StepsSize = 'sm' | 'md'

export interface StepItem {
  /** Stable key. Falls back to the index, which is fine for a fixed ceremony. */
  id?: string
  label: ReactNode
  description?: ReactNode
  /** Overrides the status derived from `current`. */
  status?: StepStatus
  /** Replaces the marker's glyph or number. */
  icon?: ReactNode
}

export interface StepsProps extends OlHTMLAttributes<HTMLOListElement> {
  steps: StepItem[]
  /** Index of the step in progress. Derives the status of every other step. */
  current?: number
  orientation?: StepsOrientation
  size?: StepsSize
  /** Spoken after each step's label. Override for a non-English UI. */
  statusLabels?: Record<StepStatus, string>
}

const DEFAULT_STATUS_LABELS: Record<StepStatus, string> = {
  complete: 'Completed',
  current: 'Current step',
  upcoming: 'Not started',
  error: 'Failed',
}

function deriveStatus(index: number, current: number, explicit: StepStatus | undefined): StepStatus {
  if (explicit) return explicit
  if (index < current) return 'complete'
  if (index === current) return 'current'
  return 'upcoming'
}

/**
 * Linear progress through a ceremony: register a passkey, confirm it, done.
 *
 * MARKUP
 * ------
 * An `<ol>`, always, in both orientations. The horizontal arrangement is a
 * visual convenience; underneath it is a numbered sequence, and a screen reader
 * that hears "list, 3 items, item 1 of 3" gets the position and the total for
 * free — information the horizontal layout conveys only through pixels. It also
 * means the component linearises correctly when the styles fail to load or the
 * user is reading it in a text browser.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - `aria-current="step"` marks the one step in progress. `step` rather than
 *   `true` because the token names what kind of "current" this is, which is how
 *   assistive technology distinguishes it from the current page in a nav.
 *
 * - Nothing here is focusable. This is a status display, not a navigation
 *   control; a user cannot skip to step three by clicking it, so making the
 *   steps tabbable would put stops in the tab order that do nothing. A wizard
 *   that genuinely allows jumping backwards should render its own buttons.
 *
 * - Colour never distinguishes one status from another on its own. A completed
 *   step draws a check, an errored step draws a warning glyph, and pending
 *   steps show their number — so the three read apart in greyscale, under a
 *   colour-vision deficiency, and in forced-colors mode where the fills are
 *   thrown away entirely. Each step also carries a visually hidden status word,
 *   because a check mark is a picture and pictures are not announced.
 *
 * - The list needs a name. There is nothing in the markup to derive one from
 *   and an unnamed list of three items is meaningless out of context, so a
 *   missing `aria-label` is reported in development.
 */
export const Steps = forwardRef<HTMLOListElement, StepsProps>(function Steps(
  {
    steps,
    current = 0,
    orientation = 'horizontal',
    size = 'md',
    statusLabels = DEFAULT_STATUS_LABELS,
    className,
    ...rest
  },
  ref,
) {
  if (import.meta.env?.DEV && !rest['aria-label'] && !rest['aria-labelledby']) {
    console.error(
      '[t-lingual/ui] <Steps> needs `aria-label` or `aria-labelledby` — for example ' +
        '"Passkey registration progress". Without it the list announces as three ' +
        'unrelated items.',
    )
  }

  return (
    <ol
      {...rest}
      ref={ref}
      // Stated even though it is an `<ol>`'s implicit role. WebKit strips list
      // semantics from any list whose `list-style` is `none`, and the markers
      // replace the bullets on every instance — so without this the "list, 3
      // items, item 2 of 3" that is the entire reason this component is a list
      // is silently absent in VoiceOver.
      role="list"
      data-tl="steps"
      data-orientation={orientation}
      data-size={size}
      className={cx('tl-steps', className)}
    >
      {steps.map((step, index) => {
        const status = deriveStatus(index, current, step.status)

        return (
          <li
            key={step.id ?? index}
            data-status={status}
            className="tl-steps__step"
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <span className="tl-steps__marker" aria-hidden="true">
              {step.icon ??
                (status === 'complete' ? (
                  <Icon name="check" />
                ) : status === 'error' ? (
                  <Icon name="warning" />
                ) : (
                  index + 1
                ))}
            </span>

            <span className="tl-steps__content">
              <span className="tl-steps__label">{step.label}</span>
              {/* Placed after the label so the announcement reads "Confirm,
                * completed" rather than leading with a state the listener has
                * no name for yet. */}
              <VisuallyHidden>{` — ${statusLabels[status]}`}</VisuallyHidden>
              {step.description != null && (
                <span className="tl-steps__description">{step.description}</span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
})
