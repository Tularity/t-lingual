import { useI18n } from '../../app/i18n'
import { captureModeDefaults, MAX_MICROPHONE_GAIN, MIN_MICROPHONE_GAIN, type CaptureMode, type LocalPreferences } from '../../app/preferences'
import './audio-capture-settings.css'

export function AudioCaptureSettings({ value, onChange, disabled = false }: {
  value: LocalPreferences
  onChange: (next: LocalPreferences) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const changeMode = (mode: CaptureMode) => onChange({ ...value, captureMode: mode, ...captureModeDefaults(mode) })
  return <fieldset className="audio-capture-settings" disabled={disabled}>
    <legend>{t('Microphone processing')}</legend>
    <div className="audio-capture-settings__modes">
      <label data-selected={value.captureMode === 'studio' || undefined}>
        <input type="radio" name="microphone-processing" value="studio" checked={value.captureMode === 'studio'} onChange={() => changeMode('studio')} />
        <span><strong>{t('Studio · natural detail')}</strong><small>{t('Best with headphones or a dedicated microphone. Browser voice processing stays off.')}</small></span>
      </label>
      <label data-selected={value.captureMode === 'communication' || undefined}>
        <input type="radio" name="microphone-processing" value="communication" checked={value.captureMode === 'communication'} onChange={() => changeMode('communication')} />
        <span><strong>{t('Communication · calls')}</strong><small>{t('Browser echo cancellation, noise suppression and automatic gain help with speakerphone calls.')}</small></span>
      </label>
    </div>
    <div className="audio-capture-settings__gain">
      <label htmlFor="microphone-gain">{t('Microphone level')}</label>
      <output htmlFor="microphone-gain">{value.microphoneGain.toFixed(1)}×</output>
      <input id="microphone-gain" type="range" min={MIN_MICROPHONE_GAIN} max={MAX_MICROPHONE_GAIN} step="0.1" value={value.microphoneGain}
        aria-label={t('Microphone level')} aria-valuetext={`${value.microphoneGain.toFixed(1)}×`}
        onChange={event => onChange({ ...value, microphoneGain: Number(event.target.value) })} />
      <p>{t('Raise quiet voices without clipping loud peaks. Changes apply to the next recording.')}</p>
    </div>
    <p className="audio-capture-settings__note">{t('A Bluetooth headset may use its system call-quality profile. This setting cannot override that hardware mode.')}</p>
  </fieldset>
}
