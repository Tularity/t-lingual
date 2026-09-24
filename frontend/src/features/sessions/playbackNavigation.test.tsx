import { act, render, screen, waitFor } from '@testing-library/react'
import type { Segment, SegmentPageResponse } from '../../api/contracts'
import { TranscriptViewport } from '../transcript/TranscriptViewport'

const mocks = vi.hoisted(() => ({ segments: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { sessions: { segments: mocks.segments } } }))
function row(sequence: number): Segment {
  return { id: `s${sequence}`, sessionId: 'session', sequence, sourceText: `Phrase ${sequence}`,
    translation: `Translation ${sequence}`, translationStatus: 'succeeded', final: true,
    startMs: sequence * 1000, endMs: sequence * 1000 + 400, createdAt: '2026-09-01T00:00:00Z' }
}
function page(from: number): SegmentPageResponse {
  const items = Array.from({ length: 40 }, (_, index) => row(from + index))
  return { items, limit: 40, hasMore: false, nextAfter: from + 39, hasEarlier: from > 1, hasLater: false }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('transcript playback navigation', () => {
  beforeEach(() => {
    mocks.segments.mockReset()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lets a later explicit seek win an older in-flight window request and bounds the DOM to forty rows', async () => {
    const first = deferred<SegmentPageResponse>()
    const later = deferred<SegmentPageResponse>()
    mocks.segments.mockImplementation((_id: string, query: { atMs?: number }) => {
      if (query.atMs === 85000) return first.promise
      if (query.atMs === 125000) return later.promise
      throw new Error(`Unexpected time ${query.atMs}`)
    })
    const initial = page(1).items
    const observed: number[] = []
    const props = { sessionId: 'session', segments: initial, sourceLanguage: 'en', targetLanguage: 'fr', initialHasLater: true,
      onWindowChange: (visible: Segment[]) => observed.push(visible.length) }
    const view = render(<TranscriptViewport {...props} playback={{ timeMs: 1500, playing: false, seekToken: 0 }} />)
    const viewport = screen.getByRole('region', { name: 'Transcript entries' })
    expect(viewport.querySelectorAll('[data-transcript-row]')).toHaveLength(40)

    view.rerender(<TranscriptViewport {...props} playback={{ timeMs: 85000, playing: false, seekToken: 1 }} />)
    await waitFor(() => expect(mocks.segments).toHaveBeenCalledWith('session', { atMs: 85000, limit: 40 }))
    view.rerender(<TranscriptViewport {...props} playback={{ timeMs: 125000, playing: false, seekToken: 2 }} />)
    await waitFor(() => expect(mocks.segments).toHaveBeenCalledWith('session', { atMs: 125000, limit: 40 }))
    await act(async () => later.resolve(page(111)))
    await waitFor(() => expect(viewport.querySelector('[data-transcript-row="125"]')).toBeInTheDocument())
    expect(viewport.querySelectorAll('[data-transcript-row]')).toHaveLength(40)
    expect(viewport.querySelector('[data-transcript-row="85"]')).not.toBeInTheDocument()
    await act(async () => first.resolve(page(71)))
    expect(viewport.querySelector('[data-transcript-row="125"]')).toBeInTheDocument()
    expect(viewport.querySelector('[data-transcript-row="85"]')).not.toBeInTheDocument()
    expect(Math.max(...observed)).toBeLessThanOrEqual(40)
    view.unmount()
  })
})
