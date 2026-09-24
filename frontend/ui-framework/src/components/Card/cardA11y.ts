/**
 * Which roles can take their accessible name from what is inside them.
 *
 * ARIA splits nameable roles into "name from author" and "name from author,
 * contents". The distinction decides whether a Card that has been given a role
 * needs an `aria-label`: a `role="button"` card is named by the text a user can
 * already see, while a `role="region"` card with no author-supplied name is not
 * exposed as a landmark at all and quietly disappears from the landmark list —
 * a failure that no visual review will ever catch.
 *
 * Kept as its own module rather than a constant inside Card.tsx because it is
 * a pure function over a fixed table and is the part of Card worth testing
 * directly, without rendering anything.
 */

/** ARIA 1.2 roles whose accessible name may be computed from their contents. */
const NAME_FROM_CONTENTS: ReadonlySet<string> = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'comment',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'suggestion',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
])

/**
 * Roles that cannot carry an accessible name at all. Naming one is a no-op
 * rather than an omission, so they are treated the same as name-from-contents:
 * there is nothing for a caller to fix.
 */
const NOT_NAMEABLE: ReadonlySet<string> = new Set(['generic', 'none', 'presentation'])

/**
 * True when a Card carrying `role` does not need an author-supplied label.
 *
 * An absent role resolves to `generic`, which is neither exposed nor nameable,
 * so it answers true — a plain Card is never missing a name.
 */
export function cardRoleAllowsAutomaticLabel(role?: string | null): boolean {
  if (!role) return true

  // A role attribute is a space-separated fallback list; the first token the
  // engine understands is the one that applies, and in practice that is the
  // first token. Matching the whole string would miss `role="button link"`.
  const primary = role.trim().split(/\s+/)[0]?.toLowerCase()
  if (!primary) return true

  return NAME_FROM_CONTENTS.has(primary) || NOT_NAMEABLE.has(primary)
}
