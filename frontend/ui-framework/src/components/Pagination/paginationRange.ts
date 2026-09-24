/** A page number, or a gap standing in for the pages that were left out. */
export type PaginationItem = number | 'ellipsis'

function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let page = start; page <= end; page += 1) out.push(page)
  return out
}

/**
 * Works out which page numbers to render, and where the gaps go.
 *
 * This lives apart from the component because it is the only part of pagination
 * with anything to get wrong, and all of it is off-by-one arithmetic that is
 * far easier to assert against a table of cases than to eyeball in a browser at
 * eleven different page counts.
 *
 * The design constraint that produces the shape of the code: the number of
 * slots must not change as the user pages through, or the buttons shuffle
 * sideways under the pointer between clicks and the next click lands on a page
 * nobody chose. So the width is fixed at `2 * siblings + 5` — the first page,
 * the last page, the current page, its siblings on both sides, and two gaps —
 * and when only one gap is needed the space the other would have taken is
 * spent on extra page numbers at that end instead of being left blank.
 *
 * A gap has to stand for something. The boundary tests are `> 2` and
 * `< pageCount - 1` rather than the more obvious `> 1` and `< pageCount`
 * because at those looser bounds the ellipsis would sit exactly where the page
 * it replaced used to be, hiding nothing and costing the user a click target.
 */
export function paginationRange(
  current: number,
  total: number,
  siblings = 1,
): PaginationItem[] {
  const pageCount = Math.floor(total)
  if (!Number.isFinite(pageCount) || pageCount < 1) return []

  const siblingCount = Math.max(Math.floor(siblings), 0)
  const page = Math.min(Math.max(Math.floor(current) || 1, 1), pageCount)

  // First, last, current, both sibling groups, and the two gaps.
  const slots = siblingCount * 2 + 5
  if (slots >= pageCount) return range(1, pageCount)

  const leftSibling = Math.max(page - siblingCount, 1)
  const rightSibling = Math.min(page + siblingCount, pageCount)

  const showLeftGap = leftSibling > 2
  const showRightGap = rightSibling < pageCount - 1

  // The run of pages shown at whichever end has no gap. It absorbs the slot the
  // missing ellipsis would have occupied, which is what keeps the total width
  // constant.
  const runLength = siblingCount * 2 + 3

  if (!showLeftGap && showRightGap) {
    return [...range(1, runLength), 'ellipsis', pageCount]
  }

  if (showLeftGap && !showRightGap) {
    return [1, 'ellipsis', ...range(pageCount - runLength + 1, pageCount)]
  }

  return [1, 'ellipsis', ...range(leftSibling, rightSibling), 'ellipsis', pageCount]
}
