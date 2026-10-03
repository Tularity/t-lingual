import type { ReactNode } from 'react'
import { BarChart, BarList, DonutChart, Heatmap, LineChart } from '@tular/ui'
import type { UsageReport, UsageSlice } from '../../api/contracts'
import { Link } from '../../app/router'
import { useI18n } from '../../app/i18n'
import { localeIntlTag } from '../../app/i18n/locales'
import { languageDisplayName } from '../languages/LanguageLabel'
import { InsightCard, StatRow, StatTile } from './InsightParts'
import { durationScale, weekdayNames, type InsightFormat } from './format'

const sum = (report: UsageReport, key: keyof UsageReport['days'][number]) => report.days.reduce((total, day) => total + (Number(day[key]) || 0), 0)

/** The screen-reader sentences the charts speak, in the reader's language. */
export function useChartSpeech() {
  const { t } = useI18n()
  return {
    line: (label: string, latest: string | null, highest: string | null) => latest === null ? t('{label}: no data.', { label }) : t('{label}: latest {latest}, highest {highest}.', { label, latest, highest: highest ?? latest }),
    bars: (label: string, total: string) => t('{label}: {total} in total.', { label, total }),
  }
}

/** The headline figures of a period's use. */
export function UsageStats({ report, format, site }: { report: UsageReport; format: InsightFormat; site?: boolean }) {
  const { t } = useI18n()
  const recorded = sum(report, 'recordedSeconds')
  const speech = sum(report, 'speechSeconds')
  const translations = sum(report, 'translations')
  const failures = sum(report, 'translationFailures')
  const people = report.users?.filter((user) => user.recordedSeconds > 0).length ?? 0
  return <StatRow label={t('Totals for this period')}>
    <StatTile icon="microphone" label={t('Recorded')} value={format.duration(recorded)} detail={t(sum(report, 'sessions') === 1 ? '{count} session' : '{count} sessions', { count: format.whole(sum(report, 'sessions')) })} trend={report.days.map((day) => day.recordedSeconds)} />
    <StatTile icon="wave" label={t('Speech recognized')} value={format.duration(speech)} detail={recorded ? t('{percent} of recorded time', { percent: format.percent(speech / recorded) }) : undefined} trend={report.days.map((day) => day.speechSeconds)} />
    <StatTile icon="list" label={t('Transcript lines')} value={format.whole(sum(report, 'segments'))} detail={t('{count} characters', { count: format.compact(sum(report, 'sourceCharacters')) })} trend={report.days.map((day) => day.segments)} />
    <StatTile icon="languages" label={t('Translations')} value={format.whole(translations)} tone={translations && failures / translations > 0.02 ? 'warning' : undefined}
      detail={failures ? t('{count} failed', { count: format.whole(failures) }) : t('None failed')} trend={report.days.map((day) => day.translations)} />
    {site ? <>
      <StatTile icon="users" label={t('People who recorded')} value={format.whole(people)} detail={t('{count} sign-ins', { count: format.whole(sum(report, 'signIns')) })} trend={report.days.map((day) => day.activeUsers ?? 0)} />
      <StatTile icon="link" label={t('Guest visits')} value={format.whole(sum(report, 'guestViews'))} detail={t('{count} links made', { count: format.whole(sum(report, 'shares')) })} trend={report.days.map((day) => day.guestViews ?? 0)} />
    </> : <StatTile icon="link" label={t('Links made')} value={format.whole(sum(report, 'shares'))} trend={report.days.map((day) => day.shares)} />}
  </StatRow>
}

function languageItems(slices: UsageSlice[], locale: Parameters<typeof languageDisplayName>[1], unknown: string) {
  return slices.map((slice) => {
    const name = slice.key && slice.key !== 'auto' && slice.key !== 'unknown' ? languageDisplayName(slice.key, locale) : unknown
    return { id: slice.key || 'unknown', label: name, textLabel: name, value: slice.value }
  })
}

