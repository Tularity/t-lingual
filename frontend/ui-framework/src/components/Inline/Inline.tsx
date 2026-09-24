import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { Slot } from '../../primitives/Slot'
// `import type`, not `import { type ... }`: under `verbatimModuleSyntax` the
// latter still emits `import '../Stack/Stack'`, which drags Stack.css into the
// bundle of anyone who only ever renders an Inline.
import type { SpaceScale, StackAlign, StackJustify } from '../Stack/Stack'
import './Inline.css'

export type InlineAlign = StackAlign
export type InlineJustify = StackJustify

export interface InlineProps extends HTMLAttributes<HTMLDivElement> {
  gap?: SpaceScale
  /** Cross-axis alignment. Defaults to `center` — see the note below. */
  align?: InlineAlign
  justify?: InlineJustify
  /** Defaults to `true`. Turning it off is a deliberate overflow decision. */
  wrap?: boolean
  inline?: boolean
  asChild?: boolean
}

/**
 * Horizontal flow.
 *
 * Two defaults differ from Stack, and both are the point of the component
 * existing separately.
 *
 * Wrapping is on. A row of buttons that cannot wrap does not get smaller at
 * 360px, it gets clipped or it pushes a horizontal scrollbar onto the whole
 * page, and the control that falls off the end is usually the destructive one
 * the operator was reaching for. Anyone who genuinely needs a single line —
 * a segmented control, a pair of pagination arrows — asks for `wrap={false}`
 * and owns the overflow that follows.
 *
 * Alignment is `center`. A horizontal row almost always mixes heights: a
 * button beside a label, an avatar beside two lines of text. The flex default
 * of `stretch` makes the label a full-height box whose text sits at the top,
 * which reads as a rendering fault rather than as a layout choice.
 */
export const Inline = forwardRef<HTMLDivElement, InlineProps>(function Inline(
  {
    gap = '4',
    align = 'center',
    justify,
    wrap = true,
    inline = false,
    asChild = false,
    className,
    ...rest
  },
  ref,
) {
  const Component = asChild ? Slot : 'div'

  return (
    <Component
      ref={ref}
      data-tl="inline"
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? 'wrap' : 'nowrap'}
      data-inline={inline || undefined}
      className={cx('tl-inline', className)}
      {...rest}
    />
  )
})
