import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BarList, Gauge, InlineMessage, LineChart, Meter, SegmentedControl, type ChartSeries } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { OperationsReport, OperationsSample, ProviderReading } from '../../api/contracts'
import { Badge, Button, Card, EmptyState, LoadingState } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { errorMessage } from '../../app/utils'
import { useInsightFormat, type InsightFormat } from './format'
import { Figures, InsightCard, StatRow, StatTile } from './InsightParts'
import { useChartSpeech } from './UsageCharts'

const REFRESH_MS = 5_000
const WINDOWS = [{ value: '180', minutes: 15 }, { value: '720', minutes: 60 }] as const

type Tone = 'success' | 'warning' | 'danger' | undefined

/** How a provider's reading reads at a glance. */
function readingState<T>(reading: ProviderReading<T>): 'unconfigured' | 'unreachable' | 'ok' {
  if (!reading.configured) return 'unconfigured'
  return reading.reachable && reading.value ? 'ok' : 'unreachable'
}

/** Live readings from the services recording depends on: recognition, translation, and the GPU they share. */
export function OperationsPage() {
  const { t } = useI18n()
  const format = useInsightFormat()
  const [report, setReport] = useState<OperationsReport | null>(null)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const [window, setWindow] = useState<string>(WINDOWS[0].value)
  const [attempt, setAttempt] = useState(0)
  const pausedRef = useRef(paused)
  useEffect(() => { pausedRef.current = paused })

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      clearTimeout(timer)
      if (!document.hidden && !pausedRef.current) {
        try {
          const next = await api.admin.operations()
          if (!active) return
          setReport(next); setError('')
        } catch (caught) { if (active) setError(errorMessage(caught)) }
      }
      if (active) timer = setTimeout(() => void read(), REFRESH_MS)
    }
    void read()
    const onVisible = () => { if (!document.hidden) void read() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [paused, attempt])

  const snapshot = report?.snapshot
  const history = snapshot ? snapshot.history.slice(-Number(window)) : []
  return <div className="insights-page">
    <header className="insights-heading">
      <div><h1>{t('Operations')}</h1><p>{t('Live readings from speech recognition, translation and the GPU they share, taken every {count} seconds.', { count: snapshot?.intervalSeconds ?? 5 })}</p></div>
      <div className="insights-filters" role="group" aria-label={t('Readings')}>
        {snapshot ? <span className="insights-updated" aria-live="off">{t('Updated {time}', { time: format.clock(snapshot.sampledAt) })}</span> : null}
        <SegmentedControl size="sm" aria-label={t('History shown')} value={window} onChange={setWindow} items={WINDOWS.map((item) => ({ value: item.value, label: item.minutes === 60 ? t('1 hour') : t('{count} min', { count: item.minutes }) }))} />
        <Button size="sm" icon={paused ? 'play' : 'pause'} aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? t('Resume') : t('Pause')}</Button>
      </div>
    </header>
    {!snapshot && error ? <Card><EmptyState icon="warning" title={t('Readings couldn’t be loaded')} description={error} action={<Button icon="refresh" onClick={() => setAttempt((value) => value + 1)}>{t('Try again')}</Button>} /></Card>
      : !snapshot || !report ? <LoadingState label={t('Loading readings')} />
      : <div className="insights-body">
        {error ? <InlineMessage variant="warning">{t('The latest readings couldn’t be loaded: {error}. Showing the last ones received.', { error })}</InlineMessage> : null}
        <Summary report={report} format={format} />
        <RecognitionSection snapshot={snapshot} history={history} format={format} />
        <TranslationSection snapshot={snapshot} history={history} format={format} />
        <GpuSection snapshot={snapshot} history={history} format={format} />
      </div>}
  </div>
}

