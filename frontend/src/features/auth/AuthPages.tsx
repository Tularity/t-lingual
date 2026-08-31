import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input, Icon } from '../../design-system'
import { Brand } from '../../app/AppShell'
import { useAuth } from '../../app/auth'
import { Link, useRouter } from '../../app/router'
import { errorMessage } from '../../app/utils'
import './auth.css'

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return <main className="auth-page">
    <section className="auth-story" aria-label="Product introduction">
      <div><Brand /><div className="auth-story__copy"><span className="auth-kicker">Live understanding, without delay</span><h1>Every voice.<br /><em>Understood.</em></h1><p>Private, low-latency interpretation for conversations that matter.</p></div></div>
      <div className="auth-signal" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
      <div className="auth-story__trust"><Icon name="shield" size={18} /><span>Your transcripts and session data are isolated from every other account.</span></div>
    </section>
    <section className="auth-panel"><div className="auth-card"><div className="auth-mobile-brand"><Brand /></div><div className="auth-card__heading"><h2>{title}</h2><p>{subtitle}</p></div>{children}<div className="auth-card__footer">{footer}</div><p className="auth-security"><Icon name="key" size={15} />Protected with passkeys. No password is stored or transmitted.</p></div></section>
  </main>
}

function useErrorFocus(error: string, attempt: number) {
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error, attempt])
  return errorRef
}

export function LoginPage() {
  const { login } = useAuth()
  const { navigate } = useRouter()
  const [busy, setBusy] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [error, setError] = useState('')
  const errorRef = useErrorFocus(error, attempts)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setAttempts((count) => count + 1); setBusy(true); setError('')
    try { await login(); navigate('/sessions', { replace: true }) }
    catch (caught) { setError(errorMessage(caught)) }
    finally { setBusy(false) }
  }
  return <AuthLayout title="Welcome back" subtitle="Use a passkey saved to this device or another nearby device." footer={<>Have an invitation? <Link href="/register">Create your account</Link></>}>
    <form className="auth-form" aria-busy={busy} onSubmit={(event) => void submit(event)}>
      {error && <div ref={errorRef} className="auth-error" role="alert" tabIndex={-1}><Icon name="warning" size={18} /><span dir="auto">{error}</span></div>}
      <div className="auth-passkey-note"><span className="auth-passkey-note__icon"><Icon name="key" size={20} /></span><div><strong>Choose an available passkey</strong><p>Your browser will offer passkeys saved here, on a nearby device or on a hardware security key.</p></div></div>
      <Button type="submit" variant="primary" size="lg" icon="key" loading={busy}>Continue with a passkey</Button>
    </form>
  </AuthLayout>
}

export function RegisterPage() {
  const { register } = useAuth()
  const { navigate } = useRouter()
  const [form, setForm] = useState({ invitationCode: '', username: '', displayName: '' })
  const [touched, setTouched] = useState({ invitationCode: false, username: false, displayName: false })
  const [busy, setBusy] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [error, setError] = useState('')
  const errorRef = useErrorFocus(error, attempts)
  const submitted = attempts > 0
  const codeValid = /^\d{6}$/u.test(form.invitationCode)
  const usernameValid = /^[a-z0-9][a-z0-9._-]{2,31}$/u.test(form.username)
  const displayNameValid = form.displayName.trim().length > 0
  const touch = (field: keyof typeof touched) => setTouched((current) => (current[field] ? current : { ...current, [field]: true }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setAttempts((count) => count + 1)
    if (!codeValid || !usernameValid || !displayNameValid) { setError('Check the highlighted account details and try again.'); return }
    setBusy(true); setError('')
    try { await register({ ...form, displayName: form.displayName.trim() }); navigate('/sessions', { replace: true }) }
    catch (caught) { setError(errorMessage(caught)) }
    finally { setBusy(false) }
  }
  return <AuthLayout title="Create your workspace" subtitle="An administrator invitation is required. You’ll create a passkey in the final step." footer={<>Already registered? <Link href="/login">Sign in</Link></>}>
    <form className="auth-form" aria-busy={busy} onSubmit={(event) => void submit(event)} noValidate>
      {error && <div ref={errorRef} className="auth-error" role="alert" tabIndex={-1}><Icon name="warning" size={18} /><span dir="auto">{error}</span></div>}
      <Input disabled={busy} label="Six-digit invitation code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={form.invitationCode} onChange={(event) => setForm({ ...form, invitationCode: event.target.value.replace(/\D/gu, '').slice(0, 6) })} onBlur={() => touch('invitationCode')} error={(submitted || touched.invitationCode) && !codeValid ? 'Enter all six digits.' : undefined} />
      <div className="auth-form__row"><Input disabled={busy} label="Username" autoComplete="username" maxLength={32} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} onBlur={() => touch('username')} error={(submitted || touched.username) && !usernameValid ? 'Use 3–32 lowercase letters, numbers, dot, _ or -.' : undefined} /><Input dir="auto" disabled={busy} label="Display name" autoComplete="name" maxLength={80} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} onBlur={() => touch('displayName')} error={(submitted || touched.displayName) && !displayNameValid ? 'Enter a display name.' : undefined} /></div>
      <div className="auth-passkey-note"><span className="auth-passkey-note__icon"><Icon name="key" size={20} /></span><div><strong>A passkey replaces your password</strong><p>Use Face ID, Touch ID, Windows Hello or a hardware security key.</p></div></div>
      <Button type="submit" variant="primary" size="lg" icon="arrowRight" loading={busy}>Create account and passkey</Button>
    </form>
  </AuthLayout>
}
