import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTextProvider, type ResolvedLanguage } from '../../app/i18n'
import type { AudioPart } from '../../api/contracts'
import { useSessionAudio } from './useSessionAudio'
import { SessionTransport } from './SessionTransport'

const mocks = vi.hoisted(() => ({ list: vi.fn(), partUrl: vi.fn((_session: string, part: string) => `/api/audio/${part}`) }))
vi.mock('../../api/client', () => ({ api: { audio: { list: mocks.list, partUrl: mocks.partUrl } } }))
const parts: AudioPart[] = [
  { id: 'a', sessionId: 's', startMs: 5000, durationMs: 3000, sampleRate: 16000, channels: 1, bytes: 96000, state: 'ready', createdAt: '2026-09-01T00:00:00Z' },
  { id: 'b', sessionId: 's', startMs: 12000, durationMs: 4000, sampleRate: 16000, channels: 1, bytes: 128000, state: 'ready', createdAt: '2026-09-01T00:00:00Z' },
]
function Harness() {
  const player = useSessionAudio('s')
  const [locale, setLocale] = useState<ResolvedLanguage>('en')
  return <I18nTextProvider locale={locale}>
    <button onClick={() => setLocale(value => value === 'en' ? 'zh-Hans' : 'en')}>Change interface language</button>
    <SessionTransport player={player} mode="playback" onModeChange={() => undefined} recordingPanel={<p>Recording panel</p>} />
  </I18nTextProvider>
}

describe('session transport rendering', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({ parts, durationMs: 16000 })
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps the same audio node, playback position and mode while translating the controls in place', async () => {
    const user = userEvent.setup()
    const view = render(<Harness />)
    try {
      const timeline = await screen.findByRole('slider', { name: 'Playback position' })
      await waitFor(() => expect(timeline).not.toBeDisabled())
      fireEvent.change(timeline, { target: { value: '13000' } })
      const audio = view.container.querySelector('audio')!
      await waitFor(() => expect(audio).toHaveAttribute('src', '/api/audio/b'))
      Object.defineProperty(audio, 'duration', { configurable: true, value: 4 })
      fireEvent.loadedMetadata(audio)
      audio.currentTime = 1.2
      fireEvent.timeUpdate(audio)
      fireEvent.play(audio)
      expect(screen.getByRole('button', { name: 'Pause playback' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Change interface language' }))
      expect(view.container.querySelector('audio')).toBe(audio)
      expect(audio.currentTime).toBe(1.2)
      expect(audio).toHaveAttribute('src', '/api/audio/b')
      expect(screen.getByRole('slider', { name: '播放进度' })).toHaveValue('13200')
      expect(screen.getByRole('button', { name: '暂停回放' })).toBeInTheDocument()
      expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })

  it('disables controls and explains an empty audio catalog', async () => {
    mocks.list.mockResolvedValue({ parts: [], durationMs: 0 })
    const view = render(<Harness />)
    try {
      expect(await screen.findByText('No audio is available for this session yet. New recordings are saved automatically.')).toBeInTheDocument()
      expect(screen.getByRole('slider', { name: 'Playback position' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Play recording' })).toBeDisabled()
    } finally { view.unmount() }
  })
})
