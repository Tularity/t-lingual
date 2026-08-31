import { formatDuration, formatTimestamp, languageName, languages } from './utils'

describe('time formatting', () => {
  it('shows seconds for short live sessions', () => {
    expect(formatDuration(42_000)).toBe('42s')
  })

  it('formats long segment offsets without wrapping at one hour', () => {
    expect(formatTimestamp(3_723_000)).toBe('1:02:03')
  })
})

describe('language catalogue', () => {
  it('exposes the complete translation model allowlist without duplicate codes', () => {
    expect(languages).toHaveLength(46)
    expect(new Set(languages.map((language) => language.code)).size).toBe(46)
    expect(languageName('zh-CN')).toBe('Chinese (Simplified)')
    expect(languageName('ja-JP')).toBe('Japanese')
    expect(languageName('yue')).toBe('Cantonese')
  })
})
