import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { languages } from '../../app/utils'
import { LanguageLabel, languageFlag } from './index'

describe('language flags', () => {
  it('has a real local SVG for every supported language', () => {
    expect(languages).toHaveLength(46)
    for (const language of languages) {
      const path = languageFlag(language.code)
      expect(path, language.code).toMatch(/^\/flags\/[a-z-]+\.svg$/u)
      const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../public', path!.slice(1)), 'utf8')
      expect(bytes.startsWith('<svg'), language.code).toBe(true)
    }
  })

  it('maps regional aliases safely and uses a neutral icon for automatic language', () => {
    expect(languageFlag('en')).toBe('/flags/lang-en-au.svg')
    expect(languageFlag('en-US')).toBe('/flags/lang-en-au.svg')
    expect(languageFlag('ja-JP')).toBe('/flags/lang-ja.svg')
    expect(languageFlag('fr-FR')).toBe('/flags/lang-fr.svg')
    expect(languageFlag('zh-CN')).toBe('/flags/lang-zh.svg')
    expect(languageFlag('zh-TW')).toBe('/flags/tw.svg')
    expect(languageFlag('yue-HK')).toBe('/flags/hk.svg')
    expect(languageFlag('auto')).toBe('/flags/globe.svg')
    expect(languageFlag('mixed')).toBe('/flags/globe.svg')
    expect(languageFlag('../../credentials')).toBeUndefined()
  })

  it('keeps the flag decorative and omits repeated native English', () => {
    const { container } = render(<><LanguageLabel code="en" native /><LanguageLabel code="ja-JP" native /></>)
    expect(screen.getByText('English')).toBeInTheDocument()
    expect(screen.getAllByText('English')).toHaveLength(1)
    expect(screen.getByText('日本語')).toBeInTheDocument()
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(2)
    for (const image of images) {
      expect(image).toHaveAttribute('alt', '')
      expect(image).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
