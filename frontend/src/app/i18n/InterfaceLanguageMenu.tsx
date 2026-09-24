import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Popover } from '@t-lingual/ui'
import { Button, Icon } from '../../design-system'
import { useI18n } from './index'
import { localeAvailable } from './catalogs'
import { interfaceLocaleFlag, interfaceLocaleName, searchInterfaceLocales, type InterfaceLanguage } from './locales'
import './interface-language-menu.css'

export function InterfaceLanguageMenu({ compact = true }: { compact?: boolean }) {
  const { t, languagePreference, resolvedLanguage, systemLanguage, setLanguagePreference } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const choices = useMemo(() => searchInterfaceLocales(query, resolvedLanguage), [query, resolvedLanguage])
  const select = (locale: InterfaceLanguage) => { if (locale !== 'system' && !localeAvailable(locale)) return; setLanguagePreference(locale); setOpen(false); setQuery('') }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-locale-option]'))
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length
    if (buttons[next]) { event.preventDefault(); buttons[next].focus() }
  }
  const flag = interfaceLocaleFlag(resolvedLanguage)
  return <Popover aria-label={t('Interface language')} placement="bottom-end" open={open}
    onOpenChange={next => { setOpen(next); if (!next) setQuery('') }} initialFocus={searchRef}
    className="interface-language-popover"
    trigger={<Button variant={compact ? 'ghost' : 'secondary'} iconOnly={compact}
      className={compact ? 'app-preferences__trigger' : 'interface-language-field'}
      aria-label={t('Interface language')} title={t('Interface language')}>
      <img className="app-preferences__flag" src={flag} alt="" />
      {!compact && <><span>{languagePreference === 'system' ? t('System language') : interfaceLocaleName(resolvedLanguage, resolvedLanguage)}</span><Icon name="chevronDown" size={14} /></>}
    </Button>}>
    <div className="interface-language-picker" onKeyDown={onKeyDown}>
      <label className="interface-language-picker__search">
        <Icon name="search" size={16} aria-hidden="true" />
        <input ref={searchRef} type="search" autoComplete="off" aria-label={t('Search languages')}
          placeholder={t('Search languages')} value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="interface-language-picker__list" role="listbox" aria-label={t('Interface language')}>
        <button type="button" role="option" aria-selected={languagePreference === 'system'} data-locale-option
          onClick={() => select('system')} className="interface-language-picker__row">
          <img src={interfaceLocaleFlag(systemLanguage)} alt="" />
          <span><strong>{t('System language')}</strong><small>{interfaceLocaleName(systemLanguage, resolvedLanguage)}</small></span>
          {languagePreference === 'system' && <Icon name="check" size={16} aria-hidden="true" />}
        </button>
        {choices.map(locale => <button type="button" role="option" aria-selected={languagePreference === locale}
          data-locale-option disabled={!localeAvailable(locale)} className="interface-language-picker__row" key={locale} onClick={() => select(locale)}>
          <img src={interfaceLocaleFlag(locale)} alt="" />
          <span><strong>{interfaceLocaleName(locale)}</strong><small>{localeAvailable(locale) ? interfaceLocaleName(locale, resolvedLanguage) : t('Translation pending')}</small></span>
          {languagePreference === locale && <Icon name="check" size={16} aria-hidden="true" />}
        </button>)}
        {!choices.length && <p className="interface-language-picker__empty">{t('No matching languages')}</p>}
      </div>
    </div>
  </Popover>
}
