import {useI18n} from '../../app/i18n'
import {languageDisplayName} from './LanguageLabel'
import { useEffect, useId, useState } from 'react'
import { Icon, Menu, MenuRadioGroup, MenuRadioItem } from '@t-lingual/ui'
import { languages as allLanguages } from '../../app/utils'
import { LanguageLabel } from './LanguageLabel'

export interface LanguageSelectProps {
  label: string
  value: string
  onChange: (value: string) => void
  languages?: Array<{ code: string; label: string; native?: string }>
  includeAuto?: boolean
  disabled?: boolean
  hint?: string
  error?: string
}

/** A menu-button selection control: the selected field and every option retain their icon. */
export function LanguageSelect({
  label, value, onChange, languages = allLanguages, includeAuto = false,
  disabled = false, hint, error,
}: LanguageSelectProps) {
  const {locale}=useI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [menuNode, setMenuNode] = useState<HTMLDivElement | null>(null)
  const fieldId = `${id}-language`
  const labelId = `${id}-label`
  const valueId = `${id}-value`
  const descriptionId = `${id}-description`
  const choices = includeAuto && !languages.some((language) => language.code === 'auto')
    ? [{ code: 'auto', label: 'Detect automatically' }, ...languages]
    : languages
  const selected = choices.find((language) => language.code === value)

  useEffect(() => {
    if (!open || !menuNode) return
    const current = menuNode.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
    current?.focus({ preventScroll: true })
    current?.scrollIntoView?.({ block: 'nearest' })
  }, [menuNode, open, value])

  return <div className="language-select tl-field" data-disabled={disabled || undefined} data-invalid={Boolean(error) || undefined}>
    <label id={labelId} htmlFor={fieldId} className="tl-field__label">{label}</label>
    <Menu
      ref={setMenuNode}
      open={open}
      onOpenChange={setOpen}
      className="language-select__menu"
      placement="bottom-start"
      trigger={<button type="button" id={fieldId} className="language-select__trigger" disabled={disabled} aria-labelledby={`${labelId} ${valueId}`} aria-describedby={hint || error ? descriptionId : undefined} aria-invalid={Boolean(error) || undefined}>
        <span id={valueId} className="language-select__current"><LanguageLabel code={value} compact>{selected?.label}</LanguageLabel></span>
        <Icon name="chevronDown" size={16} aria-hidden="true" />
      </button>}
    >
      <MenuRadioGroup value={value} onValueChange={onChange}>
        {choices.map((language) => <MenuRadioItem key={language.code} value={language.code} textValue={languageDisplayName(language.code,locale)}>
          <LanguageLabel code={language.code} native>{language.label}</LanguageLabel>
        </MenuRadioItem>)}
      </MenuRadioGroup>
    </Menu>
    {(hint || error) && <p id={descriptionId} role={error ? 'alert' : undefined} className={error ? 'language-select__error' : 'language-select__hint'}>{error || hint}</p>}
  </div>
}
