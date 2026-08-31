import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Icon, type IconName } from './icons'
import './components.css'

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export interface ButtonStyleOptions {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  iconOnly?: boolean
  className?: string
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  icon?: IconName
  loading?: boolean
}

export function buttonClassName({ variant = 'secondary', size = 'md', iconOnly, className }: ButtonStyleOptions = {}) {
  return cx('ds-button', `ds-button--${variant}`, `ds-button--${size}`, iconOnly && 'ds-button--icon', className)
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconOnly, loading, className, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, iconOnly, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="ds-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 17 : 19} /> : null}
      {iconOnly ? <span className="sr-only">{props['aria-label']}</span> : children}
    </button>
  )
})

interface FieldBase {
  label: string
  hint?: string
  error?: string
  optional?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldBase & { icon?: IconName }>(
  function Input({ label, hint, error, optional, icon, id: suppliedId, className, ...props }, ref) {
    const generatedId = useId()
    const id = suppliedId ?? generatedId
    const descriptionId = `${id}-description`
    return (
      <div className={cx('ds-field', error && 'ds-field--error')}>
        <label className="ds-label-row" htmlFor={id}>
          <span className="ds-label">{label}</span>
          {optional && <span className="ds-label-optional">Optional</span>}
        </label>
        <span className="ds-input-wrap">
          {icon && <Icon className="ds-input-icon" name={icon} size={18} />}
          <input ref={ref} id={id} className={cx('ds-input', icon && 'ds-input--with-icon', className)} aria-invalid={!!error} aria-describedby={hint || error ? descriptionId : undefined} {...props} />
        </span>
        {(error || hint) && <span id={descriptionId} className={error ? 'ds-field-error' : 'ds-field-hint'}>{error || hint}</span>}
      </div>
    )
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & FieldBase>(
  function Select({ label, hint, error, optional, id: suppliedId, className, children, ...props }, ref) {
    const generatedId = useId()
    const id = suppliedId ?? generatedId
    const descriptionId = `${id}-description`
    return (
      <div className={cx('ds-field', error && 'ds-field--error')}>
        <label className="ds-label-row" htmlFor={id}><span className="ds-label">{label}</span>{optional && <span className="ds-label-optional">Optional</span>}</label>
        <span className="ds-input-wrap">
          <select ref={ref} id={id} className={cx('ds-select', className)} aria-invalid={!!error} aria-describedby={hint || error ? descriptionId : undefined} {...props}>{children}</select>
          <Icon className="ds-select-arrow" name="chevronDown" size={17} />
        </span>
        {(error || hint) && <span id={descriptionId} className={error ? 'ds-field-error' : 'ds-field-hint'}>{error || hint}</span>}
      </div>
    )
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldBase>(
  function Textarea({ label, hint, error, optional, id: suppliedId, className, ...props }, ref) {
    const generatedId = useId()
    const id = suppliedId ?? generatedId
    const descriptionId = `${id}-description`
    return (
      <div className={cx('ds-field', error && 'ds-field--error')}>
        <label className="ds-label-row" htmlFor={id}><span className="ds-label">{label}</span>{optional && <span className="ds-label-optional">Optional</span>}</label>
        <textarea ref={ref} id={id} className={cx('ds-textarea', className)} aria-invalid={!!error} aria-describedby={hint || error ? descriptionId : undefined} {...props} />
        {(error || hint) && <span id={descriptionId} className={error ? 'ds-field-error' : 'ds-field-hint'}>{error || hint}</span>}
      </div>
    )
  },
)

export function Card({ raised, interactive, className, ...props }: HTMLAttributes<HTMLDivElement> & { raised?: boolean; interactive?: boolean }) {
  return <div className={cx('ds-card', raised && 'ds-card--raised', interactive && 'ds-card--interactive', className)} {...props} />
}

export function Badge({ tone = 'neutral', dot, children, className }: { tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'info'; dot?: boolean; children: ReactNode; className?: string }) {
  return <span className={cx('ds-badge', `ds-badge--${tone}`, className)}>{dot && <span className="ds-status-dot" />}{children}</span>
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span role="status" aria-label={label}><span className="ds-spinner" aria-hidden="true" /></span>
}

export function Skeleton({ width = '100%', height = 16, className }: { width?: string | number; height?: string | number; className?: string }) {
  const widthToken = String(width).replace('%', '')
  const heightToken = String(height).replace('px', '')
  return <span className={cx('ds-skeleton', className)} data-width={widthToken} data-height={heightToken} aria-hidden="true" />
}

export function EmptyState({ icon = 'spark', title, description, action }: { icon?: IconName; title: string; description: string; action?: ReactNode }) {
  return <div className="ds-empty"><div className="ds-empty__icon"><Icon name={icon} size={27} /></div><h3 dir="auto">{title}</h3><p dir="auto">{description}</p>{action}</div>
}

export function Switch({ checked, onChange, label, ariaLabel, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; ariaLabel?: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="ds-switch" aria-label={ariaLabel} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span className="ds-switch__track"><span className="ds-switch__thumb" /></span><span className="ds-switch__label">{label}</span></button>
}

export function Tabs<T extends string>({ items, value, onChange, label, panelId }: { items: Array<{ value: T; label: string; icon?: IconName }>; value: T; onChange: (value: T) => void; label: string; panelId?: string }) {
  const listRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    let next = index
    if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length
    if (event.key === 'ArrowRight') next = (index + 1) % items.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = items.length - 1
    const item = items[next]
    if (!item) return
    onChange(item.value)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  return <div ref={listRef} className="ds-tabs" role="tablist" aria-label={label} aria-orientation="horizontal">{items.map((item, index) => <button key={item.value} className="ds-tab" type="button" role="tab" aria-selected={value === item.value} aria-controls={panelId && value === item.value ? panelId : undefined} tabIndex={value === item.value ? 0 : -1} onClick={() => onChange(item.value)} onKeyDown={(event) => onKeyDown(event, index)}>{item.icon && <Icon name={item.icon} size={16} />}{item.label}</button>)}</div>
}

export function Dialog({ open, title, description, onClose, children, footer }: { open: boolean; title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => {
      const preferred = panelRef.current?.querySelector<HTMLElement>('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
      ;(preferred ?? closeRef.current)?.focus()
    }, 0)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current() }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('ds-dialog-open')
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', onKey); document.body.classList.remove('ds-dialog-open'); previous?.focus() }
  }, [open])

  if (!open) return null
  return <div className="ds-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div ref={panelRef} className="ds-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}><header className="ds-dialog__header"><div><h2 id={titleId} className="ds-dialog__title">{title}</h2>{description && <p id={descriptionId} className="ds-dialog__description">{description}</p>}</div><Button ref={closeRef} type="button" variant="ghost" size="sm" icon="close" iconOnly aria-label="Close dialog" onClick={onClose} /></header><div className="ds-dialog__body">{children}</div>{footer && <footer className="ds-dialog__footer">{footer}</footer>}</div></div>
}

type ToastTone = 'success' | 'error' | 'info'
interface Toast { id: number; tone: ToastTone; title: string; message?: string }
interface ToastContextValue { push: (toast: Omit<Toast, 'id'>) => void }
const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, number>())
  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])
  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextId.current++
    setToasts((current) => [...current.slice(-3), { ...toast, id }])
    timers.current.set(id, window.setTimeout(() => dismiss(id), 5000))
  }, [dismiss])
  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current.clear()
  }, [])
  const value = useMemo(() => ({ push }), [push])
  return <ToastContext.Provider value={value}>{children}<div className="ds-toast-region">{toasts.map((toast) => <div key={toast.id} className={cx('ds-toast', `ds-toast--${toast.tone}`)} role={toast.tone === 'error' ? 'alert' : 'status'}><Icon name={toast.tone === 'success' ? 'check' : toast.tone === 'error' ? 'warning' : 'spark'} size={19} /><div><p className="ds-toast__title" dir="auto">{toast.title}</p>{toast.message && <p className="ds-toast__message" dir="auto">{toast.message}</p>}</div><Button type="button" variant="ghost" size="sm" icon="close" iconOnly aria-label="Dismiss notification" onClick={() => dismiss(toast.id)} /></div>)}</div></ToastContext.Provider>
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within ToastProvider')
  return context
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="ds-page-header"><div>{eyebrow && <p className="ds-page-header__eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="ds-page-header__description">{description}</p>}</div>{actions && <div className="ds-page-header__actions">{actions}</div>}</header>
}
