import { useEffect, useState } from 'react'
import { SegmentedControl, Select, SelectOption } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { AccountUsage } from '../../api/contracts'
import { Button, Card, EmptyState, LoadingState } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { useWorkspaces } from '../../app/workspaces'
import { errorMessage } from '../../app/utils'
import { localOffsetMinutes, useInsightFormat } from './format'
import { Allowance, InsightCard } from './InsightParts'
import { UsageCharts, UsageStats } from './UsageCharts'

export const USAGE_PERIODS = [7, 30, 90, 365] as const

/** The period choices the usage pages share. */
export function usePeriodItems() {
  const { t } = useI18n()
  return USAGE_PERIODS.map((days) => ({ value: String(days), label: days === 365 ? t('12 months') : t('{count} days', { count: days }) }))
}

type Loaded<T> = { status: 'loading' | 'ready' | 'error'; data?: T; error?: string; key: string }

/** How much a person has used: their own recording, text and storage, against what they may use. */
export function UsagePage() {
  const { t } = useI18n()
  const format = useInsightFormat()
  const workspaces = useWorkspaces()
  const periods = usePeriodItems()
  const [days, setDays] = useState(30)
  const [workspace, setWorkspace] = useState('')
  const [attempt, setAttempt] = useState(0)
  const key = `${days}|${workspace}|${attempt}`
  const [state, setState] = useState<Loaded<AccountUsage>>({ status: 'loading', key })
  if (state.key !== key && state.status !== 'loading') setState({ ...state, status: 'loading', key })

  useEffect(() => {
    let active = true
    api.usage.mine({ days, offset: localOffsetMinutes(), workspace: workspace || undefined })
      .then((data) => { if (active) setState({ status: 'ready', data, key }) })
      .catch((caught) => { if (active) setState((current) => ({ ...current, status: 'error', error: errorMessage(caught), key })) })
    return () => { active = false }
  }, [days, workspace, key])

  const data = state.data
  return <div className="insights-page">
    <header className="insights-heading">
      <div><h1>{t('Usage')}</h1><p>{t('How much you have recorded, recognized and translated, and what it takes up.')}</p></div>
      <div className="insights-filters" role="group" aria-label={t('Filters')}>
        {workspaces.items.length > 1 ? <Select size="sm" aria-label={t('Workspace')} value={workspace} onValueChange={setWorkspace}>
          <SelectOption value="">{t('All workspaces')}</SelectOption>
          {workspaces.items.map((item) => <SelectOption key={item.id} value={item.id}>{workspaces.name(item)}</SelectOption>)}
        </Select> : null}
        <SegmentedControl size="sm" aria-label={t('Period')} items={periods} value={String(days)} onChange={(value) => setDays(Number(value))} />
      </div>
    </header>
    {!data && state.status === 'error'
      ? <Card><EmptyState icon="warning" title={t('Usage couldn’t be loaded')} description={state.error ?? ''} action={<Button icon="refresh" onClick={() => setAttempt((value) => value + 1)}>{t('Try again')}</Button>} /></Card>
      : !data ? <LoadingState label={t('Loading usage')} />
      : <div className="insights-body" aria-busy={state.status === 'loading' || undefined} data-stale={state.status === 'loading' || undefined}>
        <UsageStats report={data.report} format={format} />
        <div className="insights-grid">
          <InsightCard span={12} title={t('Your allowance')} description={t('Set by your administrator.')}>
            <Allowance limits={data.limits} standing={data.standing} format={format} />
          </InsightCard>
        </div>
        <UsageCharts report={data.report} format={format} workspaceName={(name) => workspaces.name({ name })} />
      </div>}
  </div>
}
