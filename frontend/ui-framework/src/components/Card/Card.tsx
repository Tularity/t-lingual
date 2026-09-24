import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { cx } from '../../utils/cx'
import { Slot } from '../../primitives/Slot'
import { cardRoleAllowsAutomaticLabel } from './cardA11y'
import './Card.css'

export type CardVariant = 'default' | 'raised' | 'sunken' | 'outline'

export type CardPadding = 'none' | 'sm' | 'md' | 'lg'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant
  padding?: CardPadding
  /**
   * Gives the card a hover and press affordance and makes the whole surface
   * activatable. Read the note about what this does to the markup.
   */
  interactive?: boolean
  /** Render onto the child — the correct way to make an interactive card. */
  asChild?: boolean
}

export interface CardSectionProps extends HTMLAttributes<HTMLDivElement> {
  asChild?: boolean
}

const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"]'

/**
 * A surface that groups related content.
 *
 * INTERACTIVITY
 * -------------
 * `interactive` on a plain `<div>` is the classic accessibility failure: it
 * looks and behaves like a button for a mouse and does not exist at all for a
 * keyboard or a screen reader. This component refuses to produce that. Passing
 * `interactive` without `asChild` gets `role="button"`, `tabIndex={0}` and real
 * Enter/Space handling, so the div is at least a complete button; passing
 * `asChild` with a `<button>` or a router `<Link>` inside is the better answer
 * and the one to reach for, because a real element brings its own semantics,
 * its own context menu, and — for a link — a URL the user can copy or
 * middle-click.
 *
 * The keyboard handling deliberately mirrors the native button contract rather
 * than firing on any keypress. Enter activates on keydown, Space activates on
 * keyup and is `preventDefault`ed on keydown so holding it does not scroll the
 * page underneath. Both are ignored unless the event started on the card
 * itself: without that guard, pressing Enter inside a text field nested in the
 * card would submit the card as well as the field.
 *
 * A card that is itself a button must not contain other buttons — nested
 * interactive content inside a `role="button"` is unreachable for several
 * screen readers and ambiguous for everyone else. When a card needs both a
 * primary destination and secondary actions, leave the card inert and make the
 * title a link.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    variant = 'default',
    padding = 'md',
    interactive = false,
    asChild = false,
    className,
    role,
    tabIndex,
    onKeyDown,
    onKeyUp,
    ...rest
  },
  ref,
) {
  // With `asChild` the child is already a real control, so synthesising button
  // semantics on top of it would double up the role and the tab stop.
  const synthesised = interactive && !asChild
  const resolvedRole = role ?? (synthesised ? 'button' : undefined)
  const resolvedTabIndex = tabIndex ?? (synthesised ? 0 : undefined)

  if (
    import.meta.env?.DEV &&
    resolvedRole &&
    !cardRoleAllowsAutomaticLabel(resolvedRole) &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      `[t-lingual/ui] <Card role="${resolvedRole}"> needs \`aria-label\` or \`aria-labelledby\`. ` +
        'That role takes its name from the author, not from its contents, and without one it is ' +
        'exposed as an anonymous container.',
    )
  }

  const Component = asChild ? Slot : 'div'

  const activateFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return false
    // A nested field owns its own Enter and Space. Cheap belt-and-braces on top
    // of the target check, for the case where the field is the card itself via
    // `asChild`.
    if ((event.target as HTMLElement).closest?.(TEXT_ENTRY)) return false
    return true
  }

  return (
    <Component
      ref={ref}
      data-tl="card"
      data-variant={variant}
      data-padding={padding}
      data-interactive={interactive || undefined}
      className={cx('tl-card', className)}
      role={resolvedRole}
      tabIndex={resolvedTabIndex}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event)
        if (!synthesised || event.defaultPrevented) return
        if (!activateFromKeyboard(event)) return

        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.click()
        } else if (event.key === ' ') {
          // Swallow the keydown so the page does not scroll while the key is
          // held; the activation happens on keyup, as it does for <button>.
          event.preventDefault()
        }
      }}
      onKeyUp={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        onKeyUp?.(event)
        if (!synthesised || event.defaultPrevented) return
        if (!activateFromKeyboard(event)) return

        if (event.key === ' ') {
          event.preventDefault()
          event.currentTarget.click()
        }
      }}
      {...rest}
    />
  )
})

/**
 * Title row of a card. A container only — it has no opinion about heading
 * levels, because a card can be a list item in one screen and the whole page in
 * another and only the consumer knows which.
 */
export const CardHeader = forwardRef<HTMLDivElement, CardSectionProps>(function CardHeader(
  { asChild = false, className, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component
      ref={ref}
      data-tl="card-header"
      className={cx('tl-card__header', className)}
      {...rest}
    />
  )
})

export const CardBody = forwardRef<HTMLDivElement, CardSectionProps>(function CardBody(
  { asChild = false, className, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component ref={ref} data-tl="card-body" className={cx('tl-card__body', className)} {...rest} />
  )
})

export const CardFooter = forwardRef<HTMLDivElement, CardSectionProps>(function CardFooter(
  { asChild = false, className, ...rest },
  ref,
) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component
      ref={ref}
      data-tl="card-footer"
      className={cx('tl-card__footer', className)}
      {...rest}
    />
  )
})
