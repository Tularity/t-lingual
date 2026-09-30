/* Which way a workspace page enters.
 *
 * Movement that always comes from the same side is decoration. Following the
 * sidebar's order instead makes the entrance say where the page is: moving
 * down the list the new page rises from below, moving back up it drops from
 * above. Opening a session or a transcript goes one level in and always reads
 * as forward; coming back out always reads as back. */

/** The sidebar's order, with every workspace at `/workspaces/`; quick setup comes before all of it. */
const ORDER = ['/setup', '/workspaces/', '/workspaces', '/shared-with-you', '/settings', '/usage', '/admin/codes', '/admin/people', '/admin/usage', '/admin/activity', '/admin/operations', '/admin/engines', '/admin/site']

/** One key per page, so the same page under another spelling does not re-enter. */
export function pageKey(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, '') : path
}

function place(key: string, workspaces: readonly string[]): { rank: number; within: number; depth: number } {
  if (key.startsWith('/live/') || key.startsWith('/sessions/')) return { rank: ORDER.indexOf('/workspaces/'), within: 0, depth: 1 }
  if (key.startsWith('/workspaces/')) {
    const index = workspaces.indexOf(key.slice('/workspaces/'.length))
    return { rank: ORDER.indexOf('/workspaces/'), within: index < 0 ? workspaces.length : index, depth: 0 }
  }
  const rank = ORDER.indexOf(key)
  return { rank: rank < 0 ? ORDER.length : rank, within: 0, depth: 0 }
}

/**
 * 1 enters from below (forward), -1 from above (back). `workspaces` are the
 * user's workspace ids in the order the sidebar lists them.
 */
export function pageDirection(from: string, to: string, workspaces: readonly string[] = []): 1 | -1 {
  const a = place(from, workspaces), b = place(to, workspaces)
  if (b.depth !== a.depth) return b.depth > a.depth ? 1 : -1
  if (b.rank !== a.rank) return b.rank > a.rank ? 1 : -1
  return b.within >= a.within ? 1 : -1
}
