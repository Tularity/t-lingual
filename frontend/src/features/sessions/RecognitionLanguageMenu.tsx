import { useState } from 'react'
import { Menu, MenuCheckboxItem, MenuItem, MenuSeparator, Icon } from '@t-lingual/ui'
import { useI18n } from '../../app/i18n'
import { errorMessage } from '../../app/utils'
import { LanguageLabel, languageDisplayName, languageFlag } from '../languages'
import { useRecognitionLanguages } from './useRecognitionLanguages'
import './recognition-menu.css'

export function RecognitionLanguageMenu({value,disabled,onSave}: {
  value:string[];disabled?:boolean;onSave:(languages:string[])=>Promise<void>
}) {
  const {t,locale}=useI18n()
  const [open,setOpen]=useState(false)
  const [draft,setDraft]=useState(value)
  const [query,setQuery]=useState('')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const languages=useRecognitionLanguages(open&&!disabled)
  const effective=value.includes('auto')||!value.length?(languages.capabilities?.languages??['auto']):value
  const allowed=languages.capabilities?.languages
  const validDraft=allowed?draft.filter(code=>allowed.includes(code)):draft
  const selection=validDraft.length?validDraft:allowed??draft
  const save=async()=>{
    if(!selection.length||saving)return
    setSaving(true);setError('')
    try{await onSave(selection);languages.remember(selection);setOpen(false)}catch(caught){setError(errorMessage(caught))}finally{setSaving(false)}
  }
  const choices=languages.choices.filter(item=>`${item.label} ${item.native} ${languageDisplayName(item.code,locale)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))
  return <Menu open={open} onOpenChange={next=>{if(saving)return;setOpen(next);if(next){setDraft(effective);setError('');setQuery('')}}} className="recognition-language-menu" placement="bottom-start" trigger={<button type="button" className="recognition-language-trigger" disabled={disabled} aria-label={t('Recognition languages')} title={effective.map(code=>languageDisplayName(code,locale)).join(' · ')}><span>{effective.slice(0,4).map(code=><img key={code} src={languageFlag(code)} width={21} height={21} alt={languageDisplayName(code,locale)} />)}{effective.length>4&&<small>+{effective.length-4}</small>}</span><Icon name="chevronDown" size={14} /></button>}>
    <div className="recognition-language-menu__hint">{t('Languages in this conversation')}</div>
    {languages.choices.length>8&&<div className="recognition-language-menu__search"><input type="search" aria-label={t('Search languages')} placeholder={t('Search languages…')} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key!=='Escape')event.stopPropagation()}} /></div>}
    {languages.loading&&<div className="recognition-language-menu__hint" role="status">{t('Loading recognition languages…')}</div>}
    {languages.error&&<MenuItem closeOnSelect={false} onSelect={languages.retry}>{t('Try again')}</MenuItem>}
    <div className="recognition-language-menu__choices">{choices.map(language=><MenuCheckboxItem key={language.code} checked={selection.includes(language.code)} disabled={saving||selection.length===1&&selection.includes(language.code)} onCheckedChange={checked=>setDraft(checked?[...selection,language.code]:selection.filter(code=>code!==language.code))}><LanguageLabel code={language.code} /></MenuCheckboxItem>)}</div>
    {!languages.loading&&!choices.length&&!languages.error&&<div className="recognition-language-menu__hint">{t('No matching languages')}</div>}
    <MenuSeparator />
    {(error||languages.error)&&<p className="recognition-language-menu__error" role="alert">{t(error||languages.error)}</p>}
    <MenuItem disabled={saving||!selection.length||languages.loading||!!languages.error} closeOnSelect={false} icon={<Icon name="check" size={16} />} onSelect={()=>void save()}>{saving?t('Saving…'):t('Apply languages')}</MenuItem>
  </Menu>
}
