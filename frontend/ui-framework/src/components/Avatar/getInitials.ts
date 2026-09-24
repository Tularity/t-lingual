/**
 * Reduces a person's name to the one or two characters an avatar can show.
 *
 * The naive implementation — split on spaces, take the first letter of the
 * first and last word, uppercase both — is wrong for a large share of the
 * world's names, and t-lingual's users are by definition multilingual.
 *
 * Scripts written without word separators are the loud failure. 王小明 is one
 * "word", so a Latin-style rule yields 王 twice or the whole name; the reading
 * that a Chinese, Japanese or Korean speaker expects is the single leading
 * character, which is the surname. So an ideographic or syllabic leading
 * character short-circuits to exactly one character.
 *
 * The rest of the rules exist for cases that turn up constantly in real data:
 * a single-word name gives one initial rather than two copies of the same
 * letter; a middle name is skipped in favour of the family name at the end;
 * punctuation-only tokens are ignored so "Maria (interpreter)" does not become
 * "M("; and every character is taken through `Array.from` so an astral
 * codepoint is not sliced in half into two replacement glyphs.
 */

/**
 * Scripts whose first character stands alone as an abbreviation. Hangul is
 * included with the CJK ideographs and kana: a Korean name is written without
 * spaces in the same way, and 김민준 abbreviates to 김.
 */
const SINGLE_CHARACTER_SCRIPTS =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** A token that contributes an initial has to contain a letter or a digit. */
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u

function firstMeaningfulCharacter(word: string): string {
  for (const character of word) {
    if (HAS_ALPHANUMERIC.test(character)) return character
  }
  return ''
}

export function getInitials(name: string | null | undefined, maxLength = 2): string {
  if (!name) return ''

  const trimmed = name.trim()
  if (!trimmed) return ''

  if (SINGLE_CHARACTER_SCRIPTS.test(trimmed)) {
    return Array.from(trimmed)[0] ?? ''
  }

  const words = trimmed.split(/\s+/).filter((word) => HAS_ALPHANUMERIC.test(word))
  if (words.length === 0) return ''

  const first = firstMeaningfulCharacter(words[0])
  if (words.length === 1 || maxLength < 2) {
    return first.toLocaleUpperCase()
  }

  const last = firstMeaningfulCharacter(words[words.length - 1])
  return `${first}${last}`.toLocaleUpperCase()
}
