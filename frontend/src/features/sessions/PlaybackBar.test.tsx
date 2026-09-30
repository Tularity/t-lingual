import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '../../design-system'
import { PlaybackBar } from './PlaybackBar'
import type { SessionPlayer } from './useSessionAudio'

function player(overrides: Partial<SessionPlayer> = {}) {
  return {
    ready: [], catalog: { parts: [], durationMs: 0 }, catalogLoading: false, positionMs: 0, playing: false, loading: false,
    rate: 1, volume: 1, error: '', source: '', seekToken: 0,
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setRate: vi.fn(), setVolume: vi.fn(), retry: vi.fn(), bindAudio: vi.fn(),
    onLoadedMetadata: vi.fn(), onTimeUpdate: vi.fn(), onEnded: vi.fn(), onPlay: vi.fn(), onPause: vi.fn(), onError: vi.fn(),
    ...overrides,
  } as unknown as SessionPlayer
}
const part = { id: 'p1', sessionId: 's', startMs: 0, durationMs: 60_000, sampleRate: 48000, channels: 1, bytes: 1, createdAt: '2026-01-01T00:00:00Z', state: 'ready' as const }

describe('PlaybackBar', () => {
  it('is one quiet line, with the way to go on, when there is no audio yet', () => {
    render(<ThemeProvider><PlaybackBar player={player()} action={<button type="button">Continue recording</button>} /></ThemeProvider>)
    expect(screen.getByText('No audio for this session yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play recording' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue recording' })).toBeInTheDocument()
  })

  it('says a recording is under way, and plays nothing, while one is', () => {
    const pause = vi.fn()
    render(<ThemeProvider><PlaybackBar player={player({ ready: [part], pause })} recording /></ThemeProvider>)
    expect(screen.getByText('Recording in progress')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play recording' })).toBeNull()
    expect(pause).toHaveBeenCalled()
  })

  it('plays and seeks saved audio', async () => {
    const play = vi.fn(), seek = vi.fn()
    render(<ThemeProvider><PlaybackBar player={player({ ready: [part], catalog: { parts: [part], durationMs: 60_000 }, positionMs: 20_000, play, seek })} /></ThemeProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Play recording' }))
    expect(play).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Forward 10 seconds' }))
    expect(seek).toHaveBeenCalledWith(30_000)
    expect(screen.getByRole('slider', { name: 'Playback position' })).toHaveAttribute('aria-valuetext', '0:20 / 1:00')
  })
})
