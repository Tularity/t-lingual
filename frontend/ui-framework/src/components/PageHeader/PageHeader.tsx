import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './PageHeader.css'

export type PageHeaderLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  /** Small label above the title: a section name, a status, a workspace. */
  eyebrow?: ReactNode
  description?: ReactNode
  /** Primary and secondary controls for this screen. */
  actions?: ReactNode
  /** Slot for a breadcrumb trail, rendered above everything else. */
  breadcrumb?: ReactNode
  /** Heading level for the title. Defaults to 1. */
  level?: PageHeaderLevel
  /** Pins the header to the top of its scroll container as the page scrolls. */
  sticky?: boolean
  /** Rule along the bottom edge. Defaults on when `sticky`. */
  divider?: boolean
}

/**
 * The title block of a screen.
 *
 * Renders a `<header>`, which is the right element for this content but carries
 * one trap worth stating: `<header>` maps to the `banner` landmark only when it
 * is not inside `<main>`, `<article>`, `<aside>`, `<nav>` or `<section>`. A page
 * header placed as a direct child of `<body>` therefore claims the banner role
 * that belongs to the app chrome. Inside `<main>`, where this component is meant
 * to live, it is a plain grouping element and there is nothing to think about.
 *
 * The title is an `<h1>` by default because this is the heading of a screen and
 * every screen should have exactly one. `level` exists for the cases where the
 * component is reused for a sub-screen inside an already-titled shell, not as a
 * styling knob — the visual size does not follow the level, so dropping to `h2`
 * changes only the document outline.
 *
 * `sticky` fails silently in one situation that is worth knowing before
 * debugging it: `position: sticky` is scoped to the nearest scrolling ancestor,
 * so any ancestor with `overflow: hidden`, `auto` or `scroll` between the header
 * and the scroll container turns it back into a static element with no error of
 * any kind. The sticky header also opts into a background: without one, the
 * page content scrolls visibly through the title.
 */
export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  {
    title,
    eyebrow,
    description,
    actions,
    breadcrumb,
    level = 1,
    sticky = false,
    divider = sticky,
    className,
    children,
    ...rest
  },
  ref,
) {
  const titleId = useId()

  const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

  return (
    <header
      ref={ref}
      data-tl="page-header"
      data-sticky={sticky || undefined}
      data-divider={divider || undefined}
      className={cx('tl-page-header', className)}
      // Only when the consumer has promoted this to a landmark with an explicit
      // `role`. Inside `<main>` — the placement documented above — `<header>` is
      // `role="generic"`, and `aria-labelledby` is a prohibited attribute there:
      // it names nothing and it is a hard failure in every automated audit. The
      // title keeps its `id` regardless, so a consumer passing `role="region"`
      // or wiring their own reference still has something to point at.
      aria-labelledby={rest.role ? titleId : undefined}
      {...rest}
    >
      {breadcrumb && <div className="tl-page-header__breadcrumb">{breadcrumb}</div>}

      <div className="tl-page-header__main">
        <div className="tl-page-header__text">
          {eyebrow && <p className="tl-page-header__eyebrow">{eyebrow}</p>}

          <Heading id={titleId} className="tl-page-header__title">
            {title}
          </Heading>

          {description && <p className="tl-page-header__description">{description}</p>}
        </div>

        {actions && <div className="tl-page-header__actions">{actions}</div>}
      </div>

      {children && <div className="tl-page-header__extra">{children}</div>}
    </header>
  )
})