function Summary({ report, format }: { report: OperationsReport; format: InsightFormat }) {
  const { t } = useI18n()
  const { asr, translator, gpu, activity, history } = report.snapshot
  const load = asr.value
  const status = translator.value
  const device = gpu.value?.[0]
  const backlog = report.backlog
  const catchingUp = backlog.gapsPending + backlog.gapsFilling
  const asrState = readingState(asr)
  const trState = readingState(translator)
  const asrTone: Tone = asrState !== 'ok' ? 'danger' : !load?.ready || !load.can_accept_new_session ? 'danger' : load.pressure.state !== 'normal' ? 'warning' : 'success'
  const trTone: Tone = trState !== 'ok' ? 'danger' : status?.status === 'ready' ? 'success' : status?.status === 'busy' ? 'warning' : 'danger'
  return <StatRow label={t('Service status')}>
    <StatTile icon="wave" tone={asrState === 'unconfigured' ? undefined : asrTone} label={t('Speech recognition')}
      value={asrState === 'unconfigured' ? t('Not set up') : asrState === 'unreachable' ? t('Unreachable') : !load?.ready ? t('Not ready') : !load.can_accept_new_session ? t('Full') : load.pressure.state !== 'normal' ? t('Under pressure') : t('Ready')}
      detail={load?.slots ? t('{active} of {max} sessions', { active: format.whole(load.slots.active), max: format.whole(load.slots.max) }) : asr.error}
      trend={history.map((point) => point.asrActive)} />
    <StatTile icon="languages" tone={trState === 'unconfigured' ? undefined : trTone} label={t('Translation service')}
      value={trState === 'unconfigured' ? t('Not set up') : trState === 'unreachable' ? t('Unreachable') : status?.status === 'ready' ? t('Ready') : status?.status === 'busy' ? t('Busy') : t('Unavailable')}
      detail={status ? t('{active} running · {queued} waiting', { active: format.whole(status.capacity.active), queued: format.whole(status.capacity.queued) }) : translator.error}
      trend={history.map((point) => point.trActive)} />
    <StatTile icon="chip" label={t('GPU')} value={device?.utilization != null ? format.percentOf100(device.utilization) : gpu.configured ? t('Unreachable') : t('Not available')}
      tone={device?.temperatureC != null && device.temperatureC >= 85 ? 'danger' : undefined}
      detail={device ? device.name : undefined} trend={history.map((point) => point.gpuUtil)} />
    <StatTile icon="microphone" label={t('Recording now')} value={format.whole(activity.recordings)} detail={t('{count} watching', { count: format.whole(activity.watchers) })} trend={history.map((point) => point.recordings)} />
    <StatTile icon="history" label={t('Catching up')} tone={backlog.gapsFailed ? 'danger' : catchingUp || backlog.translationsRetrying ? 'warning' : undefined}
      value={catchingUp ? t(catchingUp === 1 ? '{count} gap' : '{count} gaps', { count: format.whole(catchingUp) }) : t('Up to date')}
      detail={[backlog.translationsRetrying ? t('{count} translations to retry', { count: format.whole(backlog.translationsRetrying) }) : '', backlog.gapsFailed ? t('{count} gaps couldn’t be filled', { count: format.whole(backlog.gapsFailed) }) : ''].filter(Boolean).join(' · ') || t('Nothing waiting')} />
  </StatRow>
}

function ProviderNotice<T>({ reading, name }: { reading: ProviderReading<T>; name: string }) {
  const { t } = useI18n()
  const state = readingState(reading)
  if (state === 'ok') return null
  return <InlineMessage variant={state === 'unconfigured' ? 'info' : 'danger'}>
    {state === 'unconfigured' ? t('{name} isn’t set up, so there is nothing to read.', { name }) : t('{name} couldn’t be reached: {error}', { name, error: reading.error || t('no answer') })}
  </InlineMessage>
}

/** A line chart of the monitoring history, with its times on the axis. */
function HistoryChart({ label, history, series, format, formatY, yMax, thresholds, height = 170, ticks = 4 }: { label: string; history: OperationsSample[]; series: ChartSeries[]; format: InsightFormat; formatY: (value: number) => string; yMax?: number; thresholds?: Array<{ value: number; label: string }>; height?: number; ticks?: number }) {
  const speech = useChartSpeech()
  const { t } = useI18n()
  // Under ten minutes of samples, minutes alone would repeat along the axis.
  const short = history.length > 1 && Date.parse(history.at(-1)!.t) - Date.parse(history[0]!.t) < 600_000
  return <LineChart label={label} x={history.map((point) => point.t)} formatX={(value) => short ? format.clockSeconds(String(value)) : format.clock(String(value))} formatY={formatY} series={series} height={height} yMax={yMax} yMin={0}
    thresholds={thresholds} xTicks={ticks} describeSeries={speech.line} emptyLabel={t('No readings yet')} />
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="insights-section"><header><h2>{title}</h2><p>{description}</p></header>{children}</section>
}

