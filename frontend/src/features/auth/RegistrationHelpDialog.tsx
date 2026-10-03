import { useEffect, useState } from 'react'
import { Markdown } from '@tular/ui'
import { api } from '../../api/client'
import { useI18n } from '../../app/i18n'
import { errorMessage } from '../../app/utils'
import { Button, Dialog, EmptyState, LoadingState } from '../../design-system'
import './registration-help.css'

export function RegistrationHelpDialog({open,onClose,origin}:{open:boolean;onClose:()=>void;origin?:{x:number;y:number}}) {
  const {t}=useI18n()
  const [content,setContent]=useState<string|null>(null)
  const [error,setError]=useState('')
  const [attempt,setAttempt]=useState(0)
  useEffect(()=>{
    if(!open)return
    let active=true
    void api.site.content().then(value=>{if(active){setContent(value.registrationHelpMarkdown);setError('')}}).catch(caught=>{if(active)setError(errorMessage(caught))})
    return()=>{active=false}
  },[open,attempt])
  return <Dialog open={open} origin={origin} size="full" title={t('How to register')} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t('Done')}</Button>}>
    <div className="registration-help">{error?<EmptyState icon="warning" title={t('Registration help could not be loaded')} description={t(error)} action={<Button onClick={()=>setAttempt(value=>value+1)}>{t('Try again')}</Button>}/>:<LoadingState loading={content===null} size={140} label={t('Loading registration help')}>{content!==null&&<Markdown source={content}/>}</LoadingState>}</div>
  </Dialog>
}
