/** A portalled menu belongs to the surface containing its trigger. */
export function surfaceContains(root: HTMLElement | null | undefined, target: Node | null): boolean {
  if (!root || !target) return false
  const seen = new Set<Node>()
  let node: Node | null = target
  while (node && !seen.has(node)) {
    if (root.contains(node)) return true
    seen.add(node)
    const element: Element | null = node instanceof Element ? node : node.parentElement
    const anchorId: string | null | undefined = element?.closest('[data-tl-anchor]')?.getAttribute('data-tl-anchor')
    node = anchorId ? root.ownerDocument.getElementById(anchorId) : null
  }
  return false
}
