import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './EmptyState.css'

export type EmptyStateSize = 'sm' | 'md' | 'lg'

export type EmptyStateHeadingLevel = 2 | 3 | 4 | 5 | 6

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Decorative glyph or illustration. */
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Primary affordance — usually the thing that ends the emptiness. */
  action?: ReactNode
  /** Escape hatch: import, docs, "clear filters". */
  secondaryAction?: ReactNode
  /**
   * Promotes the title to a real heading at this level. See the note below on
   * why a heading is opt-in rather than the default.
   */
  headingLevel?: EmptyStateHeadingLevel
  /** `sm` fits inside a card; `lg` owns a page. */
  size?: EmptyStateSize
}

/**
 * The "there is nothing here yet" surface: no sessions, no search results, no
 * saved glossaries.
 *
 * The title renders as a paragraph unless `headingLevel` says otherwise, and
 * that default is a deliberate accessibility decision rather than laziness.
 * Headings are the primary navigation structure for screen reader users, so an
 * empty state dropped inside a card that silently emits an `<h2>` inserts a
 * section into the document outline that does not correspond to a section of
 * the page — and because the component cannot know its own nesting depth, any
 * level it picked would be wrong somewhere. When the empty state genuinely is
 * the content of a region, the consumer knows the level and says so.
 *
 * The icon is always decorative. An empty state whose meaning depends on
 * recognising a glyph has failed at its one job, which is to say in words what
 * is missing and what to do about it; the title and description carry that, and
 * a labelled icon would only make a screen reader read the picture twice.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  {
    icon,
    title,
    description,
    action,
    secondaryAction,
    headingLevel,
    size = 'md',
    className,
    children,
    ...rest
  },
  ref,
) {
  const Title = headingLevel ? (`h${headingLevel}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6') : 'p'

  return (
    <div
      {...rest}
      ref={ref}
      data-tl="empty-state"
      data-size={size}
      className={cx('tl-empty-state', className)}
    >
      {icon != null && (
        <span className="tl-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      )}

      <Title className="tl-empty-state__title">{title}</Title>

      {description != null && <p className="tl-empty-state__description">{description}</p>}

      {children}

      {(action != null || secondaryAction != null) && (
        <div className="tl-empty-state__actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  )
})
