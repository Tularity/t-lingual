/**
 * Minimal class-name joiner.
 *
 * The framework takes no runtime dependency for this: the whole useful surface
 * of `clsx` for our purposes is "drop the falsy ones and join with a space",
 * and a dependency that ships its own semver timeline for 200 bytes of logic is
 * a poor trade in a package meant to be embedded.
 */
export type ClassValue = string | number | false | null | undefined

export function cx(...values: ClassValue[]): string | undefined {
  let out = ''
  for (const value of values) {
    if (!value && value !== 0) continue
    out = out ? `${out} ${value}` : String(value)
  }
  return out || undefined
}
