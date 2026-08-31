import type { Dispatch, SetStateAction } from 'react'
import type { Segment } from '../../api/contracts'

interface DevelopmentLiveSimulationOptions {
  sessionId: string
  setPartial: Dispatch<SetStateAction<string>>
  setSegments: Dispatch<SetStateAction<Segment[]>>
}

/** Development-only transcript activity loaded dynamically by an explicit mock build. */
export function scheduleDevelopmentLiveSimulation({ sessionId, setPartial, setSegments }: DevelopmentLiveSimulationOptions) {
  const timers: number[] = []
  const phrases = [
    ['Welcome, everyone. We will start once the final participants have joined.', '欢迎大家。等最后几位参与者加入后，我们就开始。'],
    ['The first item is our rollout schedule for the coming quarter.', '第一项议题是下个季度的发布计划。'],
    ['Please stop me at any point if something needs clarification.', '如果有任何内容需要澄清，请随时打断我。'],
  ]

  phrases.forEach(([sourceText = '', translation = ''], index) => {
    const partialTimer = window.setTimeout(() => setPartial(sourceText.slice(0, Math.floor(sourceText.length * .62))), 1_500 + index * 5_000)
    const finalTimer = window.setTimeout(() => {
      const id = `seg_dev_${crypto.randomUUID()}`
      setPartial('')
      const segment: Segment = {
        id,
        sessionId,
        sequence: index + 1,
        sourceText,
        translation: '',
        translationStatus: 'pending',
        final: true,
        startMs: index * 5_000,
        endMs: index * 5_000 + 4_100,
        createdAt: new Date().toISOString(),
      }
      setSegments((current) => [...current, segment])
      const translationTimer = window.setTimeout(() => {
        setSegments((current) => current.map((item) => item.id === id ? { ...item, translation, translationStatus: 'succeeded' } : item))
      }, 900)
      timers.push(translationTimer)
    }, 3_100 + index * 5_000)
    timers.push(partialTimer, finalTimer)
  })

  return timers
}
