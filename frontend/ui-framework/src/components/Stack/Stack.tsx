import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { Slot } from '../../primitives/Slot'
import './Stack.css'

/**
 * Every step of the primitive spacing scale, spelled as the string that lands
 * in `data-gap`.
 *
 * It lives here rather than in a shared module because the framework has no
 * shared-types file and inventing one for a single union would be a worse
 * trade than Inline and Grid importing from their sibling: three near-identical
 * copies of this union are three things that drift apart the first time a step
 * is added to the scale.
 */
export type SpaceScale =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | '11'
  | '12'
  | '14'
  | '16'
  | '20'
  | '24'

export type StackAlign = 'start' | 'center' | 'end' | 'stretch' | 'baseline'

export type StackJustify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  /** Spacing between children, as a step on the primitive space scale. */
  gap?: SpaceScale
  /** Cross-axis alignment. Left unset, children stretch to the full width. */
  align?: StackAlign
  /** Main-axis distribution. Only does anything when the stack has a height. */
  justify?: StackJustify
  wrap?: boolean
  /** Lays out as `inline-flex`, so the stack sits in a line of text. */
  inline?: boolean
  asChild?: boolean
}

/**
 * Vertical flow.
 *
 * The gap travels as `data-gap="8"` and is resolved to `var(--tl-space-8)` by a
 * rule per step, rather than being written into a `style` attribute. Two
 * reasons, and both matter: an inline style beats every stylesheet rule short
 * of `!important`, so a consumer could not override the spacing of a stack
 * nested inside their own layout; and a `style` attribute emitted during
 * server rendering is refused outright under a `style-src` policy that has not
 * opted into `'unsafe-inline'`, which is a policy this product ships.
 *
 * The default gap is one step of the scale rather than zero. A layout primitive
 * that produces exactly what a bare `<div>` produces earns its place only when
 * every consumer remembers to pass `gap`, and they do not; `gap="0"` is one
 * keystroke away for the cases that genuinely want a flush stack.
 *
 * `min-width: 0` is set unconditionally. Without it a stack placed inside a
 * flex row refuses to shrink below the widest unbreakable string it contains —
 * a long participant name or a URL in a transcript — and pushes the rest of the
 * row off screen. Flex's `auto` minimum size is the single most common cause of
 * a layout that overflows only for one customer's data.
 */
export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  {
    gap = '4',
    align,
    justify,
    wrap = false,
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
      data-tl="stack"
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? 'wrap' : 'nowrap'}
      data-inline={inline || undefined}
      className={cx('tl-stack', className)}
      {...rest}
    />
  )
})
