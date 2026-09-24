import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { Slot } from '../../primitives/Slot'
// `import type`, not `import { type ... }`: under `verbatimModuleSyntax` the
// latter still emits `import '../Stack/Stack'`, which drags Stack.css into the
// bundle of anyone who only ever renders a Grid.
import type { SpaceScale, StackAlign } from '../Stack/Stack'
import './Grid.css'

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * A fixed track count, or `'auto'` to fit as many `minItemWidth` tracks as
   * the container allows.
   */
  columns?: number | 'auto'
  /** Track floor in `'auto'` mode. A bare number is read as pixels. */
  minItemWidth?: number | string
  gap?: SpaceScale
  /** Cross-axis alignment of items within their row. */
  align?: StackAlign
  asChild?: boolean
}

function toLength(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * A responsive grid that reflows without a media query.
 *
 * `columns="auto"` resolves to `repeat(auto-fill, minmax(min(--_min, 100%), 1fr))`.
 * Container queries would express the same intent more directly, and are
 * deliberately not used: a grid rendered through Portal into `document.body`
 * has no containment ancestor at all, so a container query silently never
 * matches and the grid stays at one column inside every dialog and popover in
 * the product. `auto-fill` is measured against the grid's own inline size and
 * therefore works everywhere it is rendered.
 *
 * The `min()` around the track floor is not decoration. `minmax(18rem, 1fr)`
 * in a container narrower than 18rem produces a track wider than the container
 * and overflows; clamping the floor at `100%` collapses to a single full-width
 * track instead, which is the behaviour every caller assumes they are getting.
 *
 * `columns` and `minItemWidth` are the two values here that travel through the
 * `style` prop rather than a data attribute. Unlike `gap` they are not steps on
 * a token scale — `minItemWidth` is an arbitrary length by definition — so
 * there is no finite set of rules that could express them. React assigns custom
 * properties through CSSOM rather than by writing a `style` attribute, so this
 * stays inside a `style-src` policy in the client-rendered case; a server-
 * rendered page would need `'unsafe-inline'` or a hashed style, which is the
 * one caveat worth knowing before adopting Grid in an SSR route.
 */
export const Grid = forwardRef<HTMLDivElement, GridProps>(function Grid(
  {
    columns = 'auto',
    minItemWidth = '16rem',
    gap = '4',
    align,
    asChild = false,
    className,
    style,
    ...rest
  },
  ref,
) {
  const Component = asChild ? Slot : 'div'

  // Only the property the active template actually reads is emitted, so a
  // fixed-column grid does not carry a dead track floor around in its markup.
  const gridVars: Record<string, string> =
    columns === 'auto'
      ? { '--_min': toLength(minItemWidth) }
      : { '--_columns': String(Math.max(1, Math.trunc(columns))) }

  return (
    <Component
      ref={ref}
      data-tl="grid"
      data-columns={columns === 'auto' ? 'auto' : 'fixed'}
      data-gap={gap}
      data-align={align}
      className={cx('tl-grid', className)}
      // Consumer style last so an explicit override still wins.
      style={{ ...gridVars, ...style } as CSSProperties}
      {...rest}
    />
  )
})
