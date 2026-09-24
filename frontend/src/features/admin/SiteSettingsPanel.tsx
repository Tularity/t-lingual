import {useEffect,useState,type FormEvent} from 'react'
import {Markdown} from '@t-lingual/ui'
import {api} from '../../api/client'
import type {SiteSettings} from '../../api/contracts'
import {useI18n} from '../../app/i18n'
import {authorizePasskeyAction} from '../../app/passkeyAuthorization'
import {normalizeHelpMarkdown,siteSettingsScope} from '../../app/siteSettings'
import {errorMessage} from '../../app/utils'
import {Button,Card,EmptyState,Icon,Input,Skeleton,Textarea,useToast} from '../../design-system'
import './site-settings.css'

export function SiteSettingsPanel() {
  const {t}=useI18n(),{push}=useToast()
  const [saved,setSaved]=useState<SiteSettings|null>(null)
  const [draft,setDraft]=useState<SiteSettings>({registrationHelpMarkdown:'',codeAttemptsPerMinute:3})
  const [error,setError]=useState('')
  const [attempt,setAttempt]=useState(0)
  const [saving,setSaving]=useState(false)
  useEffect(()=>{let active=true;void api.admin.siteSettings().then(value=>{if(active){setSaved(value);setDraft(value);setError('')}}).catch(caught=>{if(active)setError(errorMessage(caught))});return()=>{active=false}},[attempt])
  const bytes=new TextEncoder().encode(draft.registrationHelpMarkdown).length
  const changed=!!saved&&(draft.registrationHelpMarkdown!==saved.registrationHelpMarkdown||draft.codeAttemptsPerMinute!==saved.codeAttemptsPerMinute)
  const valid=bytes>0&&bytes<=8192&&draft.registrationHelpMarkdown.trim().length>0&&Number.isInteger(draft.codeAttemptsPerMinute)&&draft.codeAttemptsPerMinute>=1&&draft.codeAttemptsPerMinute<=10
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(!changed||!valid||saving)return;setSaving(true)
    try{
      const input={registrationHelpMarkdown:draft.registrationHelpMarkdown,codeAttemptsPerMinute:draft.codeAttemptsPerMinute}
      const grant=await authorizePasskeyAction(await siteSettingsScope(input))
      const result=await api.admin.updateSiteSettings(grant.authorizationToken,input)
      setSaved(result);setDraft(result);push({tone:'success',title:t('Site settings saved')})
    }catch(caught){push({tone:'error',title:t('Site settings could not be saved'),message:t(errorMessage(caught))})}finally{setSaving(false)}
  }
  if(!saved)return error?<Card><EmptyState icon="warning" title={t('Site settings unavailable')} description={t(error)} action={<Button onClick={()=>setAttempt(value=>value+1)}>{t('Try again')}</Button>}/></Card>:<div className="site-settings-loading" role="status" aria-label={t('Loading site settings')}><Skeleton height={160}/><Skeleton height={330}/></div>
  return <form className="site-settings" onSubmit={event=>void save(event)} aria-busy={saving}>
    <Card className="site-settings__rate"><div><h2>{t('Temporary code protection')}</h2><p>{t('Limit code attempts from the same IP address in each 60-second window.')}</p></div><Input type="number" label={t('Attempts per minute per IP')} min={1} max={10} step={1} value={draft.codeAttemptsPerMinute} disabled={saving} onChange={event=>setDraft({...draft,codeAttemptsPerMinute:Number(event.target.value)})} hint={t('Default: 3 attempts. Changes apply immediately.')}/></Card>
    <Card className="site-settings__content"><div className="site-settings__heading"><Icon name="info" size={20}/><div><h2>{t('How to register')}</h2><p>{t('Shown publicly from the temporary code dialog. Write the instructions your visitors need.')}</p></div></div>
      <div className="site-settings__editor"><div><Textarea label={t('Registration instructions (Markdown)')} rows={16} value={draft.registrationHelpMarkdown} disabled={saving} onChange={event=>setDraft({...draft,registrationHelpMarkdown:normalizeHelpMarkdown(event.target.value)})} error={bytes>8192?t('Registration instructions must fit within 8 KB.'):undefined} hint={t('Supports headings, lists, links, tables and code. Embedded HTML and remote images are disabled.')}/><small className="site-settings__size">{bytes.toLocaleString()} / 8,192</small></div><section className="site-settings__preview" aria-label={t('Preview')}><h3>{t('Preview')}</h3><Markdown source={draft.registrationHelpMarkdown}/></section></div>
    </Card>
    <div className="site-settings__actions"><Button type="button" disabled={!changed||saving} onClick={()=>setDraft(saved)}>{t('Discard changes')}</Button><Button type="submit" variant="primary" icon="shield" loading={saving} disabled={!changed||!valid}>{t('Verify and save')}</Button></div>
  </form>
}
