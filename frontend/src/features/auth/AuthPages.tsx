import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input, Icon, Dialog } from '../../design-system'
import { Brand, InterfaceMenus } from '../../app/AppShell'
import { ApiError } from '../../api/client'
import { useAuth } from '../../app/auth'
import { Link, useRouter } from '../../app/router'
import { errorMessage } from '../../app/utils'
import { useI18n } from '../../app/i18n'
import { LanguageLabel } from '../languages'
import './auth.css'
const RegistrationHelpDialog=lazy(()=>import('./RegistrationHelpDialog').then(module=>({default:module.RegistrationHelpDialog})))

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  const { t } = useI18n()
  return <main className="auth-page">
    <section className="auth-story" aria-label={t("T Lingual")}>
      <Brand />
      <div className="auth-story__content">
        <span className="auth-kicker"><span className="auth-kicker__line" /> {t("SIMULTANEOUS INTERPRETATION")}</span>
        <h1>{t("Stay in the")}<br /><em>{t("conversation.")}</em></h1>
        <p>{t("Hear the moment. Read the meaning. Keep every conversation moving across languages.")}</p>
        <div className="auth-scene" aria-hidden="true">
          <div className="auth-scene__top"><span className="auth-scene__live"><i /> {t("LIVE INTERPRETATION")}</span><span><LanguageLabel code="en" compact>ENGLISH</LanguageLabel><Icon name="arrowRight" size={14} /><LanguageLabel code="fr" compact>FRANÇAIS</LanguageLabel></span></div>
          <div className="auth-scene__line"><span className="auth-scene__language">{t("SOURCE ·")} <LanguageLabel code="en" compact>ENGLISH</LanguageLabel></span><strong>It’s good to have everyone here today.</strong></div>
          <div className="auth-scene__line auth-scene__line--translation"><span className="auth-scene__language">{t("TRANSLATION ·")} <LanguageLabel code="fr" compact>FRANÇAIS</LanguageLabel></span><strong>Je suis heureux de vous retrouver tous aujourd’hui.</strong></div>
          <div className="auth-scene__bottom"><span className="auth-scene__wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></span><span>{t("Conversation in progress")}</span></div>
        </div>
      </div>
      <div className="auth-story__trust"><Icon name="shield" size={17} /><span>{t("A private workspace for every voice.")}</span></div>
    </section>
    <section className="auth-panel"><div className="auth-interface"><InterfaceMenus /></div><div className="auth-card"><div className="auth-mobile-brand"><Brand /></div><div className="auth-card__heading"><span className="auth-card__eyebrow">{t("YOUR WORKSPACE")}</span><h2>{title}</h2><p>{subtitle}</p></div>{__TLINGUAL_DEVELOPMENT_MOCK__ && <div className="auth-demo" role="status"><Icon name="info" size={17} /><span><strong>{t("Demo preview")}</strong> {t("· Passkey verification is simulated in this development workspace.")}</span></div>}{children}<div className="auth-card__footer">{footer}</div><p className="auth-security"><Icon name="lock" size={15} />{t("Passkeys and one-time codes · No passwords")}</p></div></section>
  </main>
}

function useErrorFocus(error: string, attempt: number) {
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error, attempt])
  return errorRef
}

function CodeEntry({onComplete,retryUntil,onRateLimited}:{onComplete?:()=>void;retryUntil:number;onRateLimited:(until:number)=>void}) {
  const {t}=useI18n()
  const {code:redeemCode}=useAuth()
  const {navigate}=useRouter()
  const [code,setCode]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [attempt,setAttempt]=useState(0)
  const [clock,setClock]=useState(Date.now)
  const retrySeconds=Math.max(0,Math.ceil((retryUntil-clock)/1000))
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer)},[])
  const errorRef=useErrorFocus(error,attempt)
  const submit=async(event:FormEvent)=>{
    event.preventDefault();if(busy||retrySeconds>0)return;setAttempt(value=>value+1)
    if(!/^\d{6}$/u.test(code)){setError(t('Enter all six digits.'));return}
    setBusy(true);setError('')
    try {const kind=await redeemCode(code);setCode('');onComplete?.();navigate(kind==='registration'?'/register':'/settings#security',{replace:kind==='login'})}
    catch(caught){setError(t(errorMessage(caught)));if(caught instanceof Error&&'status' in caught&&caught.status===429)onRateLimited(Date.now()+1000*Math.max(1,caught instanceof ApiError?caught.retryAfterSeconds??60:'retryAfterSeconds' in caught?Number(caught.retryAfterSeconds)||60:60))}finally{setBusy(false)}
  }
  return <form className="auth-form auth-code-entry" aria-busy={busy} onSubmit={event=>void submit(event)}>
    <Input autoFocus label={t('Six-digit code')} hint={t('Use the code provided by an administrator to register or sign in.')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} disabled={busy} onChange={event=>setCode(event.target.value.replace(/\D/gu,''))} />
    {error&&<div className="auth-error" role="alert" ref={errorRef} tabIndex={-1}><Icon name="warning" size={18}/><span>{error}</span></div>}
    <Button type="submit" variant="primary" icon="arrowRight" loading={busy} disabled={retrySeconds>0}>{t('Continue with code')}</Button>
    {retrySeconds>0&&<p className="auth-code-countdown" role="status">{t('Try again in {seconds} seconds',{seconds:retrySeconds})}</p>}
  </form>
}

