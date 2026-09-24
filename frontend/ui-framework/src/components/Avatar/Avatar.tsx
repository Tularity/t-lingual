import {
  Children,
  createContext,
  forwardRef,
  useContext,
  useMemo,
  useState,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import { getInitials } from './getInitials'
import './Avatar.css'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg'
export type AvatarShape = 'circle' | 'square'

interface AvatarGroupContextValue {
  size: AvatarSize | undefined
  shape: AvatarShape | undefined
}

const AvatarGroupContext = createContext<AvatarGroupContextValue>({
  size: undefined,
  shape: undefined,
})

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  src?: string
  /**
   * Accessible name. Defaults to `name`; pass `""` for an avatar that sits
   * beside the person's name in the same row and would only repeat it.
   */
  alt?: string
  /** Used for the initials and, unless `alt` says otherwise, for the name. */
  name?: string
  size?: AvatarSize
  shape?: AvatarShape
  /** Replaces the initials — a glyph for a system actor, say. */
  fallback?: ReactNode
  imgProps?: ImgHTMLAttributes<HTMLImageElement>
}

/**
 * A person, as a small square or circle.
 *
 * THE FALLBACK IS STATE, NOT ALT TEXT
 * -----------------------------------
 * "Just give the `<img>` an alt attribute and let the browser handle it" is the
 * usual shortcut and it is not good enough here. A broken image renders as the
 * engine's own placeholder — a torn page in Firefox, a grey box in Chrome —
 * with the alt text spilling out of a 32px box at whatever length the name
 * happens to be, next to nineteen other avatars in a table. So a load failure
 * is tracked and the component swaps to initials, which is a design that fits
 * the space.
 *
 * The failure is remembered as the URL that failed rather than as a boolean.
 * That detail is what makes a changed `src` retry automatically: a boolean
 * would need an effect to clear it, and the render between the new `src` and
 * that effect firing would show the old error state.
 *
 * When the image is shown it carries the name through its own `alt`. When the
 * initials are shown they are hidden from assistive technology and the wrapper
 * carries the name instead, because "AB" is a visual abbreviation and not
 * something anyone wants read aloud.
 */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { src, alt, name, size, shape, fallback, imgProps, className, ...rest },
  ref,
) {
  const group = useContext(AvatarGroupContext)
  const resolvedSize = size ?? group.size ?? 'md'
  const resolvedShape = shape ?? group.shape ?? 'circle'

  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImage = Boolean(src) && failedSrc !== src

  const label = alt ?? name ?? ''
  const {
    className: imgClassName,
    onError: imgOnError,
    ...imgRest
  } = imgProps ?? {}

  return (
    <span
      ref={ref}
      data-tl="avatar"
      data-size={resolvedSize}
      data-shape={resolvedShape}
      data-fallback={showImage ? undefined : ''}
      className={cx('tl-avatar', className)}
      role={!showImage && label ? 'img' : undefined}
      aria-label={!showImage && label ? label : undefined}
      {...rest}
    >
      {showImage ? (
        <img
          loading="lazy"
          decoding="async"
          {...imgRest}
          className={cx('tl-avatar__image', imgClassName)}
          src={src}
          alt={label}
          onError={(event) => {
            imgOnError?.(event)
            setFailedSrc(src ?? null)
          }}
        />
      ) : (
        <span className="tl-avatar__fallback" aria-hidden="true">
          {fallback ?? getInitials(name)}
        </span>
      )}
    </span>
  )
})

export interface AvatarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Avatars shown before the overflow chip takes over. */
  max?: number
  /** Applied to every child that does not set its own. */
  size?: AvatarSize
  shape?: AvatarShape
  /**
   * Real number of people, when the caller only rendered the first few. The
   * overflow count is taken from this rather than from the child count.
   */
  total?: number
  /** Accessible text for the overflow chip, for translation. */
  overflowLabel?: (count: number) => string
}

/**
 * An overlapping stack of avatars with a "+N" chip.
 *
 * The chip shows "+3" and is announced as "3 more": the plus sign is a
 * typographic convention that reads as "plus three" and means nothing to
 * someone who cannot see the row it belongs to.
 *
 * Size and shape are pushed down through context rather than cloned onto the
 * children, so a consumer can pass anything — an Avatar, an Avatar wrapped in
 * a Tooltip, a router link around one — and it still inherits the group's
 * geometry. Cloning would only reach a direct Avatar child and would silently
 * do nothing for the wrapped cases, which are the common ones.
 */
export const AvatarGroup = forwardRef<HTMLDivElement, AvatarGroupProps>(
  function AvatarGroup(
    {
      max,
      size,
      shape,
      total,
      overflowLabel = (count) => `${count} more`,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const context = useMemo<AvatarGroupContextValue>(() => ({ size, shape }), [size, shape])

    const items = Children.toArray(children)
    const visible = max != null && items.length > max ? items.slice(0, max) : items
    const overflow = Math.max((total ?? items.length) - visible.length, 0)

    // A group with no name is a decorative cluster; giving it `role="group"`
    // anyway would add an unnamed grouping to the accessibility tree that a
    // user has to step into to discover it says nothing.
    const named = rest['aria-label'] != null || rest['aria-labelledby'] != null

    return (
      <AvatarGroupContext.Provider value={context}>
        <div
          ref={ref}
          data-tl="avatar-group"
          data-size={size}
          className={cx('tl-avatar-group', className)}
          role={named ? 'group' : undefined}
          {...rest}
        >
          {visible}
          {overflow > 0 && (
            <span
              data-tl="avatar-overflow"
              data-size={size ?? 'md'}
              data-shape={shape ?? 'circle'}
              className="tl-avatar tl-avatar-group__overflow"
            >
              <span className="tl-avatar__fallback" aria-hidden="true">
                +{overflow}
              </span>
              <VisuallyHidden>{overflowLabel(overflow)}</VisuallyHidden>
            </span>
          )}
        </div>
      </AvatarGroupContext.Provider>
    )
  },
)
