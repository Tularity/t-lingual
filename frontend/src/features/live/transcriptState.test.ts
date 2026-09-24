import { mergeTranscript, updateTranslation } from './transcriptState'
import type { Segment } from '../../api/contracts'

const phrase = (sequence = 1): Segment => ({ id: `s${sequence}`, sessionId: 'session', sequence, sourceText: 'We will meet', translation: '', translationStatus: 'pending', final: false, sourceRevision: 1, startMs: 0, endMs: 0, createdAt: '' })
describe('streamed transcript revisions', () => {
  it('replaces corrections in place and rejects stale snapshots', () => {
    const corrected = mergeTranscript([phrase()], [{ ...phrase(), sourceText: 'We will speak', sourceRevision: 3 }])
    expect(corrected).toHaveLength(1)
    expect(mergeTranscript(corrected, [phrase()])[0]?.sourceText).toBe('We will speak')
  })
  it('keeps the completed translation when stale pending data is reconciled', () => {
    const ready = updateTranslation([phrase()], 's1', '我们会面', 'succeeded', 9)
    expect(updateTranslation(ready, 's1', '我们', 'pending', 4)[0]?.translation).toBe('我们会面')
    expect(mergeTranscript(ready, [phrase()])[0]?.translation).toBe('我们会面')
  })
  it('allows a new source to arrive while the prior translation is streaming and bounds the live tail', () => {
    const current = updateTranslation([{ ...phrase(), final: true }], 's1', '我们', 'pending', 1)
    const next = mergeTranscript(current, [phrase(2)])
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ final: true, translation: '我们', translationStatus: 'pending' })
    expect(next[1]?.final).toBe(false)
    const bounded = mergeTranscript([], Array.from({ length: 1000 }, (_, i) => phrase(i + 1)))
    expect(bounded).toHaveLength(80)
    expect(bounded[0]?.sequence).toBe(921)
  })

  it('accepts persisted finals without transport revisions and retracts failed provisional text', () => {
    const draft = {...phrase(), sourceRevision: 9, translation: 'Provisional', translationRevision: 25}
    const final = {...phrase(), sourceText: 'We will meet tomorrow.', final: true, sourceRevision: undefined, translation: '', translationStatus: 'failed' as const, translationRevision: undefined}
    expect(mergeTranscript([draft], [final])[0]).toMatchObject({sourceText: 'We will meet tomorrow.', final:true, translation:'', translationStatus:'failed'})
  })
})
