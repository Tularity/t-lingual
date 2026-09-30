import { render, screen } from '@testing-library/react'
import type { RecognitionGap, Segment } from '../../api/contracts'
import { TranscriptViewport } from './TranscriptViewport'

vi.mock('../../api/client', () => ({ api: { sessions: { segments: vi.fn() } } }))

function segment(sequence: number): Segment {
  return { id: `s${sequence}`, sessionId: 'session', sequence, sourceText: `Phrase ${sequence}`, translation: `Translation ${sequence}`, translationStatus: 'succeeded', final: true, startMs: sequence * 1000, endMs: sequence * 1000 + 400, createdAt: '2026-01-01T00:00:00Z' }
}

function gap(fields: Partial<RecognitionGap> = {}): RecognitionGap {
  return { id: 'gap_1', sessionId: 'session', startMs: 3_000, endMs: 63_000, sequenceFrom: 4, sequenceTo: 185, state: 'pending', attempts: 0, filledSegments: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...fields }
}

const props = { sessionId: 'session', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }
const rowsIn = (viewport: HTMLElement) => Array.from(viewport.querySelectorAll('[data-transcript-row], .tv-gap')).map((node) => node.getAttribute('data-transcript-row') ?? `gap:${node.getAttribute('data-state')}`)

describe('lines recognized late, from audio recognition missed', () => {
  it('shows where the missed speech belongs, between the lines on either side of it', () => {
    render(<TranscriptViewport {...props} segments={[1, 2, 3, 186, 187].map(segment)} gaps={[gap()]} />)
    const viewport = screen.getByRole('region', { name: 'Transcript entries' })
    expect(rowsIn(viewport)).toEqual(['1', '2', '3', 'gap:pending', '186', '187'])
    expect(screen.getByRole('note')).toHaveTextContent('Speech from 0:03 to 1:03 was missed')
  })

  it('inserts each late line in its place, keeping the marker after them while recognition catches up', () => {
    const { rerender } = render(<TranscriptViewport {...props} segments={[1, 2, 3, 186, 187].map(segment)} gaps={[gap()]} live />)
    const viewport = screen.getByRole('region', { name: 'Transcript entries' })
    rerender(<TranscriptViewport {...props} segments={[1, 2, 3, 4, 5, 186, 187].map(segment)} gaps={[gap({ state: 'filling', filledSegments: 2 })]} live />)
    expect(rowsIn(viewport)).toEqual(['1', '2', '3', '4', '5', 'gap:filling', '186', '187'])
    rerender(<TranscriptViewport {...props} segments={[1, 2, 3, 4, 5, 6, 186, 187].map(segment)} gaps={[gap({ state: 'filled', filledSegments: 3 })]} live />)
    expect(rowsIn(viewport)).toEqual(['1', '2', '3', '4', '5', '6', '186', '187'])
  })

  it('says so when the missed speech could not be recognized', () => {
    render(<TranscriptViewport {...props} segments={[1, 186].map(segment)} gaps={[gap({ state: 'failed' })]} />)
    expect(screen.getByRole('note')).toHaveTextContent('couldn’t be recognized. The audio is still saved.')
  })

  it('marks a gap at the end of what has been said', () => {
    render(<TranscriptViewport {...props} segments={[1, 2, 3].map(segment)} gaps={[gap()]} live />)
    expect(rowsIn(screen.getByRole('region', { name: 'Transcript entries' }))).toEqual(['1', '2', '3', 'gap:pending'])
  })
})