function CodeAccessButton() {
  const {t}=useI18n()
  const [open,setOpen]=useState(false)
  const [helpOpen,setHelpOpen]=useState(false)
  const [helpMounted,setHelpMounted]=useState(false)
  const [helpOrigin,setHelpOrigin]=useState<{x:number;y:number}>()
  const [retryUntil,setRetryUntil]=useState(0)
  return <>
    <Button className="auth-code-launcher" variant="secondary" size="lg" icon="key" onClick={()=>setOpen(true)}>{t('Use a temporary code')}</Button>
    <Dialog open={open} title={t('Temporary code')} onClose={()=>setOpen(false)} footer={<><Button variant="ghost" icon="info" onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setHelpOrigin({x:box.left+box.width/2,y:box.top+box.height/2});setHelpMounted(true);setHelpOpen(true)}}>{t('How to register')}</Button><Button onClick={()=>setOpen(false)}>{t('Cancel')}</Button></>}><CodeEntry onComplete={()=>setOpen(false)} retryUntil={retryUntil} onRateLimited={setRetryUntil}/></Dialog>
    {helpMounted&&<Suspense fallback={<Dialog open={helpOpen} origin={helpOrigin} size="full" title={t('How to register')} onClose={()=>setHelpOpen(false)}><p role="status">{t('Loading registration help')}</p></Dialog>}><RegistrationHelpDialog open={helpOpen} origin={helpOrigin} onClose={()=>setHelpOpen(false)}/></Suspense>}
  </>
}

export function LoginPage() {
  const { t } = useI18n()
  const { login } = useAuth()
  const { navigate } = useRouter()
  const [busy, setBusy] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [error, setError] = useState('')
  const errorRef = useErrorFocus(error, attempts)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setAttempts(count=>count+1);setBusy(true);setError('')
    try {await login();navigate('/sessions',{replace:true})}catch(caught){setError(t(errorMessage(caught)))}finally{setBusy(false)}
  }
  return <AuthLayout title={t('Welcome back')} subtitle={t('Sign in with your passkey, or use a temporary code from an administrator.')} footer={<span>{t('Use a temporary code to register or access your account.')}</span>}>
    <form className="auth-form" aria-busy={busy} onSubmit={event=>void submit(event)}>
      {error&&<div ref={errorRef} className="auth-error" role="alert" tabIndex={-1}><Icon name="warning" size={18}/><span dir="auto">{error}</span></div>}
      <div className="auth-passkey-note"><span className="auth-passkey-note__icon"><Icon name="key" size={22}/></span><div><strong>{t('Your passkey is your sign-in')}</strong><p>{t('Choose one from this device, a nearby phone or a security key when your browser prompts you.')}</p></div></div>
      <Button type="submit" variant="primary" size="lg" icon="key" loading={busy}>{busy?t('Waiting for your passkey…'):t('Continue with a passkey')}</Button>
    </form>
    <CodeAccessButton />
  </AuthLayout>
}

export function RegisterPage() {
  const {t}=useI18n()
  const {register,registrationTicket,clearRegistrationTicket}=useAuth()
  const {navigate}=useRouter()
  const [form,setForm]=useState({username:'',displayName:''})
  const [busy,setBusy]=useState(false)
  const [attempts,setAttempts]=useState(0)
  const [error,setError]=useState('')
  const errorRef=useErrorFocus(error,attempts)
  const usernameValid=/^[a-z0-9][a-z0-9._-]{2,31}$/u.test(form.username)
  const displayNameValid=form.displayName.trim().length>0
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setAttempts(value=>value+1)
    if(!usernameValid||!displayNameValid){setError(t('Check the highlighted account details and try again.'));return}
    if(!registrationTicket||Date.parse(registrationTicket.expiresAt)<=Date.now()){setError(t('Your registration code verification expired. Enter the code again.'));return}
    setBusy(true);setError('')
    try {await register({...form,displayName:form.displayName.trim()});navigate('/setup',{replace:true})}catch(caught){setError(t(errorMessage(caught)))}finally{setBusy(false)}
  }
  return <AuthLayout title={t('Create your workspace')} subtitle={t('An administrator invitation is required. You’ll create a passkey in the final step.')} footer={<>{t('Already registered?')} <Link href="/login">{t('Sign in')}</Link></>}>
    {!registrationTicket?<CodeAccessButton />:<form className="auth-form" aria-busy={busy} onSubmit={event=>void submit(event)} noValidate>
      <div className="auth-code-verified"><Icon name="check" size={16}/><span>{t('Registration code verified')}</span><Button size="sm" variant="ghost" disabled={busy} onClick={clearRegistrationTicket}>{t('Use another code')}</Button></div>
      {error&&<div ref={errorRef} className="auth-error" role="alert" tabIndex={-1}><Icon name="warning" size={18}/><span>{error}</span></div>}
      <div className="auth-form__row"><Input disabled={busy} label={t('Username')} hint={t('Used to identify your account.')} autoComplete="username" maxLength={32} value={form.username} onChange={event=>setForm({...form,username:event.target.value.toLowerCase()})} error={attempts&&!usernameValid?t('Use 3–32 lowercase letters, numbers, dot, _ or -.'):undefined}/><Input disabled={busy} label={t('Display name')} hint={t('Shown in your workspace.')} autoComplete="name" maxLength={80} value={form.displayName} onChange={event=>setForm({...form,displayName:event.target.value})} error={attempts&&!displayNameValid?t('Enter a display name.'):undefined}/></div>
      <div className="auth-passkey-note"><span className="auth-passkey-note__icon"><Icon name="key" size={22}/></span><div><strong>{t('Next, create your passkey')}</strong><p>{t('Use your device’s screen lock, a nearby phone or a hardware security key. Keep access to this device until setup finishes.')}</p></div></div>
      <Button type="submit" variant="primary" size="lg" icon="arrowRight" loading={busy}>{busy?t('Creating your workspace…'):t('Create account and passkey')}</Button>
    </form>}
  </AuthLayout>
}