/** Where the period's time and text went, chart by chart. */
export function UsageCharts({ report, format, site, extra, workspaceName = (name) => name }: { report: UsageReport; format: InsightFormat; site?: boolean; extra?: ReactNode; workspaceName?: (name: string) => string }) {
  const { t, locale } = useI18n()
  const speech = useChartSpeech()
  const dates = report.days.map((day) => day.date)
  const dayLabel = (date: string) => format.day(date)
  const everyNth = Math.max(1, Math.ceil(dates.length / 8))
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour))
  const speakerLabel = (key: string) => key === 'none' ? t('Not attributed') : t('Speaker {number}', { number: key.replace(/^speaker_/u, '') })
  const totalSpeech = sum(report, 'speechSeconds')
  const time = durationScale(report.days.map((day) => day.recordedSeconds), format)
  return <div className="insights-grid">
    <InsightCard span={8} title={t('Recording time')} description={t('Each day’s recording, and how much of it was speech.')}>
      <BarChart label={t('Recording time')} categories={dates} stacked height={220} formatCategory={dayLabel} xTicks={8} formatY={time.formatY} describeSeries={speech.bars}
        emptyLabel={t('Nothing recorded in this period')}
        series={[
          { id: 'speech', label: t('Speech'), values: report.days.map((day) => time.scale(day.speechSeconds)) },
          { id: 'quiet', label: t('Pauses'), values: report.days.map((day) => time.scale(Math.max(0, day.recordedSeconds - day.speechSeconds))), color: 'var(--tl-chart-rest)' },
        ]} />
    </InsightCard>
    <InsightCard span={4} title={t('Languages spoken')} description={t('Share of recognized speech.')}>
      <DonutChart label={t('Languages spoken')} items={languageItems(report.languages, locale, t('Unknown'))} formatValue={format.duration} emptyLabel={t('No speech yet')}
        center={<><b>{format.shortDuration(totalSpeech)}</b><span>{t('speech')}</span></>} />
    </InsightCard>
    <InsightCard span={8} title={t('When recording happens')} description={t('Speech by weekday and hour, in your time zone.')}>
      <Heatmap label={t('When recording happens')} rows={weekdayNames(localeIntlTag(locale))} columns={hours} values={report.hours} formatValue={format.duration} columnLabelEvery={3} />
    </InsightCard>
    <InsightCard span={4} title={t('Translated into')} description={t('Share of translated text.')}>
      <DonutChart label={t('Translated into')} items={languageItems(report.targets, locale, t('Unknown'))} formatValue={(value) => t('{count} characters', { count: format.compact(value) })} emptyLabel={t('No translations yet')}
        center={<><b>{format.compact(sum(report, 'translations'))}</b><span>{t('translations')}</span></>} />
    </InsightCard>
    <InsightCard span={6} title={t('Text produced')} description={t('Characters transcribed and translated each day.')}>
      <LineChart label={t('Text produced')} x={dates} formatX={(value) => dayLabel(String(value))} formatY={format.compact} height={190} describeSeries={speech.line}
        series={[
          { id: 'source', label: t('Transcribed'), values: report.days.map((day) => day.sourceCharacters), area: true },
          { id: 'translated', label: t('Translated'), values: report.days.map((day) => day.translationCharacters) },
        ]} xTicks={Math.min(6, Math.ceil(dates.length / everyNth))} />
    </InsightCard>
    <InsightCard span={6} title={t('Speakers')} description={t('Share of speech by the speakers told apart in each session.')}>
      <BarList label={t('Speakers')} items={report.speakers.map((slice) => ({ id: slice.key, label: speakerLabel(slice.key), value: slice.value, description: slice.count ? t('{count} lines', { count: format.whole(slice.count) }) : undefined }))}
        formatValue={format.duration} emptyLabel={t('No speech yet')} />
    </InsightCard>
    <InsightCard span={site ? 8 : 6} title={t('Longest sessions')} description={t('The sessions with the most recording in this period.')}>
      <BarList label={t('Longest sessions')} emptyLabel={t('No sessions in this period')} formatValue={format.duration}
        items={report.topSessions.map((session) => ({ id: session.id, value: session.recordedSeconds, label: site ? <bdi>{session.title}</bdi> : <Link href={`/sessions/${encodeURIComponent(session.id)}`}><bdi>{session.title}</bdi></Link>,
          description: [session.ownerName, t('{count} lines', { count: format.whole(session.segments) })].filter(Boolean).join(' · ') }))} />
    </InsightCard>
    {!site && report.workspaces.length ? <InsightCard span={6} title={t('Workspaces')} description={t('Recording by workspace.')}>
      <BarList label={t('Workspaces')} formatValue={format.duration} items={report.workspaces.map((slice) => ({ id: slice.key, label: <bdi>{workspaceName(slice.label ?? '')}</bdi>, value: slice.value,
        description: t(slice.count === 1 ? '{count} session' : '{count} sessions', { count: format.whole(slice.count ?? 0) }) }))} />
    </InsightCard> : null}
    <InsightCard span={site ? 4 : report.workspaces.length ? 12 : 6} title={t('Added to storage')} description={t('Audio and text recorded in this period.')}>
      <BarList label={t('Added to storage')} formatValue={format.bytes} items={[
        { id: 'audio', label: t('Recorded audio'), value: report.audioBytes },
        { id: 'text', label: t('Transcripts and translations'), value: report.transcriptBytes },
      ]} />
    </InsightCard>
    {extra}
  </div>
}
