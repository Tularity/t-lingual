import type { ReactNode } from 'react'
import { Meter, Sparkline } from '@t-lingual/ui'
import type { AccountStanding, UserLimits } from '../../api/contracts'
import { Icon, type IconName } from '../../design-system'
import { useI18n } from '../../app/i18n'
import type { InsightFormat } from './format'
import './insights.css'

/** One panel of a statistics or monitoring page: a titled card spanning some of the twelve columns. */
export function InsightCard({ title, description, span = 6, actions, className, children }: { title: ReactNode; description?: ReactNode; span?: 3 | 4 | 5 | 6 | 7 | 8 | 12; actions?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`insight-card insight-card--${span}${className ? ` ${className}` : ''}`}>
    <header className="insight-card__header"><div><h3>{title}</h3>{description ? <p>{description}</p> : null}</div>{actions}</header>
    <div className="insight-card__body">{children}</div>
  </section>
}

/** A headline figure, with how it moved across the period drawn beside it. */
export function StatTile({ icon, label, value, detail, trend, tone }: { icon: IconName; label: string; value: ReactNode; detail?: ReactNode; trend?: ReadonlyArray<number | null | undefined>; tone?: 'danger' | 'warning' | 'success' }) {
  return <div className="stat-tile" data-tone={tone}>
    <span className="stat-tile__label"><span className="stat-tile__icon"><Icon name={icon} size={15} /></span>{label}</span>
    <strong className="stat-tile__value">{value}</strong>
    {detail ? <span className="stat-tile__detail">{detail}</span> : null}
    {trend && trend.some((value) => (value ?? 0) > 0) ? <Sparkline className="stat-tile__trend" values={trend} width={200} height={26} area fluid /> : null}
  </div>
}

/** A row of headline figures that wraps to the width it is given. */
export function StatRow({ children, label }: { children: ReactNode; label: string }) {
  return <div className="stat-row" role="group" aria-label={label}>{children}</div>
}

/** What an account may use and how much of it this month has taken. */
export function Allowance({ limits, standing, format }: { limits: UserLimits; standing: AccountStanding; format: InsightFormat }) {
  const { t } = useI18n()
  const rows: Array<{ id: string; icon: IconName; label: string; used: number; limit: number; text: string; limitText: string }> = [
    { id: 'minutes', icon: 'microphone', label: t('Recording this month'), used: standing.monthRecordedSeconds, limit: limits.monthlyRecordingMinutes * 60,
      text: format.duration(standing.monthRecordedSeconds), limitText: limits.monthlyRecordingMinutes ? format.duration(limits.monthlyRecordingMinutes * 60) : '' },
    { id: 'storage', icon: 'database', label: t('Storage'), used: standing.storageBytes, limit: limits.storageMb * 1024 * 1024,
      text: format.bytes(standing.storageBytes), limitText: limits.storageMb ? format.megabytes(limits.storageMb) : '' },
    { id: 'recordings', icon: 'wave', label: t('Recordings at once'), used: standing.activeRecordings, limit: limits.concurrentRecordings,
      text: format.whole(standing.activeRecordings), limitText: format.whole(limits.concurrentRecordings) },
    { id: 'workspaces', icon: 'grid', label: t('Workspaces'), used: standing.workspaces, limit: limits.workspaces,
      text: format.whole(standing.workspaces), limitText: format.whole(limits.workspaces) },
  ]
  return <div className="allowance">
    {rows.map((row) => {
      const share = row.limit > 0 ? row.used / row.limit : 0
      const reading = row.limit > 0 ? t('{used} of {limit}', { used: row.text, limit: row.limitText }) : row.text
      return <div key={row.id} className="allowance__item" data-full={row.limit > 0 && share >= 1 || undefined}>
        <span className="allowance__label"><Icon name={row.icon} size={15} />{row.label}</span>
        <strong className="allowance__value">{row.text}{row.limit > 0 ? <small>{t('of {limit}', { limit: row.limitText })}</small> : null}</strong>
        {row.limit > 0
          ? <Meter size="sm" label={row.label} value={Math.min(row.used, row.limit)} max={row.limit} high={row.limit * 0.8} optimum={0} valueText={reading} />
          : <span className="allowance__unlimited">{t('No limit')}</span>}
      </div>
    })}
    <div className="allowance__item">
      <span className="allowance__label"><Icon name="link" size={15} />{t('Links for guests')}</span>
      <strong className="allowance__value">{limits.guestLinks ? t('Allowed') : t('Not allowed')}</strong>
      <span className="allowance__unlimited">{limits.guestLinks ? t('Can share with people not signed in') : t('Only people who sign in')}</span>
    </div>
  </div>
}

/** A figure too small to chart on its own, in a grid of them. */
export function Figures({ items }: { items: Array<{ label: string; value: ReactNode; tone?: 'danger' | 'warning' | 'success' }> }) {
  return <dl className="figures">{items.map((item) => <div key={item.label} data-tone={item.tone}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
}
