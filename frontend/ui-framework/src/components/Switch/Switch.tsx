import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import './Switch.css'

export type SwitchSize = 'sm' | 'md' | 'lg'

export interface SwitchProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onChange' | 'defaultChecked' | 'children' | 'type'
  > {
  checked?: boolean
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
  /** Visible name. Rendered as a real `<label>` bound to the control. */
  label?: ReactNode
  /** Secondary line under the label, wired up with `aria-describedby`. */
  description?: ReactNode
  size?: SwitchSize
  /** Puts the text before the control, for a right-aligned settings row. */
  labelPlacement?: 'start' | 'end'
}

/**
 * An immediate on/off control.
 *
 * A switch differs from a checkbox in what activation means, not in how it
 * looks: a checkbox states an intent that some later Save applies, a switch
 * takes effect now. That is why this is `role="switch"` and why it has no
 * indeterminate state.
 *
 * IT IS A BUTTON, DELIBERATELY
 * ----------------------------
 * The APG switch pattern requires Space and adds Enter as an expected key, and
 * a native `<button>` fires a click for both without a line of key handling. A
 * `<div role="switch">` has to reimplement each of them, and the reimplementation
 * is where Enter usually gets forgotten. A hidden `<input type="checkbox">` is
 * the other common approach; it is rejected here because everything visible then
 * belongs to a sibling element and every state has to be mirrored onto it by
 * hand.
 *
 * WHAT GETS WHICH PROP
 * --------------------
 * `ref` and `...rest` land on the control, because that is the element a
 * consumer means when they reach for a switch — focusing it, measuring it, or
 * hanging a `data-testid` on it. `className` and `style` both land on the
 * wrapper, because that is the element they mean when they add a margin, and
 * splitting the two presentation props across different elements would make
 * `className="mt-4"` and `style={{ marginTop: 16 }}` do different things. The
 * split is unusual enough to be worth stating; the alternative is a component
 * that cannot be laid out without a second wrapper.
 *
 * STATE IS NOT CARRIED BY COLOUR
 * ------------------------------
 * The thumb sits at one end or the other, which survives any colour vision
 * deficiency and any monochrome rendering, and the track border changes under
 * forced colors where the fill is discarded outright.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked: checkedProp,
    defaultChecked = false,
    onChange,
    label,
    description,
    size = 'md',
    labelPlacement = 'end',
    disabled = false,
    id: idProp,
    className,
    style,
    onClick,
    'aria-labelledby': ariaLabelledby,
    'aria-describedby': ariaDescribedby,
    ...rest
  },
  ref,
) {
  const reactId = useId()
  const controlId = idProp ?? `${reactId}-switch`
  const labelId = `${reactId}-label`
  const descriptionId = `${reactId}-description`

  const [checked, setChecked] = useControllableState<boolean>({
    value: checkedProp,
    defaultValue: defaultChecked,
    onChange,
  })

  if (
    import.meta.env?.DEV &&
    label == null &&
    !rest['aria-label'] &&
    !ariaLabelledby
  ) {
    console.error(
      '[t-lingual/ui] <Switch> without a `label` needs `aria-label` or `aria-labelledby`. ' +
        'A switch with no name announces only as "on" or "off".',
    )
  }

  // Both of these are IDREF lists, so the component's own id is prepended to
  // whatever the consumer supplied rather than replacing it. Overwriting is the
  // easy mistake here and it silently drops the caller's description.
  const labelledBy =
    [label != null ? labelId : null, ariaLabelledby].filter(Boolean).join(' ') || undefined
  const describedBy =
    [description != null ? descriptionId : null, ariaDescribedby].filter(Boolean).join(' ') ||
    undefined

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    setChecked(!checked)
  }

  return (
    <span
      className={cx('tl-switch', className)}
      style={style}
      data-tl="switch"
      data-size={size}
      data-checked={checked || undefined}
      data-disabled={disabled || undefined}
      data-label-placement={labelPlacement}
      data-has-description={description != null || undefined}
    >
      <button
        {...rest}
        ref={ref}
        id={controlId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        disabled={disabled}
        className="tl-switch__control"
        onClick={handleClick}
      >
        <span className="tl-switch__thumb" aria-hidden="true" />
      </button>

      {(label != null || description != null) && (
        <span className="tl-switch__text">
          {label != null && (
            /* A real <label for> as well as `aria-labelledby`: the ARIA
             * reference is what names the control reliably across screen
             * readers, and the element is what makes clicking the words toggle
             * the switch. Dropping either one loses something a user expects. */
            <label id={labelId} htmlFor={controlId} className="tl-switch__label">
              {label}
            </label>
          )}
          {description != null && (
            <span id={descriptionId} className="tl-switch__description">
              {description}
            </span>
          )}
        </span>
      )}
    </span>
  )
})
