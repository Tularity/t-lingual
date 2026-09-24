import type { Segment } from '../../api/contracts'

export type TranscriptSegment = Segment & {
  speakerId?: string
  speakerLabel?: string
  detectedLanguage?: string
  sourceRevision?: number
  translationRevision?: number
}

export const WINDOW_LIMIT = 40
export const PAGE_SIZE = 20

const translationRank = { not_requested: 0, pending: 1, failed: 2, succeeded: 3 }

export function mergeRevision(previous: TranscriptSegment, incoming: TranscriptSegment): TranscriptSegment {
  const sourceNewer = incoming.final && !previous.final || incoming.final === previous.final && (incoming.sourceRevision ?? 0) > (previous.sourceRevision ?? 0)
  const terminalResult = previous.translationStatus === 'pending' && (incoming.translationStatus === 'succeeded' || incoming.translationStatus === 'failed')
  const rejectedLateDraft = (previous.translationStatus === 'succeeded' || previous.translationStatus === 'failed') && incoming.translationStatus === 'pending'
  const translationNewer = !rejectedLateDraft && (terminalResult || (incoming.translationRevision ?? 0) > (previous.translationRevision ?? 0)
    || ((incoming.translationRevision ?? 0) === (previous.translationRevision ?? 0)
      && (translationRank[incoming.translationStatus] > translationRank[previous.translationStatus]
        || incoming.translation.length > previous.translation.length)))
  const speakerChanged = incoming.speakerId !== undefined && incoming.speakerId !== previous.speakerId
    || incoming.speakerLabel !== undefined && incoming.speakerLabel !== previous.speakerLabel
    || incoming.sourceDetection !== undefined && incoming.sourceDetection !== previous.sourceDetection
    || incoming.languageSource !== undefined && incoming.languageSource !== previous.languageSource
    || incoming.detectedLanguage !== undefined && incoming.detectedLanguage !== previous.detectedLanguage
  if (!sourceNewer && !translationNewer && !speakerChanged) return previous
  return {
    ...previous,
    ...(incoming.speakerId !== undefined ? { speakerId: incoming.speakerId } : {}),
    ...(incoming.speakerLabel !== undefined ? { speakerLabel: incoming.speakerLabel } : {}),
    ...(incoming.sourceDetection !== undefined ? { sourceDetection: incoming.sourceDetection } : {}),
    ...(incoming.translationPhase !== undefined ? { translationPhase: incoming.translationPhase } : {}),
    ...(incoming.languageSource !== undefined ? { languageSource: incoming.languageSource } : {}),
    ...(incoming.detectedLanguage !== undefined ? { detectedLanguage: incoming.detectedLanguage } : {}),
    ...(sourceNewer ? {
      id: incoming.id,
      sourceText: incoming.sourceText,
      sourceRevision: incoming.sourceRevision,
      final: incoming.final,
      startMs: incoming.startMs,
      endMs: incoming.endMs,
    } : {}),
    ...(translationNewer ? {
      translation: incoming.translation,
      translationStatus: incoming.translationStatus,
      translationRevision: incoming.translationRevision,
      translationError: incoming.translationError,
      translatorRequestId: incoming.translatorRequestId,
    } : {}),
  }
}

export function mergeWindow(current: TranscriptSegment[], incoming: TranscriptSegment[], edge: 'older' | 'newer', limit = WINDOW_LIMIT) {
  const bySequence = new Map(current.map((segment) => [segment.sequence, segment]))
  for (const segment of incoming) {
    const prior = bySequence.get(segment.sequence)
    bySequence.set(segment.sequence, prior ? mergeRevision(prior, segment) : segment)
  }
  const sorted = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence)
  const bounded = edge === 'older' ? sorted.slice(0, limit) : sorted.slice(-limit)
  return bounded.length === current.length && bounded.every((segment, index) => segment === current[index]) ? current : bounded
}

export function scrollAnchorTop(previousScrollTop: number, beforeRowTop: number, afterRowTop: number) {
  return Math.max(0, previousScrollTop + afterRowTop - beforeRowTop)
}

export function speakerTone(id?: string) {
  if (!id) return 0
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return hash % 6
}

export function speakerDisplay(segment: Pick<TranscriptSegment, 'speakerId' | 'speakerLabel'>, t?: (key:string,params?:Record<string,string|number>)=>string) {
  if (segment.speakerLabel?.trim()) return segment.speakerLabel.trim()
  const number = /^speaker_(\d{1,2})$/u.exec(segment.speakerId ?? '')?.[1]
  return number ? t ? t('Speaker {number}',{number}) : `Speaker ${number}` : segment.speakerId ? t ? t('Speaker') : 'Speaker' : ''
}
