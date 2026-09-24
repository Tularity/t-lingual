import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { RecognitionCapabilities } from '../../api/contracts'
import { useI18n } from '../../app/i18n'
import { errorMessage, languages } from '../../app/utils'
import { readBrowserStorage, writeBrowserStorage } from '../../platform/storage'
import { languageDisplayName } from '../languages'

type Usage = Record<string, { count: number; last: number }>
const extraLanguages = [
  {code:'uk',label:'Ukrainian',native:'Українська'}, {code:'lt',label:'Lithuanian',native:'Lietuvių'},
  {code:'et',label:'Estonian',native:'Eesti'}, {code:'lv',label:'Latvian',native:'Latviešu'},
  {code:'mt',label:'Maltese',native:'Malti'}, {code:'nb',label:'Norwegian Bokmål',native:'Norsk bokmål'},
  {code:'nn',label:'Norwegian Nynorsk',native:'Norsk nynorsk'},
]
export const recognitionLanguageCatalog = [...languages, ...extraLanguages]
const usageKey=(id:string)=>`t-lingual:recognition-usage:${id}`
function readUsage(id:string):Usage {
  try { const value=JSON.parse(readBrowserStorage('local',usageKey(id))??'{}') as Usage; return value && typeof value==='object'?value:{} } catch {return {}}
}
export function useRecognitionLanguages(enabled=true) {
  const {locale}=useI18n()
  const [capabilities,setCapabilities]=useState<RecognitionCapabilities|null>(null)
  const [error,setError]=useState('')
  const [attempt,setAttempt]=useState(0)
  const [account,setAccount]=useState('')
  const [usage,setUsage]=useState<Usage>({})
  const [rankingTime]=useState(Date.now)
  const [preferred,setPreferred]=useState<string[]>([])
  useEffect(()=>{
    if(!enabled)return
    let active=true
    void api.recognition?.capabilities().then(value=>{if(active){setCapabilities(value);setError('')}}).catch(caught=>{if(active)setError(errorMessage(caught))})
    void Promise.all([api.auth?.me(),api.settings?.get()]).then(([identity,settings])=>{
      if(!active)return
      if(identity?.user.id){setAccount(identity.user.id);setUsage(readUsage(identity.user.id))}
      if(settings)setPreferred([settings.defaultSourceLanguage,settings.defaultTargetLanguage])
    }).catch(()=>undefined)
    return ()=>{active=false}
  },[enabled,attempt])
  const choices=useMemo(()=>{
    const score=(code:string)=> (preferred[0]===code?120:0)+(locale===code?90:0)+(preferred[1]===code?50:0)+Math.min(60,Number(usage[code]?.count)||0)+(rankingTime-(Number(usage[code]?.last)||0)<7*86400000?20:0)
    return (capabilities?.languages??[]).map(code=>recognitionLanguageCatalog.find(item=>item.code===code)??{code,label:code,native:code}).sort((a,b)=>score(b.code)-score(a.code)||languageDisplayName(a.code,locale).localeCompare(languageDisplayName(b.code,locale),locale))
  },[capabilities,locale,preferred,usage,rankingTime])
  const remember=(codes:string[])=>{
    if(!account)return
    const next={...usage}
    for(const code of codes)next[code]={count:Math.min(60,(Number(next[code]?.count)||0)+1),last:Date.now()}
    writeBrowserStorage('local',usageKey(account),JSON.stringify(next))
  }
  return {capabilities,choices,error,loading:enabled&&!capabilities&&!error,remember,retry:()=>setAttempt(value=>value+1)}
}
