import {useI18n} from '../../app/i18n'
import {languageDisplayName} from './LanguageLabel'
import { useId } from 'react'
import { Select, SelectOption } from '@t-lingual/ui'
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

/** The framework select, with every choice and the chosen field showing its flag. */
export function LanguageSelect({
  label, value, onChange, languages = allLanguages, includeAuto = false,
  disabled = false, hint, error,
}: LanguageSelectProps) {
  const {locale}=useI18n()
  const id = useId()
  const fieldId = `${id}-language`
  const labelId = `${id}-label`
  const descriptionId = `${id}-description`
  const choices = includeAuto && !languages.some((language) => language.code === 'auto')
    ? [{ code: 'auto', label: 'Detect automatically' }, ...languages]
    : languages

  return <div className="language-select tl-field" data-disabled={disabled || undefined} data-invalid={Boolean(error) || undefined}>
    <label id={labelId} htmlFor={fieldId} className="tl-field__label">{label}</label>
    <Select id={fieldId} fullWidth value={value} onValueChange={onChange} disabled={disabled} invalid={Boolean(error)}
      aria-labelledby={labelId} aria-describedby={hint || error ? descriptionId : undefined} menuClassName="language-select__menu"
      renderValue={(code) => <LanguageLabel code={code} compact>{choices.find((language) => language.code === code)?.label}</LanguageLabel>}>
      {choices.map((language) => <SelectOption key={language.code} value={language.code} textValue={languageDisplayName(language.code,locale)}>
        <LanguageLabel code={language.code} native>{language.label}</LanguageLabel>
      </SelectOption>)}
    </Select>
    {(hint || error) && <p id={descriptionId} role={error ? 'alert' : undefined} className={error ? 'language-select__error' : 'language-select__hint'}>{error || hint}</p>}
  </div>
}
