import { useId, type CSSProperties } from 'react'
import { useI18n } from '../../app/i18n'
import { captureModeDefaults, MAX_MICROPHONE_GAIN, MIN_MICROPHONE_GAIN, type CaptureMode, type LocalPreferences } from '../../app/preferences'
import { Icon } from '../../design-system'
import './audio-capture-settings.css'

const modes: Array<{ mode: CaptureMode; title: string; detail: string }> = [
  { mode: 'studio', title: 'Studio · natural detail', detail: 'Best with headphones or a dedicated microphone. Browser voice processing stays off.' },
  { mode: 'communication', title: 'Communication · calls', detail: 'Browser echo cancellation, noise suppression and automatic gain help with speakerphone calls.' },
]

/** Two rows of the settings card: how the microphone is processed, and how loud it is taken. */
export function AudioCaptureSettings({ value, onChange, disabled = false }: {
  value: LocalPreferences
  onChange: (next: LocalPreferences) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const heading = useId()
  const changeMode = (mode: CaptureMode) => onChange({ ...value, captureMode: mode, ...captureModeDefaults(mode) })
  const fill = (value.microphoneGain - MIN_MICROPHONE_GAIN) / (MAX_MICROPHONE_GAIN - MIN_MICROPHONE_GAIN) * 100
  return <>
    <div className="setting-row setting-row--stack">
      <div><h3 id={heading}>{t('Microphone processing')}</h3><p>{t('A Bluetooth headset may use its system call-quality profile. This setting cannot override that hardware mode.')}</p></div>
      <div className="capture-modes" role="radiogroup" aria-labelledby={heading}>{modes.map(item => <label key={item.mode} className="capture-mode" data-selected={value.captureMode === item.mode || undefined}>
        <input type="radio" name="microphone-processing" value={item.mode} checked={value.captureMode === item.mode} disabled={disabled} onChange={() => changeMode(item.mode)} />
        <strong>{t(item.title)}</strong><small>{t(item.detail)}</small>
        <span className="capture-mode__check" aria-hidden="true"><Icon name="check" size={13} /></span>
      </label>)}</div>
    </div>
    <div className="setting-row">
      <div><h3><label htmlFor="microphone-gain">{t('Microphone level')}</label></h3><p>{t('Raise quiet voices without clipping loud peaks. Changes apply to the next recording.')}</p></div>
      <div className="gain-control">
        <input id="microphone-gain" type="range" min={MIN_MICROPHONE_GAIN} max={MAX_MICROPHONE_GAIN} step="0.1" value={value.microphoneGain} disabled={disabled}
          aria-label={t('Microphone level')} aria-valuetext={`${value.microphoneGain.toFixed(1)}×`} style={{ '--_fill': `${fill}%` } as CSSProperties}
          onChange={event => onChange({ ...value, microphoneGain: Number(event.target.value) })} />
        <output htmlFor="microphone-gain">{value.microphoneGain.toFixed(1)}×</output>
      </div>
    </div>
  </>
}
