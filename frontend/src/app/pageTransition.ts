/* Which way a workspace page enters.
 *
 * Movement that always comes from the same side is decoration. Following the
 * sidebar's order instead makes the entrance say where the page is: moving
 * down the list the new page rises from below, moving back up it drops from
 * above. Opening a session or a transcript goes one level in and always reads
 * as forward; coming back out always reads as back. */

/** The sidebar's order; quick setup comes before all of it. */
const ORDER = ['/setup', '/sessions', '/history', '/settings', '/admin']

/** One key per page, so the same page under another spelling does not re-enter. */
export function pageKey(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, '') : path
  return trimmed === '/' ? '/sessions' : trimmed
}

function place(key: string): { rank: number; depth: number } {
  if (key.startsWith('/live/')) return { rank: ORDER.indexOf('/sessions'), depth: 1 }
  if (key.startsWith('/history/')) return { rank: ORDER.indexOf('/history'), depth: 1 }
  const rank = ORDER.indexOf(key)
  return { rank: rank < 0 ? ORDER.length : rank, depth: 0 }
}

/** 1 enters from below (forward), -1 from above (back). */
export function pageDirection(from: string, to: string): 1 | -1 {
  const a = place(from), b = place(to)
  if (b.depth !== a.depth) return b.depth > a.depth ? 1 : -1
  return b.rank >= a.rank ? 1 : -1
}
