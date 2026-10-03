import {useCallback,useEffect} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Icon } from '../../design-system'
import { SegmentedControl, Select, SelectOption } from '@tular/ui'
import { useI18n } from '../../app/i18n'
import type { SessionPlayer } from './useSessionAudio'
import './transport.css'

export function audioTimestamp(ms: number) {
  const seconds=Math.floor(Math.max(0,ms)/1000)
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`
}

export function SessionTransport({player,mode,onModeChange,recording,recordingPanel}: {
  player:SessionPlayer; mode:'record'|'playback';onModeChange:(mode:'record'|'playback')=>void;
  recording?:boolean;recordingPanel:ReactNode;
}) {
  const {t}=useI18n()
  const disabled=player.ready.length===0
  const effectiveMode=recording?'record':mode
  const attach=player.bindAudio
  const bindElement=useCallback((node:HTMLAudioElement|null)=>attach(node),[attach])
  const pause=player.pause
  useEffect(()=>{if(recording)pause()},[pause,recording])
  return <section className="session-transport" aria-label={t('Session audio')}>
    <audio ref={bindElement} src={player.source} preload="metadata" onLoadedMetadata={player.onLoadedMetadata} onTimeUpdate={player.onTimeUpdate} onEnded={player.onEnded} onPlay={player.onPlay} onPause={player.onPause} onError={player.onError} />
    <div className="session-transport__heading"><SegmentedControl aria-label={t('Audio controls')} value={effectiveMode} onChange={value=>{player.pause();if(value==='playback')player.seek(player.positionMs,false);onModeChange(value as 'record'|'playback')}} items={[{value:'record',label:t('Recording')},{value:'playback',label:t('Playback'),disabled:recording}]} /><span>{effectiveMode==='playback' ? player.catalogLoading ? t('Loading recordings…') : t('{count} recordings',{count:player.ready.length}) : t('One conversation, ready to continue')}</span></div>
    {effectiveMode==='record' ? recordingPanel : <div className="session-transport__playback">
      <div className="session-transport__timeline"><time>{audioTimestamp(player.positionMs)}</time><input type="range" min={0} max={Math.max(1,player.catalog.durationMs)} step={100} value={Math.min(player.positionMs,Math.max(1,player.catalog.durationMs))} disabled={disabled} aria-label={t('Playback position')} aria-valuetext={`${audioTimestamp(player.positionMs)} / ${audioTimestamp(player.catalog.durationMs)}`} onChange={event=>player.seek(Number(event.target.value))} style={{'--audio-progress':`${player.catalog.durationMs?player.positionMs/player.catalog.durationMs*100:0}%`} as CSSProperties} /><time>{audioTimestamp(player.catalog.durationMs)}</time></div>
      <div className="session-transport__buttons"><div className="session-transport__main"><Button size="sm" disabled={disabled} variant="ghost" aria-label={t('Back 10 seconds')} onClick={()=>player.seek(player.positionMs-10000)}>−10s</Button><Button variant="primary" icon={player.playing?'pause':'play'} loading={player.loading} disabled={disabled} aria-label={player.playing?t('Pause playback'):t('Play recording')} onClick={()=>player.playing?player.pause():player.play()}>{player.playing?t('Pause'):t('Play')}</Button><Button size="sm" disabled={disabled} variant="ghost" aria-label={t('Forward 10 seconds')} onClick={()=>player.seek(player.positionMs+10000)}>+10s</Button></div><div className="session-transport__options"><Select size="sm" className="session-transport__speed" aria-label={t('Playback speed')} value={String(player.rate)} onValueChange={value=>player.setRate(Number(value))}>{[.5,.75,1,1.25,1.5,2].map(rate=><SelectOption key={rate} value={String(rate)}>{rate}×</SelectOption>)}</Select><label className="session-transport__volume"><Icon name="wave" size={15} /><span className="sr-only">{t('Volume')}</span><input aria-label={t('Volume')} type="range" min={0} max={1} step={.05} value={player.volume} onChange={event=>player.setVolume(Number(event.target.value))} /></label></div></div>
      {!player.catalogLoading&&disabled&&<p className="session-transport__notice">{t('No audio is available for this session yet. New recordings are saved automatically.')}</p>}
      {player.error&&<p className="session-transport__error" role="alert">{t(player.error)} <button type="button" onClick={player.retry}>{t('Try again')}</button></p>}
    </div>}
  </section>
}
