import type { Segment } from '../../api/contracts'

export const LIVE_TAIL_LIMIT = 80

/** Snapshot revisions are replacements, never string concatenations. */
export function mergeTranscript(current: Segment[], updates: Segment[], limit = LIVE_TAIL_LIMIT) {
  const bySequence = new Map(current.map(segment => [segment.sequence, segment]))
  for (const next of updates) {
    const previous = bySequence.get(next.sequence)
    if (!previous) { bySequence.set(next.sequence, next); continue }
    const sourceStale = previous.final && !next.final || previous.final === next.final && (next.sourceRevision ?? 0) < (previous.sourceRevision ?? 0)
    const terminalResult = previous.translationStatus === 'pending' && (next.translationStatus === 'succeeded' || next.translationStatus === 'failed')
    const translationStale = !terminalResult && ((next.translationRevision ?? 0) < (previous.translationRevision ?? 0) || (previous.translationStatus === 'succeeded' || previous.translationStatus === 'failed') && next.translationStatus === 'pending')
    bySequence.set(next.sequence, {
      ...previous, ...next,
      id: sourceStale ? previous.id : next.id,
      ...(sourceStale ? { sourceText: previous.sourceText, sourceRevision: previous.sourceRevision, final: previous.final } : {}),
      ...(translationStale ? { translation: previous.translation, translationStatus: previous.translationStatus, translationRevision: previous.translationRevision, translationError: previous.translationError } : {}),
      speakerId: next.speakerId ?? previous.speakerId,
      speakerLabel: next.speakerLabel ?? previous.speakerLabel,
      detectedLanguage: next.detectedLanguage ?? previous.detectedLanguage,
      languageSource: next.languageSource ?? previous.languageSource,
    })
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit)
}

export function updateTranslation(current: Segment[], id: string, text: string, status: Segment['translationStatus'], revision?: number, error?: string, requestId?: string, metadata?: Pick<Segment,'sourceDetection'|'detectedLanguage'|'languageSource'|'translationPhase'>) {
  return current.map(segment => {
    if (segment.id !== id || (revision !== undefined && revision <= (segment.translationRevision ?? -1))) return segment
    if ((segment.translationStatus === 'succeeded' || segment.translationStatus === 'failed') && status === 'pending') return segment
    return { ...segment, ...metadata, translation: text, translationStatus: status, translationRevision: revision ?? (segment.translationRevision ?? 0) + 1, translationError: error, translatorRequestId: requestId }
  })
}
