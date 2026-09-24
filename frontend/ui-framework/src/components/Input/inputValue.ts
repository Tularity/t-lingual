/**
 * Value plumbing shared by the text-entry controls.
 *
 * Small, but not inlinable: `setNativeValue` is subtle enough that having two
 * copies of it drift apart would be a genuine bug, and it is the one piece of
 * this group worth testing on its own.
 */

/** Normalises the union React allows for `value` / `defaultValue` to a string. */
export function toText(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.join(',')
  return String(value)
}

/**
 * Writes a value into a control the way a user would, so React notices.
 *
 * Assigning `element.value` directly does change the DOM, but React keeps a
 * value tracker on the node and compares against it before dispatching a
 * synthetic change — so the assignment updates the pixels and then the very
 * next `onChange` is swallowed, leaving a controlled input permanently out of
 * sync with its own state. Going through the prototype's setter bypasses the
 * tracker, and the dispatched `input` event is what React's root listener turns
 * into `onChange`.
 *
 * The pay-off is that a clear button works identically for a controlled and an
 * uncontrolled control without the consumer wiring anything extra: the
 * controlled one hears about the change through its existing `onChange`.
 */
export function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  next: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set

  if (setter) setter.call(element, next)
  else element.value = next

  element.dispatchEvent(new Event('input', { bubbles: true }))
}
