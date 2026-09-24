import type { Segment } from '../../api/contracts'
import { mergeWindow, scrollAnchorTop, speakerDisplay, speakerTone, WINDOW_LIMIT } from './windowModel'

function segment(sequence: number, fields: Partial<Segment> = {}): Segment {
  return { id: `seg_${sequence}`, sessionId: 'session', sequence, sourceText: `Source ${sequence}`, translation: '', translationStatus: 'pending', final: true, startMs: sequence * 1000, endMs: sequence * 1000 + 500, createdAt: '2026-01-01T00:00:00Z', ...fields }
}

describe('transcript window model', () => {
  it('holds at most forty rows while moving backward and forward', () => {
    const tail = Array.from({ length: 40 }, (_, index) => segment(index + 61))
    const older = Array.from({ length: 20 }, (_, index) => segment(index + 41))
    const window = mergeWindow(tail, older, 'older')
    expect(window).toHaveLength(WINDOW_LIMIT)
    expect(window[0]?.sequence).toBe(41)
    expect(window.at(-1)?.sequence).toBe(80)

    const newer = mergeWindow(window, tail.slice(-20), 'newer')
    expect(newer).toHaveLength(WINDOW_LIMIT)
    expect(newer[0]?.sequence).toBe(61)
    expect(newer.at(-1)?.sequence).toBe(100)
    expect(scrollAnchorTop(240, 40, 640)).toBe(840)
  })

  it('keeps a stable sequence through ASR revisions, late speakers and translated text growth', () => {
    const draft = segment(3, { id: 'draft', final: false, sourceText: 'The fir', sourceRevision: 1, translation: '', translationRevision: 0 })
    const final = segment(3, { id: 'final', final: true, sourceText: 'The first item is ready.', sourceRevision: 2, translation: '第一', translationRevision: 1, speakerId: 'speaker_1' })
    const corrected = segment(3, { id: 'final', final: true, sourceText: 'The first item is ready.', sourceRevision: 2, translation: '第一项议题已经准备好。', translationRevision: 2, speakerId: 'speaker_1', speakerLabel: 'Speaker 1' })
    const merged = mergeWindow([draft], [final, corrected], 'newer')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'final', final: true, sourceText: 'The first item is ready.', translation: '第一项议题已经准备好。', speakerLabel: 'Speaker 1' })
    expect(mergeWindow(merged, [draft], 'newer')).toBe(merged)
    expect(speakerDisplay(final)).toBe('Speaker 1')
    expect(speakerTone('speaker_1')).toBe(speakerTone('speaker_1'))
  })

  it('takes late speaker metadata at the same speech revision', () => {
    const prior = segment(8, { sourceRevision: 3 })
    const updated = segment(8, { sourceRevision: 3, speakerId: 'speaker_2', detectedLanguage: 'zh-Hans' })
    expect(mergeWindow([prior], [updated], 'newer')[0]).toMatchObject({ speakerId: 'speaker_2', detectedLanguage: 'zh-Hans' })
  })

  it('replaces a streamed draft with a durable final and removes rejected provisional output', () => {
    const draft = segment(1, {final:false,sourceRevision:12,sourceText:'unfinished',translation:'draft text',translationStatus:'pending',translationRevision:100})
    const persisted = segment(1, {startMs:11000,endMs:13000,sourceText:'Finished sentence.',translationStatus:'failed',translation:''})
    expect(mergeWindow([draft],[persisted],'newer')[0]).toMatchObject({final:true,startMs:11000,endMs:13000,sourceText:'Finished sentence.',translation:'',translationStatus:'failed'})
  })
})
