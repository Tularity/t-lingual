import {useI18n} from '../../app/i18n'
import { useState } from 'react'
import { Tooltip } from '@t-lingual/ui'
import { LanguageLabel, languageFlag, languageDisplayName } from './LanguageLabel'

/** Compact language display with the full name available by pointer or keyboard. */
export function LanguageFlag({ code, kind = 'source' }: { code: string; kind?: 'source' | 'target' }) {
  const {t,locale}=useI18n()
  const [open, setOpen] = useState(false)
  const label = `${t(kind === 'source' ? 'Spoken language' : 'Translation language')}: ${languageDisplayName(code,locale)}`
  return <Tooltip content={<LanguageLabel code={code} />} open={open} onOpenChange={setOpen} openDelay={180}>
    <button className="language-flag-only" type="button" aria-label={label} onClick={() => setOpen(value => !value)}>
      <img src={languageFlag(code) ?? '/flags/globe.svg'} width={19} height={19} alt="" aria-hidden="true" />
    </button>
  </Tooltip>
}