const STAGES: Record<string, string> = { cuda_context: 'GPU runtime', asr_weights: 'Recognition model', diar: 'Speaker separation', embedding: 'Speaker fingerprints' }

function RecognitionSection({ snapshot, history, format }: { snapshot: OperationsReport['snapshot']; history: OperationsSample[]; format: InsightFormat }) {
  const { t } = useI18n()
  const load = snapshot.asr.value
  const diagnostics = snapshot.diagnostics.value
  const slots = load?.slots
  const stages = diagnostics?.vram.by_stage ?? []
  const pressureSignals = load?.pressure.signals ?? []
  return <Section title={t('Speech recognition')} description={t('Sessions it is serving, how far behind it runs, and what it holds on the GPU.')}>
    <ProviderNotice reading={snapshot.asr} name={t('Speech recognition')} />
    <div className="insights-grid">
      <InsightCard span={4} title={t('Sessions')} description={load ? load.admission_reason === 'available' ? t('Taking new sessions') : t('Not taking new sessions: {reason}', { reason: load.admission_reason.replace(/_/gu, ' ') }) : undefined}>
        <div className="insight-gauge">
          <Gauge label={t('Recognition sessions in use')} value={slots?.active ?? 0} max={slots?.max || 1} high={(slots?.max ?? 1) * 0.8} optimum={0} size={170}
            display={slots ? format.whole(slots.active) : '—'} caption={slots ? t('of {count}', { count: format.whole(slots.max) }) : t('No reading')}
            valueText={slots ? t('{active} of {max} sessions', { active: slots.active, max: slots.max }) : undefined} />
        </div>
        <Figures items={[
          { label: t('Health status'), value: load ? load.health === 'healthy' ? t('Healthy') : load.health.replace(/_/gu, ' ') : '—', tone: load?.health === 'healthy' ? 'success' : load ? 'warning' : undefined },
          { label: t('Pressure'), value: load ? (load.pressure.state === 'normal' ? t('Normal') : t('Elevated')) : '—', tone: load && load.pressure.state !== 'normal' ? 'warning' : undefined },
          { label: t('Turned away'), value: slots ? format.whole(slots.rejected_total) : '—' },
          { label: t('Audio dropped'), value: load?.input_dropped_ms_total != null ? format.duration(load.input_dropped_ms_total / 1000) : '—', tone: load?.input_dropped_ms_total ? 'danger' : undefined },
        ]} />
      </InsightCard>
      <InsightCard span={8} title={t('Sessions over time')} description={t('Recognition sessions open, against this app’s own recordings.')}>
        <HistoryChart label={t('Sessions over time')} history={history} format={format} formatY={format.whole} height={220} series={[
          { id: 'asr', label: t('Recognition sessions'), values: history.map((point) => point.asrActive), area: true },
          { id: 'recordings', label: t('Recordings here'), values: history.map((point) => point.recordings), dashed: true },
        ]} />
      </InsightCard>
      <InsightCard span={6} title={t('Audio waiting')} description={t('The 95th percentile of audio queued per session. At the limit, sessions start dropping audio.')}>
        <HistoryChart label={t('Audio waiting')} history={history} format={format} formatY={format.milliseconds} series={[{ id: 'pending', label: t('Waiting'), values: history.map((point) => point.asrPendingP95), area: true }]}
          thresholds={load?.queue ? [{ value: load.queue.limit_ms / 2, label: t('Half the limit') }] : undefined} />
      </InsightCard>
      <InsightCard span={6} title={t('Processing time')} description={t('How long each step takes, 95th percentile. Above the line, it falls behind real time.')}>
        <HistoryChart label={t('Processing time')} history={history} format={format} formatY={format.milliseconds} series={[
          { id: 'tick', label: t('Each step'), values: history.map((point) => point.asrTickP95), area: true },
          { id: 'lag', label: t('Event loop delay'), values: history.map((point) => point.asrLagP95), dashed: true },
        ]} thresholds={load?.engine ? [{ value: load.engine.chunk_ms, label: t('Real time') }] : undefined} />
      </InsightCard>
      <InsightCard span={4} title={t('GPU memory by part')} description={diagnostics ? t('{used} of {total} on the card.', { used: format.megabytes(diagnostics.vram.live.driver_used_mb), total: format.megabytes(diagnostics.vram.live.driver_total_mb) }) : t('Read every 30 seconds.')}>
        <BarList label={t('GPU memory by part')} formatValue={format.megabytes} emptyLabel={t('No reading yet')}
          items={stages.map((stage, index) => {
            const name = stage.stage.replace(/^\d+_/u, '')
            return { id: stage.stage, label: t(STAGES[name] ?? name.replace(/_/gu, ' ')), value: Math.max(0, stage.driver_used_mb - (index ? stages[index - 1]!.driver_used_mb : 0)) }
          })} />
      </InsightCard>
      <InsightCard span={4} title={t('Speaker separation')} description={diagnostics?.diar.enabled ? t('Each step against its time budget.') : t('Off')}>
        {diagnostics?.diar.enabled ? <div className="insight-meters">
          {([['p50', t('Typical step'), diagnostics.diar.step_ms_p50], ['p95', t('Slow step (95th percentile)'), diagnostics.diar.step_ms_p95]] as const).map(([id, label, value]) => <div key={id} className="insight-meter">
            <span>{label}</span><strong>{value != null ? format.milliseconds(value) : '—'}</strong>
            <Meter size="sm" label={label} value={value ?? 0} max={diagnostics.diar.budget_ms} high={diagnostics.diar.budget_ms * 0.8} optimum={0} valueText={value != null ? format.milliseconds(value) : undefined} />
          </div>)}
          <Figures items={[
            { label: t('Time budget'), value: format.milliseconds(diagnostics.diar.budget_ms) },
            { label: t('Most speakers'), value: format.whole(diagnostics.diar.max_speakers) },
            { label: t('Separating now'), value: format.whole(diagnostics.diar.active_slots) },
            { label: t('Fingerprints made'), value: diagnostics.embedding.enabled ? format.whole(diagnostics.embedding.embeddings_total) : t('Off') },
          ]} />
        </div> : <p className="insight-muted">{t('No reading yet')}</p>}
      </InsightCard>
      <InsightCard span={4} title={t('Health checks')} description={pressureSignals.length ? t('Signals: {signals}', { signals: pressureSignals.join(', ') }) : t('Nothing is signalling pressure.')}>
        <Figures items={[
          { label: t('Worker'), value: load?.worker ? load.worker.stalled ? t('Stalled') : load.worker.alive ? t('Running') : t('Stopped') : '—', tone: load?.worker ? load.worker.stalled || !load.worker.alive ? 'danger' : 'success' : undefined },
          { label: t('Last step'), value: load?.worker?.last_tick_age_ms != null ? t('{time} ago', { time: format.milliseconds(load.worker.last_tick_age_ms) }) : '—' },
          { label: t('Step errors'), value: load?.worker ? format.whole(load.worker.tick_errors_total) : '—', tone: load?.worker?.tick_errors_total ? 'danger' : undefined },
          { label: t('Event loop'), value: load?.event_loop?.saturated ? t('Saturated') : load?.event_loop ? t('Normal') : '—', tone: load?.event_loop?.saturated ? 'danger' : undefined },
          { label: t('Audio in'), value: diagnostics ? t('{count} messages/s', { count: format.number(diagnostics.ws_ingest.msg_per_sec) }) : '—' },
          { label: t('Language switches'), value: diagnostics ? format.whole(diagnostics.engine.language_switch_total) : '—' },
          { label: t('Streams decoded'), value: diagnostics ? format.whole(diagnostics.engine.decode_streams_total) : '—' },
          { label: t('Engine errors'), value: diagnostics ? format.whole(diagnostics.engine.c_api_errors + (load?.engine?.fatal_errors_total ?? 0)) : '—', tone: diagnostics && diagnostics.engine.c_api_errors + (load?.engine?.fatal_errors_total ?? 0) > 0 ? 'danger' : undefined },
        ]} />
      </InsightCard>
    </div>
  </Section>
}

