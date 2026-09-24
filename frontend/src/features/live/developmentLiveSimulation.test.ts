import { act } from '@testing-library/react'
import type { Segment, CreateSessionInput } from '../../api/contracts'
import { MockApi } from '../../api/mock'
import { scheduleDevelopmentLiveSimulation } from './developmentLiveSimulation'

async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function create(input: Partial<CreateSessionInput> = {}) {
  const api = new MockApi()
  const request = api.sessions.create({ title: 'Stream', sourceLanguage: 'auto', targetLanguage: 'fr', recognitionLanguages: ['en', 'zh-Hans'], diarization: true, ...input })
  await advance(300)
  return { api, session: await request }
}
function run(api: MockApi, sessionId: string, showPartial = true) {
  const output = { partial: '', segments: [] as Segment[], history: [] as Array<{ atMs: number; segments: Segment[] }> }
  const startedAt = Date.now()
  const timers = scheduleDevelopmentLiveSimulation({ sessionId, demoApi: api, showPartial,
    setPartial: value => { output.partial = typeof value === 'function' ? value(output.partial) : value },
    setSegments: value => { output.segments = typeof value === 'function' ? value(output.segments) : value; output.history.push({ atMs: Date.now() - startedAt, segments: output.segments.map(segment => ({ ...segment })) }) },
  })
  return { output, timers, stop: () => { timers.flush(); timers.forEach(window.clearTimeout) } }
}
describe('incremental development provider streams', () => {
  beforeEach(() => { window.sessionStorage.setItem('t-lingual:mock-auth', 'usr_demo'); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  it('translates from the first ASR partial and waits for draft drain before independently finalizing translation', async () => {
    const { api, session } = await create()
    const { output, stop } = run(api, session.id)
    await advance(200)
    const first = output.segments[0]!
    expect(first).toMatchObject({ final: false, detectedLanguage: 'en', translationStatus: 'pending', translationPhase: 'draft', sourceRevision: 1, translationRevision: 1 })
    expect(first.translation.length).toBeGreaterThan(0)
    expect(first.speakerId).toBeUndefined()
    await advance(1900)
    expect(output.segments).toHaveLength(1)
    expect(output.segments[0]?.id).toBe(first.id)
    expect(output.segments[0]?.sourceText.length).toBeGreaterThan(first.sourceText.length)
    expect(output.segments[0]?.speakerId).toBe('speaker_1')
    await advance(700)
    expect(output.segments[0]).toMatchObject({ final: true, sourceRevision: 100, translationStatus: 'pending', translationPhase: 'draft' })
    expect(output.segments[0]?.translation.length).toBeGreaterThan(first.translation.length)
    expect(output.history.filter(event => event.atMs <= 2800).some(event => event.segments[0]?.translationPhase === 'final')).toBe(false)
    await advance(400)
    const finalStart = output.segments[0]!
    expect(finalStart).toMatchObject({ final: true, translationPhase: 'final', translationStatus: 'pending', translationRevision: 100 })
    const draftCompletion = output.history.find(event => event.segments[0]?.translationRevision === 16)
    expect(draftCompletion).toBeDefined()
    expect(draftCompletion!.atMs).toBeLessThanOrEqual(output.history.find(event => event.segments[0]?.translationRevision === 100)!.atMs)
    await advance(1400)
    expect(output.segments[1]).toMatchObject({ final: false, detectedLanguage: 'zh-Hans', translationPhase: 'draft' })
    await advance(1400)
    expect(output.segments[0]).toMatchObject({ final: true, translationStatus: 'succeeded', translationPhase: 'final', translationRevision: 200 })
    expect(['欢迎大家。我们现在开始会议。', 'Bienvenue à tous. Nous allons commencer la réunion.']).toContain(output.segments[0]?.translation)
    const terminalIndex = output.history.findIndex(event => event.segments[0]?.translationStatus === 'succeeded')
    expect(terminalIndex).toBeGreaterThan(-1)
    expect(output.history.slice(terminalIndex).every(event => event.segments[0]?.translationStatus === 'succeeded')).toBe(true)
    stop()
    api.finishDevelopmentLive(session.id)
    const reading = api.sessions.segments(session.id)
    await advance(300)
    expect((await reading).items.every(segment => segment.final && segment.translationStatus === 'succeeded')).toBe(true)
  })
  it('drains the draft and final translation when stopped before the first partial', async () => {
    const { api, session } = await create()
    const { output, stop } = run(api, session.id, false)
    expect(output.history).toHaveLength(0)
    stop()
    expect(output.segments).toHaveLength(1)
    expect(output.segments[0]).toMatchObject({ final: true, translationStatus: 'succeeded', translationPhase: 'final', translationRevision: 200 })
    expect(output.history.every(event => event.segments.every(segment => segment.final))).toBe(true)
    api.finishDevelopmentLive(session.id)
    const reading = api.sessions.segments(session.id)
    await advance(300)
    expect((await reading).items[0]).toMatchObject({ final: true, translationStatus: 'succeeded' })
  })
  it('hides interim ASR when requested and resumes with a new stable sequence', async () => {
    const { api, session } = await create()
    const first = run(api, session.id, false)
    await advance(2000)
    expect(first.output.segments).toHaveLength(0)
    expect(first.output.history).toHaveLength(0)
    expect(first.output.partial).toBe('')
    await advance(800)
    expect(first.output.segments).toHaveLength(1)
    expect(first.output.segments[0]).toMatchObject({ final: true, translationStatus: 'pending', translationPhase: 'draft' })
    expect(first.output.history.every(event => event.segments.every(segment => segment.final))).toBe(true)
    first.stop()
    const resumed = run(api, session.id)
    await advance(500)
    expect(resumed.output.segments[0]?.sequence).toBe(2)
    resumed.stop(); api.finishDevelopmentLive(session.id)
  })
})
