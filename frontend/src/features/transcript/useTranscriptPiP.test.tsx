import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Segment } from '../../api/contracts'
import { TranscriptPiPButton, wrapCanvasText } from './useTranscriptPiP'

const segment: Segment = { id: 's1', sessionId: 'session', sequence: 1, sourceText: 'Hello everyone', translation: '大家好', translationStatus: 'succeeded', final: true, startMs: 0, endMs: 1000, createdAt: '2026-01-01T00:00:00Z', speakerId: 'speaker_1' }
const props = { segments: [segment], title: 'Product meeting', sourceLanguage: 'en', targetLanguage: 'zh-Hans', live: true }

describe('transcript picture-in-picture', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'documentPictureInPicture')
    Reflect.deleteProperty(document, 'pictureInPictureEnabled')
    Reflect.deleteProperty(document, 'pictureInPictureElement')
    Reflect.deleteProperty(document, 'exitPictureInPicture')
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestPictureInPicture')
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'webkitSupportsPresentationMode')
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode')
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'webkitPresentationMode')
    vi.restoreAllMocks()
    document.documentElement.dataset.theme = 'light'
  })

  it('opens Document PiP on a click, mirrors theme, and closes on unmount under StrictMode', async () => {
    const pipDocument = document.implementation.createHTMLDocument('')
    const close = vi.fn()
    const pipWindow = { document: pipDocument, closed: false, close, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const requestWindow = vi.fn(async () => pipWindow)
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow } })
    const view = render(<StrictMode><TranscriptPiPButton {...props} /></StrictMode>)
    await userEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
    expect(requestWindow).toHaveBeenCalledWith({ width: 480, height: 300 })
    await waitFor(() => expect(pipDocument.body.textContent).toContain('Hello everyone'))
    expect(pipDocument.body.textContent).not.toContain('Speaker 1')
    expect(pipDocument.body.querySelectorAll('.tv-pip__pane')).toHaveLength(2)
    expect(pipDocument.body.querySelectorAll('time')).toHaveLength(0)
    document.documentElement.dataset.theme = 'dark'
    await waitFor(() => expect(pipDocument.documentElement.dataset.theme).toBe('dark'))
    view.unmount()
    expect(close).toHaveBeenCalled()
  })

  /** A browser that floats video: a canvas that captures, a video that is ready at once. */
  function videoBrowser() {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: (text: string) => ({ width: Array.from(text).length * 8 }) }
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => stream })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLVideoElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLVideoElement.prototype, 'pause').mockImplementation(() => undefined)
    Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, value: vi.fn(async () => undefined) })
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(HTMLMediaElement.HAVE_ENOUGH_DATA)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    return { stop, context }
  }

  it('stops video capture tracks when fallback PiP closes', async () => {
    const { stop } = videoBrowser()
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: vi.fn(async () => undefined) })
    const view = render(<TranscriptPiPButton {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
    expect(await screen.findByRole('button', { name: 'Close picture-in-picture' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close picture-in-picture' }))
    expect(stop).toHaveBeenCalledOnce()
    view.unmount()
  })

  it('requests standard video PiP within the click when a frame is already ready', async () => {
    videoBrowser()
    const request = vi.fn(async () => undefined)
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: request })
    render(<TranscriptPiPButton {...props} />)
    // The video is made ready while nobody is waiting for it…
    await waitFor(() => expect(document.querySelector('video.tv-pip-video-source')).not.toBeNull())
    // …so the click asks for it before it returns.
    fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
    expect(request).toHaveBeenCalledOnce()
    expect(await screen.findByRole('button', { name: 'Close picture-in-picture' })).toBeInTheDocument()
  })

  it('floats the video through WebKit presentation mode where the standard API is missing', async () => {
    videoBrowser()
    let mode = 'inline'
    const setMode = vi.fn(function (this: HTMLVideoElement, next: string) { mode = next; this.dispatchEvent(new Event('webkitpresentationmodechanged')) })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsPresentationMode', { configurable: true, value: (value: string) => value === 'picture-in-picture' })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', { configurable: true, value: setMode })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitPresentationMode', { configurable: true, get: () => mode })
    render(<TranscriptPiPButton {...props} />)
    const button = screen.getByRole('button', { name: 'Picture-in-picture' })
    expect(button).toBeEnabled()
    await waitFor(() => expect(document.querySelector('video.tv-pip-video-source')).not.toBeNull())
    fireEvent.click(button)
    expect(setMode).toHaveBeenCalledWith('picture-in-picture')
    expect(await screen.findByRole('button', { name: 'Close picture-in-picture' })).toBeInTheDocument()
    // Closed from the floating window's own control.
    act(() => { mode = 'inline'; document.querySelector('video.tv-pip-video-source')!.dispatchEvent(new Event('webkitpresentationmodechanged')) })
    expect(await screen.findByRole('button', { name: 'Picture-in-picture' })).toBeInTheDocument()
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'webkitPresentationMode')
  })

  it('prefers WebKit presentation mode where Safari offers both, playing the video from the click first', async () => {
    videoBrowser()
    const order: string[] = []
    vi.mocked(HTMLVideoElement.prototype.play).mockImplementation(async () => { order.push('play') })
    const request = vi.fn(async () => { order.push('standard') })
    let mode = 'inline'
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: request })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsPresentationMode', { configurable: true, value: (value: string) => value === 'picture-in-picture' })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', { configurable: true, value: vi.fn((next: string) => { order.push(next); mode = next }) })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitPresentationMode', { configurable: true, get: () => mode })
    render(<TranscriptPiPButton {...props} />)
    await waitFor(() => expect(document.querySelector('video.tv-pip-video-source')).not.toBeNull())
    // The video is in the page itself, as Safari requires of one it floats.
    expect(document.querySelector('video.tv-pip-video-source')!.parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
    expect(order).toEqual(['play', 'picture-in-picture'])
    expect(request).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Close picture-in-picture' })).toBeInTheDocument()
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'webkitPresentationMode')
  })

  it('uses WebKit even when an unloaded probe reports no supported presentation mode', async () => {
    videoBrowser()
    const standard = vi.fn(async () => undefined)
    const webkit = vi.fn()
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: standard })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsPresentationMode', { configurable: true, value: () => false })
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', { configurable: true, value: webkit })
    render(<TranscriptPiPButton {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
    expect(webkit).toHaveBeenCalledWith('picture-in-picture')
    expect(standard).not.toHaveBeenCalled()
    const video = document.querySelector<HTMLVideoElement>('video.tv-pip-video-source')!
    // macOS Safari uses the inline box to size its native floating window.
    expect(Number.parseFloat(video.style.width) / Number.parseFloat(video.style.height)).toBe(video.width / video.height)
    expect(video.width / video.height).toBe(640 / 400)
  })

  it('keeps drawing fresh transcript frames while playback is waiting to become ready', async () => {
    const { context } = videoBrowser()
    vi.useFakeTimers()
    try {
      let ready: number = HTMLMediaElement.HAVE_NOTHING
      vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => ready)
      let resolvePlay!: () => void
      vi.mocked(HTMLVideoElement.prototype.play).mockImplementation(() => new Promise<void>(resolve => { resolvePlay = resolve }))
      const request = vi.fn(async () => undefined)
      Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
      Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: request })
      const view = render(<TranscriptPiPButton {...props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
      expect(request).not.toHaveBeenCalled()
      context.fillText.mockClear()
      view.rerender(<TranscriptPiPButton {...props} segments={[{ ...segment, sourceText: 'New partial speech', final: false }]} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(context.fillText).toHaveBeenCalledWith('New partial speech', expect.any(Number), expect.any(Number))
      await act(async () => { ready = HTMLMediaElement.HAVE_CURRENT_DATA; resolvePlay() })
      expect(request).toHaveBeenCalledOnce()
      view.unmount()
      context.fillText.mockClear()
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(context.fillText).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('does not pause recording when WebKit closes before the standard PiP element clears', async () => {
    videoBrowser()
    vi.useFakeTimers()
    try {
      let mode = 'inline'
      Object.defineProperty(HTMLVideoElement.prototype, 'webkitPresentationMode', { configurable: true, get: () => mode })
      Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', { configurable: true, value: (next: string) => { mode = next } })
      const onPause = vi.fn(), onResume = vi.fn()
      const view = render(<TranscriptPiPButton {...props} control={{ recording: true, label: 'Recording', onPause, onResume }} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' })) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      const video = document.querySelector<HTMLVideoElement>('video.tv-pip-video-source')!
      // Safari retains this reference during its native close animation.
      Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video })
      await act(async () => {
        mode = 'inline'
        video.dispatchEvent(new Event('pause'))
        video.dispatchEvent(new Event('webkitpresentationmodechanged'))
        await vi.advanceTimersByTimeAsync(2500)
      })
      expect(onPause).not.toHaveBeenCalled()
      expect(onResume).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Picture-in-picture' })).toBeInTheDocument()
      expect(video.isConnected).toBe(false)
      view.unmount()
    } finally { vi.useRealTimers() }
  })

  it('presents the paused status before freezing the video without resuming recording', async () => {
    const { context } = videoBrowser()
    vi.useFakeTimers()
    try {
      let paused = true
      vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused)
      vi.mocked(HTMLVideoElement.prototype.play).mockImplementation(async function (this: HTMLVideoElement) { paused = false; this.dispatchEvent(new Event('play')) })
      vi.mocked(HTMLVideoElement.prototype.pause).mockImplementation(function (this: HTMLVideoElement) { paused = true; this.dispatchEvent(new Event('pause')) })
      Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
      Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: vi.fn(async function (this: HTMLVideoElement) { Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: this }) }) })
      const onPause = vi.fn(), onResume = vi.fn()
      const view = render(<TranscriptPiPButton {...props} control={{ recording: true, label: 'Recording', onPause, onResume }} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' })) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      const video = document.querySelector<HTMLVideoElement>('video.tv-pip-video-source')!
      await act(async () => { video.pause(); await vi.advanceTimersByTimeAsync(800) })
      expect(onPause).toHaveBeenCalledOnce()
      context.fillText.mockClear()
      view.rerender(<TranscriptPiPButton {...props} control={{ recording: false, label: 'Audio paused', onPause, onResume }} />)
      expect(context.fillText).toHaveBeenCalledWith('Audio paused', expect.any(Number), expect.any(Number))
      expect(paused).toBe(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(130) })
      expect(paused).toBe(true)
      expect(onResume).not.toHaveBeenCalled()
      expect(onPause).toHaveBeenCalledOnce()
      // A later recording change must cancel a pending internal pause.
      view.rerender(<TranscriptPiPButton {...props} control={{ recording: true, label: 'Recording', onPause, onResume }} />)
      view.rerender(<TranscriptPiPButton {...props} control={{ recording: false, label: 'Audio paused', onPause, onResume }} />)
      view.rerender(<TranscriptPiPButton {...props} control={{ recording: true, label: 'Recording', onPause, onResume }} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(paused).toBe(false)
      expect(onResume).not.toHaveBeenCalled()
      view.unmount()
    } finally { vi.useRealTimers() }
  })

  it('pauses and resumes the recording from the floating window’s own controls', async () => {
    videoBrowser()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let paused = true
      vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused)
      vi.mocked(HTMLVideoElement.prototype.play).mockImplementation(async () => { paused = false })
      vi.mocked(HTMLVideoElement.prototype.pause).mockImplementation(() => { paused = true })
      Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
      Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: vi.fn(async function (this: HTMLVideoElement) { Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: this }) }) })
      const onPause = vi.fn(), onResume = vi.fn()
      const view = render(<TranscriptPiPButton {...props} control={{ recording: true, label: 'Recording 00:12', onPause, onResume }} />)
      await vi.waitFor(() => expect(document.querySelector('video.tv-pip-video-source')).not.toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
      expect(await screen.findByRole('button', { name: 'Close picture-in-picture' })).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      const video = document.querySelector('video.tv-pip-video-source')!
      // The viewer presses pause in the floating window.
      await act(async () => { paused = true; video.dispatchEvent(new Event('pause')); await vi.advanceTimersByTimeAsync(800) })
      expect(onPause).toHaveBeenCalledOnce()
      // The page pausing the video to match a paused recording is not taken for the viewer's.
      view.rerender(<TranscriptPiPButton {...props} control={{ recording: false, label: 'Paused', onPause, onResume }} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(onPause).toHaveBeenCalledOnce()
      // Pressing play resumes it.
      await act(async () => { paused = false; video.dispatchEvent(new Event('play')); await vi.advanceTimersByTimeAsync(10) })
      expect(onResume).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('wraps long unspaced CJK text inside canvas bounds with a truncation mark', () => {
    const drawn: string[] = []
    const context = { measureText: (text: string) => ({ width: Array.from(text).length * 10 }), fillText: (text: string) => drawn.push(text) }
    wrapCanvasText(context as unknown as CanvasRenderingContext2D, '这是一个没有空格的很长很长的句子', 0, 0, 50, 20, 2)
    expect(drawn).toHaveLength(2)
    expect(drawn[0]).toHaveLength(5)
    expect(drawn[1]).toMatch(/…$/u)
    expect(drawn.every((line) => Array.from(line).length <= 5)).toBe(true)
  })

  it('shows a visible capability explanation when neither API exists', () => {
    render(<TranscriptPiPButton {...props} />)
    expect(screen.getByText('Picture-in-picture is unavailable in this browser.')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Picture-in-picture' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(screen.getByText('Picture-in-picture is unavailable in this browser.')).toBeInTheDocument()
  })
})