function TranslationSection({ snapshot, history, format }: { snapshot: OperationsReport['snapshot']; history: OperationsSample[]; format: InsightFormat }) {
  const { t } = useI18n()
  const status = snapshot.translator.value
  const capacity = status?.capacity
  const kv = status?.engine_metrics.kv_cache_usage_ratio
  const rows = capacity ? [
    { id: 'active', label: t('Translating'), value: capacity.active, max: capacity.active_limit },
    { id: 'queued', label: t('Waiting'), value: capacity.queued, max: capacity.queue_limit },
    { id: 'admitted', label: t('Accepted'), value: capacity.admitted, max: capacity.admitted_limit },
  ] : []
  return <Section title={t('Translation service')} description={t('Requests it is working through, and the model’s memory for them.')}>
    <ProviderNotice reading={snapshot.translator} name={t('Translation service')} />
    <div className="insights-grid">
      <InsightCard span={4} title={t('Model memory')} description={status ? <bdi>{status.model}</bdi> : undefined}>
        <div className="insight-gauge">
          <Gauge label={t('Translation model memory in use')} value={(kv ?? 0) * 100} high={85} optimum={0} size={170}
            display={kv != null ? format.percent(kv) : '—'} caption={t('KV cache')} valueText={kv != null ? format.percent(kv) : undefined} />
        </div>
        <Figures items={[
          { label: t('Taking requests'), value: status ? status.can_accept_now ? t('Yes') : t('No') : '—', tone: status ? status.can_accept_now ? 'success' : 'warning' : undefined },
          { label: t('Try again in'), value: status?.retry_after_seconds != null ? format.duration(status.retry_after_seconds) : '—' },
          { label: t('Engine'), value: status ? status.dependencies.engine_ready ? t('Ready') : t('Not ready') : '—', tone: status && !status.dependencies.engine_ready ? 'danger' : undefined },
          { label: t('Language detection'), value: status ? status.dependencies.detector_ready ? t('Ready') : t('Not ready') : '—', tone: status && !status.dependencies.detector_ready ? 'danger' : undefined },
        ]} />
      </InsightCard>
      <InsightCard span={8} title={t('Requests over time')} description={t('Translations running and waiting for room.')}>
        <HistoryChart label={t('Requests over time')} history={history} format={format} formatY={format.whole} height={220} series={[
          { id: 'active', label: t('Translating'), values: history.map((point) => point.trActive), area: true },
          { id: 'queued', label: t('Waiting'), values: history.map((point) => point.trQueued) },
          { id: 'engine', label: t('In the engine'), values: history.map((point) => point.trRunning), dashed: true },
        ]} />
      </InsightCard>
      <InsightCard span={6} title={t('Capacity')} description={t('How full each stage of the translation service is.')}>
        {rows.length ? <div className="insight-meters">{rows.map((row) => <div key={row.id} className="insight-meter">
          <span>{row.label}</span><strong>{t('{used} of {limit}', { used: format.whole(row.value), limit: format.whole(row.max) })}</strong>
          <Meter size="sm" label={row.label} value={row.value} max={row.max || 1} high={row.max * 0.8} optimum={0} valueText={t('{used} of {limit}', { used: row.value, limit: row.max })} />
        </div>)}</div> : <p className="insight-muted">{t('No reading yet')}</p>}
      </InsightCard>
      <InsightCard span={6} title={t('Model memory over time')} description={t('The share of the KV cache in use.')}>
        <HistoryChart label={t('Model memory over time')} history={history} format={format} formatY={(value) => format.percentOf100(value)} yMax={100}
          series={[{ id: 'kv', label: t('KV cache'), values: history.map((point) => point.trKv == null ? null : point.trKv * 100), area: true }]} />
      </InsightCard>
    </div>
  </Section>
}

