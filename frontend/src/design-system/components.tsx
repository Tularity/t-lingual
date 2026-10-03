// Product-facing adapters preserve the feature API while the established UI
// framework owns rendering, keyboard interaction, focus and motion.
import { forwardRef, useCallback, useEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import * as UI from '@tular/ui'
import { Icon, type IconName } from './icons'
import './components.css'

export interface ButtonStyleOptions { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; iconOnly?: boolean; className?: string }
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions { icon?: IconName; loading?: boolean }
export function buttonClassName({ variant = 'secondary', size = 'md', iconOnly, className }: ButtonStyleOptions = {}) {
  return UI.cx('tl-button', 'ds-button', `ds-link-button--${variant}`, `ds-link-button--${size}`, iconOnly && 'ds-link-button--icon', className)
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', icon, className, ...props }, ref) {
  return <UI.Button ref={ref} variant={variant === 'secondary' ? 'default' : variant} icon={icon && <Icon name={icon} size={18} />} className={UI.cx('ds-button', className)} {...props} />
})
interface FieldBase { label: string; hint?: string; error?: string; optional?: boolean }
export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> & FieldBase & { icon?: IconName; suffix?: ReactNode; clearable?: boolean; clearLabel?: string }>(function Input({ label, hint, error, optional, icon, id, ...props }, ref) {
  return <UI.Field className="ds-field" controlId={id} label={label} hint={error ? undefined : hint} error={error} optional={optional}><UI.Input ref={ref} prefix={icon && <Icon name={icon} size={18} />} {...props} /></UI.Field>
})
export const Select = forwardRef<HTMLButtonElement, UI.SelectProps & FieldBase>(function Select({ label, hint, error, optional, id, ...props }, ref) {
  return <UI.Field className="ds-field" controlId={id} label={label} hint={error ? undefined : hint} error={error} optional={optional}><UI.Select ref={ref} {...props} /></UI.Field>
})
export const SelectOption = UI.SelectOption
export const SelectGroup = UI.SelectGroup
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldBase>(function Textarea({ label, hint, error, optional, id, ...props }, ref) {
  return <UI.Field className="ds-field" controlId={id} label={label} hint={error ? undefined : hint} error={error} optional={optional}><UI.Textarea ref={ref} {...props} /></UI.Field>
})
export function Card({ raised, interactive, className, ...props }: HTMLAttributes<HTMLDivElement> & { raised?: boolean; interactive?: boolean }) {
  return <UI.Card padding="none" variant={raised ? 'raised' : 'default'} className={UI.cx('ds-card', interactive && 'ds-card--interactive', className)} {...props} />
}
export function Badge({ tone = 'neutral', ...props }: { tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'info'; dot?: boolean; children: ReactNode; className?: string }) { return <UI.Badge variant={tone} {...props} /> }
export function Spinner({ label = 'Loading' }: { label?: string }) { return <UI.Spinner label={label} /> }
export function Skeleton({ width = '100%', height = 16, className }: { width?: string | number; height?: string | number; className?: string }) {
  return <UI.Skeleton variant="rect" className={UI.cx('ds-skeleton', className)} data-width={String(width).replace('%', '')} data-height={String(height).replace('px', '')} />
}
/** A page or panel waiting for its content; see the framework's LoadingState. */
export function LoadingState(props: Omit<UI.LoadingStateProps, 'still'>) {
  return <UI.LoadingState still={<img src="/brand/tularity.svg" alt="" />} {...props} />
}
export function EmptyState({ icon = 'spark', ...props }: { icon?: IconName; title: string; description: string; action?: ReactNode }) { return <UI.EmptyState headingLevel={3} icon={<Icon name={icon} size={28} />} {...props} /> }
export function Switch({ ariaLabel, ...props }: { checked: boolean; onChange: (checked: boolean) => void; label: string; ariaLabel?: string; disabled?: boolean }) { return <UI.Switch aria-label={ariaLabel} {...props} /> }
export function Tabs<T extends string>({ items, value, onChange, label, panelId }: { items: Array<{ value: T; label: string; icon?: IconName }>; value: T; onChange: (value: T) => void; label: string; panelId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  // These screens own their panel outside this compact navigation adapter.
  // Point the framework's selected tab at that actual panel rather than a phantom.
  useEffect(() => {
    const selected = ref.current?.querySelector('[role="tab"][aria-selected="true"]')
    if (!selected) return
    if (panelId) { selected.setAttribute('aria-controls', panelId); document.getElementById(panelId)?.setAttribute('aria-labelledby', selected.id) }
    else selected.removeAttribute('aria-controls')
  }, [panelId, value])
  return <UI.Tabs ref={ref} variant="line" value={value} onChange={next => onChange(next as T)}><UI.TabList aria-label={label}>{items.map(item => <UI.Tab key={item.value} value={item.value}>{item.icon && <Icon name={item.icon} size={16} />}{item.label}</UI.Tab>)}</UI.TabList></UI.Tabs>
}
export function Dialog({ open, title, description, onClose, children, footer, origin, size }: { open: boolean; title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; origin?: {x:number;y:number}; size?: 'sm'|'md'|'lg'|'full' }) {
  return <UI.Dialog open={open} origin={origin} size={size} onOpenChange={value => { if (!value) onClose() }} closeLabel="Close dialog"><UI.DialogHeader><UI.DialogTitle>{title}</UI.DialogTitle>{description && <UI.DialogDescription>{description}</UI.DialogDescription>}</UI.DialogHeader><UI.DialogBody>{children}</UI.DialogBody>{footer && <UI.DialogFooter>{footer}</UI.DialogFooter>}</UI.Dialog>
}
export const ToastProvider = UI.ToastProvider
export function useToast() {
  const { push: notify } = UI.useToast()
  const push = useCallback(({ tone, title, message }: { tone: 'success' | 'error' | 'info'; title: string; message?: string }) => notify({ variant: tone === 'error' ? 'danger' : tone, title, description: message }), [notify])
  return { push }
}
export function PageHeader(props: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) { return <UI.PageHeader className="ds-page-header" {...props} /> }
