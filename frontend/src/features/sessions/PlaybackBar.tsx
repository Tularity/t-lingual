import { useCallback, useEffect, type CSSProperties, type ReactNode } from 'react'
import { Select, SelectOption } from '@t-lingual/ui'
import { Button, Icon } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { audioTimestamp } from './SessionTransport'
import type { SessionPlayer } from './useSessionAudio'
import './playback-bar.css'

/**
 * A saved conversation's audio, in one bar: play, a timeline, speed and
 * volume — and, at its end, whatever lets the conversation go on (`action`).
 * With no audio yet it is one quiet line; while someone is recording it says
 * so, and plays nothing.
 */
export function PlaybackBar({ player, recording = false, action }: { player: SessionPlayer; recording?: boolean; action?: ReactNode }) {
  const { t } = useI18n()
  const attach = player.bindAudio
  const bind = useCallback((node: HTMLAudioElement | null) => attach(node), [attach])
  const pause = player.pause
  useEffect(() => { if (recording) pause() }, [pause, recording])
  const hasAudio = player.ready.length > 0
  const { durationMs } = player.catalog

  let body: ReactNode
  if (recording) body = <p className="playback-bar__note"><span className="playback-bar__live" aria-hidden="true" />{t('Recording in progress')}</p>
  else if (player.catalogLoading) body = <p className="playback-bar__note">{t('Loading recordings…')}</p>
  else if (!hasAudio) body = <p className="playback-bar__note"><Icon name="wave" size={15} />{t('No audio for this session yet.')}</p>
  else body = <>
    <div className="playback-bar__main">
      <Button size="sm" variant="ghost" aria-label={t('Back 10 seconds')} onClick={() => player.seek(player.positionMs - 10000)}>−10s</Button>
      <Button variant="primary" icon={player.playing ? 'pause' : 'play'} iconOnly loading={player.loading} className="playback-bar__play" aria-label={player.playing ? t('Pause playback') : t('Play recording')} onClick={() => player.playing ? player.pause() : player.play()} />
      <Button size="sm" variant="ghost" aria-label={t('Forward 10 seconds')} onClick={() => player.seek(player.positionMs + 10000)}>+10s</Button>
    </div>
    <div className="playback-bar__timeline">
      <time>{audioTimestamp(player.positionMs)}</time>
      <input type="range" min={0} max={Math.max(1, durationMs)} step={100} value={Math.min(player.positionMs, Math.max(1, durationMs))} aria-label={t('Playback position')} aria-valuetext={`${audioTimestamp(player.positionMs)} / ${audioTimestamp(durationMs)}`} onChange={event => player.seek(Number(event.target.value))} style={{ '--audio-progress': `${durationMs ? player.positionMs / durationMs * 100 : 0}%` } as CSSProperties} />
      <time>{audioTimestamp(durationMs)}</time>
    </div>
    <div className="playback-bar__options">
      <Select size="sm" className="playback-bar__speed" aria-label={t('Playback speed')} value={String(player.rate)} onValueChange={value => player.setRate(Number(value))}>{[.5, .75, 1, 1.25, 1.5, 2].map(rate => <SelectOption key={rate} value={String(rate)}>{rate}×</SelectOption>)}</Select>
      <label className="playback-bar__volume"><Icon name="volume" size={15} /><span className="sr-only">{t('Volume')}</span><input aria-label={t('Volume')} type="range" min={0} max={1} step={.05} value={player.volume} onChange={event => player.setVolume(Number(event.target.value))} /></label>
    </div>
  </>

  return <section className="playback-bar" aria-label={t('Session audio')} data-audio={hasAudio && !recording || undefined}>
    <audio ref={bind} src={player.source} preload="metadata" onLoadedMetadata={player.onLoadedMetadata} onTimeUpdate={player.onTimeUpdate} onEnded={player.onEnded} onPlay={player.onPlay} onPause={player.onPause} onError={player.onError} />
    {body}
    {action && <div className="playback-bar__action">{action}</div>}
    {player.error && <p className="playback-bar__error" role="alert">{t(player.error)} <button type="button" onClick={player.retry}>{t('Try again')}</button></p>}
  </section>
}