function GpuSection({ snapshot, history, format }: { snapshot: OperationsReport['snapshot']; history: OperationsSample[]; format: InsightFormat }) {
  const { t } = useI18n()
  const devices = snapshot.gpu.value ?? []
  if (!snapshot.gpu.configured && !devices.length) return <Section title={t('GPU')} description={t('The graphics card recognition and translation run on.')}>
    <InlineMessage variant="info">{t('This server can’t read the GPU: nvidia-smi isn’t available to it.')}</InlineMessage>
  </Section>
  return <Section title={t('GPU')} description={t('The graphics card recognition and translation run on, as its driver reports it.')}>
    <ProviderNotice reading={snapshot.gpu} name={t('GPU')} />
    {devices.map((device) => {
      const memory = device.memoryTotalMb ? (device.memoryUsedMb ?? 0) / device.memoryTotalMb : null
      return <div key={device.index} className="insights-grid">
        <InsightCard span={12} title={<>{device.name} <Badge>{t('GPU {number}', { number: device.index })}</Badge></>}
          description={t('Driver {version} · performance state {state}', { version: device.driver, state: device.pstate || '—' })}>
          <div className="insight-gauges">
            <Gauge label={t('GPU utilization')} value={device.utilization ?? 0} high={90} optimum={0} size={150} display={device.utilization != null ? format.percentOf100(device.utilization) : '—'} caption={t('Utilization')} />
            <Gauge label={t('GPU memory')} value={(memory ?? 0) * 100} high={90} optimum={0} size={150} display={memory != null ? format.percent(memory) : '—'}
              caption={device.memoryUsedMb != null && device.memoryTotalMb ? t('{used} of {limit}', { used: format.megabytes(device.memoryUsedMb), limit: format.megabytes(device.memoryTotalMb) }) : t('Memory')} />
            <Gauge label={t('GPU temperature')} value={device.temperatureC ?? 0} max={100} high={83} optimum={0} size={150} display={device.temperatureC != null ? t('{count} °C', { count: format.whole(device.temperatureC) }) : '—'} caption={t('Temperature')} />
            <Gauge label={t('GPU power')} value={device.powerDrawW ?? 0} max={device.powerLimitW || 1} high={(device.powerLimitW ?? 1) * 0.9} optimum={0} size={150}
              display={device.powerDrawW != null ? t('{count} W', { count: format.whole(device.powerDrawW) }) : '—'} caption={device.powerLimitW ? t('of {count}', { count: t('{count} W', { count: format.whole(device.powerLimitW) }) }) : t('Power')} />
          </div>
          <Figures items={[
            { label: t('Core clock'), value: device.smClockMhz != null ? t('{count} MHz', { count: format.whole(device.smClockMhz) }) : '—' },
            { label: t('Memory clock'), value: device.memoryClockMhz != null ? t('{count} MHz', { count: format.whole(device.memoryClockMhz) }) : '—' },
            { label: t('Memory bandwidth in use'), value: device.memoryUtilization != null ? format.percentOf100(device.memoryUtilization) : '—' },
            { label: t('Fan'), value: device.fanSpeed != null ? format.percentOf100(device.fanSpeed) : '—' },
          ]} />
        </InsightCard>
      </div>
    })}
    <div className="insights-grid">
      <InsightCard span={6} title={t('Utilization and memory')} description={t('Share of the GPU busy, and of its memory taken.')}>
        <HistoryChart label={t('Utilization and memory')} history={history} format={format} formatY={format.percentOf100} yMax={100} series={[
          { id: 'util', label: t('Utilization'), values: history.map((point) => point.gpuUtil), area: true },
          { id: 'memory', label: t('Memory'), values: history.map((point) => point.gpuMemUsedMb != null && point.gpuMemTotalMb ? point.gpuMemUsedMb / point.gpuMemTotalMb * 100 : null) },
        ]} />
      </InsightCard>
      <InsightCard span={3} title={t('Temperature')}>
        <HistoryChart label={t('Temperature')} history={history} format={format} ticks={2} formatY={(value) => t('{count} °C', { count: format.whole(value) })} series={[{ id: 'temp', label: t('Temperature'), values: history.map((point) => point.gpuTempC), color: 'var(--tl-chart-4)' }]} />
      </InsightCard>
      <InsightCard span={3} title={t('Power')}>
        <HistoryChart label={t('Power')} history={history} format={format} ticks={2} formatY={(value) => t('{count} W', { count: format.whole(value) })} series={[{ id: 'power', label: t('Power'), values: history.map((point) => point.gpuPowerW), color: 'var(--tl-chart-1)', area: true }]} />
      </InsightCard>
    </div>
  </Section>
}
