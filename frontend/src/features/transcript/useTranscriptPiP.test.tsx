import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('stops video capture tracks when fallback PiP closes', async () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: (text: string) => ({ width: Array.from(text).length * 8 }) }
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => stream })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: vi.fn(async () => undefined) })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLVideoElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLVideoElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const view = render(<TranscriptPiPButton {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Picture-in-picture' }))
    expect(await screen.findByRole('button', { name: 'Close picture-in-picture' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close picture-in-picture' }))
    expect(stop).toHaveBeenCalledOnce()
    view.unmount()
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
