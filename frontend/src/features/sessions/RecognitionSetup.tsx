import { useEffect, useState } from 'react'
import { useI18n } from '../../app/i18n'
import { Checkbox, Fieldset } from '@tular/ui'
import { Button, Input } from '../../design-system'
import type { CreateSessionInput } from '../../api/contracts'
import { LanguageLabel, languageDisplayName } from '../languages'
import { useRecognitionLanguages } from './useRecognitionLanguages'

export function RecognitionSetup({ value, onChange, disabled }: { value: CreateSessionInput; onChange: (value: CreateSessionInput) => void; disabled: boolean }) {
  const {t,locale}=useI18n()
  const languages=useRecognitionLanguages()
  const [expanded,setExpanded]=useState(false)
  const [query,setQuery]=useState('')
  const selected=value.recognitionLanguages??[]
  useEffect(()=>{
    if(!languages.capabilities?.languages.length)return
    const allowed=languages.capabilities.languages
    const next=(value.recognitionLanguages??[]).filter(code=>allowed.includes(code))
    if(!next.length)next.push(...(value.sourceLanguage==='auto'?allowed:[allowed.includes(value.sourceLanguage)?value.sourceLanguage:allowed[0]!]))
    if(JSON.stringify(next)!==JSON.stringify(value.recognitionLanguages))onChange({...value,sourceLanguage:next.length===1?next[0]!:'auto',recognitionLanguages:next})
  },[languages.capabilities,onChange,value])
  const filtered=languages.choices.filter(item=>`${item.label} ${item.native} ${languageDisplayName(item.code,locale)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const visible=expanded?filtered:languages.choices.slice(0,8)
  return <div className="recognition-setup">
    <Fieldset legend={t('Languages in this conversation')} hint={t('Choose the languages you expect. Multiple choices use automatic recognition.')} disabled={disabled}>
      {languages.loading&&<p role="status">{t('Loading recognition languages…')}</p>}
      {languages.error&&<p role="alert">{t(languages.error)} <Button variant="ghost" size="sm" onClick={languages.retry}>{t('Try again')}</Button></p>}
      {languages.capabilities&&!languages.capabilities.configured&&<p>{t('Recognition service is not configured yet.')}</p>}
      {expanded&&<Input label={t('Search languages')} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('Search languages…')} />}
      <div className="recognition-choices" data-expanded={expanded||undefined}>{visible.map(language=><Checkbox key={language.code} label={<LanguageLabel code={language.code} compact>{language.label}</LanguageLabel>} checked={selected.includes(language.code)} disabled={disabled||selected.length===1&&selected.includes(language.code)} onChange={event=>{
        const next=event.target.checked?[...selected,language.code]:selected.filter(code=>code!==language.code)
        onChange({...value,sourceLanguage:next.length===1?next[0]!:'auto',recognitionLanguages:next})
        if(event.target.checked)languages.remember([language.code])
      }} />)}</div>
      {expanded&&!visible.length&&<p>{t('No matching languages')}</p>}
      {languages.choices.length>8&&<Button variant="ghost" size="sm" aria-expanded={expanded} onClick={()=>{setExpanded(!expanded);setQuery('')}}>{expanded?t('Show fewer languages'):t('Show all {count} languages',{count:languages.choices.length})}</Button>}
    </Fieldset>

    <p className="recognition-preview-note">{t('Translation follows each viewer’s language preference and can be changed inside the transcript.')}</p>
  </div>
}
