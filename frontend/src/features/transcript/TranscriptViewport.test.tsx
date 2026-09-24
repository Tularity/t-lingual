import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Segment } from '../../api/contracts'
import { TranscriptViewport } from './TranscriptViewport'

const mocks = vi.hoisted(() => ({ segments: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { sessions: { segments: mocks.segments } } }))

function segment(sequence: number, fields: Partial<Segment> = {}): Segment {
  return { id: `s${sequence}`, sessionId: 'session', sequence, sourceText: `Phrase ${sequence}`, translation: `Translation ${sequence}`, translationStatus: 'succeeded', final: true, startMs: sequence * 1000, endMs: sequence * 1000 + 400, createdAt: '2026-01-01T00:00:00Z', ...fields }
}

const props = { sessionId: 'session', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }

describe('bounded transcript viewport', () => {
  beforeEach(() => { mocks.segments.mockReset() })

  it('holds forty DOM rows through both paging directions and retains the visible anchor', async () => {
    const tail = Array.from({ length: 40 }, (_, index) => segment(index + 61))
    mocks.segments.mockImplementation((_id: string, query: { before?: number; after?: number }) => {
      if (query.before === 61) return Promise.resolve({ items: Array.from({ length: 20 }, (_, index) => segment(index + 41)), limit: 20, nextAfter: 60, hasMore: true, hasEarlier: true })
      if (query.after === 80) return Promise.resolve({ items: Array.from({ length: 20 }, (_, index) => segment(index + 81)), limit: 20, nextAfter: 100, hasMore: false, hasLater: false })
      throw new Error('Unexpected pagination')
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const row = this.closest('[data-transcript-row]')
      if (row) {
        const index = Array.from(row.parentElement!.querySelectorAll('[data-transcript-row]')).indexOf(row)
        return { top: index * 30, bottom: index * 30 + 30, left: 0, right: 200, width: 200, height: 30, x: 0, y: index * 30, toJSON: () => ({}) }
      }
      return { top: 0, bottom: 400, left: 0, right: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) }
    })
    try {
      render(<StrictMode><TranscriptViewport {...props} segments={tail} live /></StrictMode>)
      const viewport = screen.getByRole('region', { name: 'Transcript entries' })
      expect(viewport.querySelectorAll('[data-transcript-row]')).toHaveLength(40)
      await userEvent.click(screen.getByRole('button', { name: 'Earlier phrases' }))
      await waitFor(() => expect(viewport.querySelector('[data-transcript-row="41"]')).toBeInTheDocument())
      expect(viewport.querySelectorAll('[data-transcript-row]')).toHaveLength(40)
      expect(viewport.scrollTop).toBe(600)
      await userEvent.click(screen.getByRole('button', { name: 'Newer phrases' }))
      await waitFor(() => expect(viewport.querySelector('[data-transcript-row="100"]')).toBeInTheDocument())
      expect(viewport.querySelectorAll('[data-transcript-row]')).toHaveLength(40)
      expect(mocks.segments).toHaveBeenCalledWith('session', { before: 61, limit: 20 })
      expect(mocks.segments).toHaveBeenCalledWith('session', { after: 80, limit: 20 })
    } finally { rect.mockRestore() }
  })

  it('does not pull an older reader down when live updates arrive and updates the same row in place', async () => {
    const initial = Array.from({ length: 40 }, (_, index) => segment(index + 1))
    const { rerender } = render(<StrictMode><TranscriptViewport {...props} segments={initial} live /></StrictMode>)
    const viewport = screen.getByRole('region', { name: 'Transcript entries' })
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 500 } })
    viewport.scrollTop = 300
    fireEvent.scroll(viewport)
    rerender(<StrictMode><TranscriptViewport {...props} segments={[...initial, segment(41)]} live /></StrictMode>)
    expect(viewport.querySelector('[data-transcript-row="41"]')).not.toBeInTheDocument()
    expect(screen.getByText('1 new phrase')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Newer phrases' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument()

    const updated = { ...initial[0]!, id: 'final_changed_id', sourceRevision: 2, sourceText: 'Corrected opening phrase', speakerId: 'speaker_1' }
    rerender(<StrictMode><TranscriptViewport {...props} segments={[updated, ...initial.slice(1), segment(41)]} live /></StrictMode>)
    expect(viewport.querySelectorAll('[data-transcript-row="1"]')).toHaveLength(1)
    expect(screen.getByText('Corrected opening phrase')).toBeInTheDocument()
    await userEvent.hover(screen.getByRole('button', { name: 'Phrase details at 0:01' }))
    expect(viewport.querySelector('.tv-row__speaker')).toHaveTextContent('Speaker 1')
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Speaker 1')
  })

  it('begins following when an empty prepared session becomes live, and searches through the API', async () => {
    const { rerender } = render(<StrictMode><TranscriptViewport {...props} segments={[]} live={false} sourceLanguage="auto" /></StrictMode>)
    rerender(<StrictMode><TranscriptViewport {...props} segments={[]} live sourceLanguage="auto" /></StrictMode>)
    await act(async () => Promise.resolve())
    rerender(<StrictMode><TranscriptViewport {...props} segments={[segment(1), segment(2)]} live sourceLanguage="auto" /></StrictMode>)
    expect(screen.getByText('Phrase 2')).toBeInTheDocument()
    expect(screen.queryByText('2 new phrases')).not.toBeInTheDocument()
    expect(screen.getByText('Mixed languages')).toBeInTheDocument()

    mocks.segments.mockResolvedValue({ items: [segment(17, { sourceText: 'Unique match' })], limit: 40, nextAfter: 17, hasMore: false, hasEarlier: false, hasLater: false })
    rerender(<StrictMode><TranscriptViewport {...props} segments={[]} query="Unique" /></StrictMode>)
    expect(await screen.findByText('Unique match')).toBeInTheDocument()
    expect(mocks.segments).toHaveBeenCalledWith('session', { limit: 40, search: 'Unique' })
  })

  it('returns to the current tail when recording resumes in a saved conversation', async () => {
    const items = Array.from({ length: 60 }, (_, index) => segment(index + 1))
    const { rerender } = render(<TranscriptViewport {...props} segments={items} live={false} />)
    expect(document.querySelector('[data-transcript-row="1"]')).toBeInTheDocument()
    rerender(<TranscriptViewport {...props} segments={items} live />)
    await waitFor(() => expect(document.querySelector('[data-transcript-row="60"]')).toBeInTheDocument())
    expect(document.querySelectorAll('[data-transcript-row]')).toHaveLength(40)
    expect(document.querySelector('.tv')).toHaveAttribute('data-following', 'true')
  })

  it('reconciles pending translations outside the live tail without changing the reading window', async () => {
    vi.useFakeTimers()
    try {
      const draft=segment(120,{translation:'Temporary',translationStatus:'pending',translationRevision:15})
      mocks.segments.mockResolvedValue({items:[{...draft,translation:'',translationStatus:'failed',translationRevision:0}],limit:40,nextAfter:120,hasMore:false})
      render(<TranscriptViewport {...props} segments={[draft]} />)
      expect(screen.getByText('Temporary')).toBeInTheDocument()
      await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
      expect(screen.queryByText('Temporary')).not.toBeInTheDocument()
      expect(document.querySelector('[data-transcript-row="120"]')).toBeInTheDocument()
      expect(mocks.segments).toHaveBeenCalledWith('session',{after:119,limit:40})
    } finally {vi.useRealTimers()}
  })
})
