import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { InterpretationSession, LiveClientDiagnostics, LiveClientMessage, LiveNoteEvent, LiveServerMessage, PresenceList, RecognitionGap, Segment, ViewerAccess, RecordingState } from '../../api/contracts'
import { dispatchAuthSessionInvalid } from '../../api/sessionInvalid'
import { loadLocalPreferences } from '../../app/preferences'
import { connectMicrophoneCapture, microphoneConstraints, toPcm16 } from './audioCapture'
import { RecordingTape } from './recordingTape'
import { errorMessage } from '../../app/utils'
import { notifyStorageChanged } from '../../app/storageEvents'
import { LIVE_TAIL_LIMIT, mergeTranscript, updateTranslation } from './transcriptState'
import { useScreenWakeLock } from './wakeLock'

export type LiveState = 'idle' | 'requesting' | 'connecting' | 'live' | 'reconnecting' | 'stopping' | 'ended' | 'error'
export function makeLiveHello(sampleRate: number, client?: LiveClientDiagnostics): LiveClientMessage { return { type: 'start', audio: { encoding: 'pcm16', sampleRate, channels: 1 }, ...(client ? { client } : {}) } }
/** A stretch the microphone gave no sound for, as the recorder is told: whether the page was in the background then. */
export interface CaptureGap { ms: number; hidden: boolean }
/**
 * How a recording rides out its connection: how much audio is kept while it is
 * down, how much is handed to the connection at once, and how long it may
 * stop taking audio before it is dropped and made again.
 */
export const liveTiming = {
  /** Audio kept while the connection is down, before the oldest is let go. */
  keepMs: 10 * 60_000,
  /** Sent audio kept in case the connection dropped before it arrived. */
  keepSentMs: 60_000,
  highWaterBytes: 256 * 1024,
  chunkBytes: 64 * 1024,
  /** A connection that takes no audio for this long is made again. */
  stallMs: 12_000,
  /** Kept audio from this much is announced before it is sent. */
  catchUpMs: 200,
  reconnectFirstMs: 400,
  reconnectMostMs: 5_000,
  /** How long a stop waits for the connection to come back and take what was kept. */
  stopGraceMs: 20_000,
  /** The microphone giving no sound for this long, on a visible page, is restarted. */
  captureStallMs: 2_500,
  /** A stretch without microphone sound this long is told to the recorder. */
  captureGapMs: 1_500,
}
/** Server answers after which the recording goes on with a new connection. */
const RETRYABLE_ERRORS = new Set(['RECORDING_STOPPED', 'RECORDING_UNAVAILABLE', 'ASR_UNAVAILABLE'])
export async function ensureAudioContextRunning(context: Pick<AudioContext, 'resume' | 'state'>) {
  await context.resume()
  if (context.state !== 'running') throw new Error('Browser audio is suspended. Interact with the page and try starting again.')
}


/** A gap's latest state replaces the one known, keeping the list in the order of the audio. */
export function mergeGap(current: RecognitionGap[], gap: RecognitionGap) {
  return [...current.filter(item => item.id !== gap.id), gap].sort((a, b) => a.startMs - b.startMs)
}

export function useLiveInterpretation(sessionId: string, guest = false) {
  const [translationConfigured, setTranslationConfigured] = useState<boolean | undefined>(undefined)
  const [access, setAccess] = useState<ViewerAccess | null>(null)
  const [recording, setRecording] = useState<RecordingState>({ active: false })
  const [presence, setPresence] = useState<PresenceList | undefined>()
  const [gaps, setGaps] = useState<RecognitionGap[]>([])
  const [watchAttempt, setWatchAttempt] = useState(0)
  const [languageBusy, setLanguageBusy] = useState(false)
  const takeoverRef = useRef(false)
  const targetRef = useRef('')
  const [session, setSession] = useState<InterpretationSession | null>(null); const [segments, setSegments] = useState<Segment[]>([]); const [partial, setPartial] = useState('')
  const [state, setState] = useState<LiveState>('idle'); const [error, setError] = useState(''); const [elapsedMs, setElapsedMs] = useState(0)
  const [paused, setPaused] = useState(false); const pausedRef = useRef(false); const demoActiveRef = useRef(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [autoStart, setAutoStart] = useState(false); const [compact, setCompact] = useState(false); const showPartialsRef = useRef(true)
  const tapeRef = useRef<RecordingTape | null>(null)
  const progressRef = useRef({ buffered: 0, at: 0 })
  const endWhenReadyRef = useRef(false)
  const connectArgsRef = useRef<{ sampleRate: number; generation: number } | null>(null)
  const [keptMs, setKeptMs] = useState(0); const [lostMs, setLostMs] = useState(0)
  const socketReadyRef = useRef(false)
  const flushRequestRef = useRef(0)
  const flushWaiterRef = useRef<{ requestId: number; resolve: (flushed: boolean) => void } | null>(null)
  const socketRef = useRef<WebSocket | null>(null); const streamRef = useRef<MediaStream | null>(null); const contextRef = useRef<AudioContext | null>(null); const workletRef = useRef<AudioWorkletNode | null>(null)
  const reconnectRef = useRef(0); const reconnectTimerRef = useRef<number | undefined>(undefined); const finishTimerRef = useRef<number | undefined>(undefined); const mockTimersRef = useRef<number[] & { flush?: () => void }>([]); const startedAtRef = useRef(0)
  const draftRef = useRef<Segment | null>(null)
  const latestSequenceRef = useRef(0)
  const generationRef = useRef(0); const sessionEpochRef = useRef(0); const intentionalSocketsRef = useRef(new WeakSet<WebSocket>()); const connectSocketRef = useRef<((sampleRate: number, generation: number) => void) | null>(null)
  // The microphone side of a recording: the nodes it feeds, when it last gave
  // sound, and what the page lived through, which each connection reports.
  const captureNodesRef = useRef<AudioNode[]>([])
  const lastFrameAtRef = useRef(0)
  const recoveringRef = useRef<Promise<void> | null>(null)
  const diagnosticsRef = useRef({ hiddenSince: 0, lastHiddenAt: 0, hiddenMs: 0, captureGapMs: 0, lastClose: undefined as LiveClientDiagnostics['lastClose'], connectedAt: 0 })
  const [captureGap, setCaptureGap] = useState<CaptureGap | null>(null)
  const [microphoneBlocked, setMicrophoneBlocked] = useState(false)

  const fetchPersistedSegments = useCallback(async (_after: number | undefined, hasMore: boolean, epoch: number) => {
    if (!hasMore) return
    const requestTarget = targetRef.current
    const page = await api.sessions.segments(sessionId, { tail: true, limit: LIVE_TAIL_LIMIT })
    if (sessionEpochRef.current !== epoch || requestTarget !== targetRef.current) return
    latestSequenceRef.current = Math.max(latestSequenceRef.current, page.items.at(-1)?.sequence ?? 0)
    setSegments(current => mergeTranscript(current, page.items))
    setElapsedMs(current => Math.max(current, page.items.at(-1)?.endMs ?? 0))
  }, [sessionId])
  const reconcileSegments = useCallback(async () => {
    const epoch = sessionEpochRef.current
    try {
      await fetchPersistedSegments(undefined, true, epoch)
    } catch {
      if (sessionEpochRef.current === epoch) {
        setError('Some persisted transcript lines could not be reconciled. Open the transcript again to retry.')
      }
    }
  }, [fetchPersistedSegments])
  useEffect(() => {
    let active = true
    const epoch = sessionEpochRef.current + 1
    sessionEpochRef.current = epoch
    Promise.all([api.sessions.get(sessionId), guest ? Promise.resolve(null) : api.settings.get().catch(() => null)]).then(([value, preferences]) => {
      if (active && sessionEpochRef.current === epoch) {
        setTranslationConfigured(value.translationConfigured); setAccess(value.access ?? null); setRecording(value.recording ?? { active: false }); setPresence(value.presence); targetRef.current=value.access?.targetLanguage ?? value.session.targetLanguage; setSession(value.session); setSegments(mergeTranscript([], value.segments)); latestSequenceRef.current = value.segments.at(-1)?.sequence ?? 0; draftRef.current = null
        setElapsedMs(value.segments.at(-1)?.endMs ?? 0)
        if (value.session.archivedAt || value.session.status === 'completed') setState('ended')
        else if (value.session.status === 'failed') {
          setError('The previous recording was interrupted. Your transcript is saved, and you can continue recording.')
          setState('error')
        }
        if (preferences) { setAutoStart(preferences.autoStartMicrophone); setCompact(preferences.compactTranscriptLayout); showPartialsRef.current = preferences.showPartialTranscripts }
        if (value.segmentPage.hasMore) {
          void fetchPersistedSegments(value.segmentPage.nextAfter, true, epoch).catch(() => {
            if (sessionEpochRef.current === epoch) setError('Some earlier transcript lines could not be loaded. Open the transcript again to retry.')
          })
        }
      }
    }).catch((caught) => { if (active && sessionEpochRef.current === epoch) { setError(errorMessage(caught)); setState('error') } })
    return () => {
      active = false
      if (sessionEpochRef.current === epoch) sessionEpochRef.current += 1
    }
  }, [fetchPersistedSegments, guest, loadAttempt, sessionId])
  useEffect(() => {
    if (!session?.id || !['idle', 'ended', 'error'].includes(state)) return
    let active = true
    const refreshMetadata = () => { const target=targetRef.current; void api.sessions.get(sessionId).then(value => { if (active && target===targetRef.current) {setSession({...value.session,targetLanguage:target});setTranslationConfigured(value.translationConfigured);setAccess(value.access ?? null);setRecording(value.recording ?? {active:false})} }).catch(() => undefined) }
    const interval = window.setInterval(refreshMetadata, 60_000)
    window.addEventListener('focus', refreshMetadata)
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refreshMetadata) }
  }, [session?.id, sessionId, state])
  const unarchive = useCallback(async () => {
    setArchiveBusy(true); setError('')
    try { const updated = await api.sessions.unarchive(sessionId); setSession({...updated,targetLanguage:targetRef.current || updated.targetLanguage}); setState('idle') }
    catch (caught) { setError(errorMessage(caught)) }
    finally { setArchiveBusy(false) }
  }, [sessionId])
  const retryLoad = useCallback(() => {
    setSession(null); setSegments([]); setPartial(''); setError(''); setState('idle')
    setLoadAttempt((current) => current + 1)
  }, [])
  useEffect(() => { if (state !== 'live' && state !== 'reconnecting') return; const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1_000); return () => window.clearInterval(timer) }, [state])

  // While recording, the screen is kept on: a phone that locks puts the page,
  // and its microphone, in the background.
  useScreenWakeLock(state === 'requesting' || state === 'connecting' || state === 'live' || state === 'reconnecting' || state === 'stopping')
  const disconnectCaptureNodes = useCallback(() => {
    for (const node of captureNodesRef.current) { try { node.disconnect() } catch { /* Already disconnected. */ } }
    captureNodesRef.current = []
  }, [])
  const stopCapture = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    disconnectCaptureNodes()
    workletRef.current?.disconnect(); workletRef.current = null
    void contextRef.current?.close(); contextRef.current = null
  }, [disconnectCaptureNodes])
  const stopMedia = useCallback(() => {
    flushWaiterRef.current?.resolve(false); flushWaiterRef.current = null
    tapeRef.current = null; endWhenReadyRef.current = false
    socketReadyRef.current = false
    recoveringRef.current = null
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    disconnectCaptureNodes()
    workletRef.current?.disconnect(); workletRef.current = null
    void contextRef.current?.close(); contextRef.current = null
    try { mockTimersRef.current.flush?.() } catch { /* Logout may already have finalized the demo and removed its identity. */ }
    mockTimersRef.current.forEach(window.clearTimeout); mockTimersRef.current = []
    if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current)
    if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current)
    reconnectTimerRef.current = undefined; finishTimerRef.current = undefined
  }, [disconnectCaptureNodes])
  const togglePause = useCallback(() => {
    if (state !== 'live') return
    if (pausedRef.current) {
      if (__TLINGUAL_DEVELOPMENT_MOCK__) {
        void import('./developmentLiveSimulation').then(({ scheduleDevelopmentLiveSimulation }) => {
          if (!demoActiveRef.current || !pausedRef.current) return
          mockTimersRef.current = scheduleDevelopmentLiveSimulation({ sessionId, setPartial, setSegments, showPartial: showPartialsRef.current })
          pausedRef.current = false; setPaused(false)
        }).catch((caught: unknown) => { setError(errorMessage(caught)); setState('error') })
      } else { pausedRef.current = false; setPaused(false) }
    } else {
      pausedRef.current = true; setPaused(true); setPartial('')
      if (__TLINGUAL_DEVELOPMENT_MOCK__) {
        mockTimersRef.current.flush?.()
        mockTimersRef.current.forEach(window.clearTimeout); mockTimersRef.current = []
        const demoApi = api as typeof api & { settleDevelopmentPending(id: string): Segment[] }
        const settled = demoApi.settleDevelopmentPending(sessionId)
        setSegments((current) => current.map((segment) => settled.find((item) => item.id === segment.id) ?? segment))
      }
    }
  }, [sessionId, state])
  // A connection given up for good says so, and the server ends the
  // recording; one merely replaced lets the server wait for the next.
  const retireSocket = useCallback((socket = socketRef.current, final = true) => {
    if (!socket) return
    if (socketRef.current === socket) { socketRef.current = null; socketReadyRef.current = false }
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
    if (final && socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify({ type: 'end' } satisfies LiveClientMessage)) } catch { /* Closing anyway. */ } }
    if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client cleanup')
  }, [])
  /** Tells the server something the recording browser noticed, when it can hear it. */
  const sendNote = useCallback((event: LiveNoteEvent, ms?: number) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN || !socketReadyRef.current) return
    try { socket.send(JSON.stringify({ type: 'note', event, ...(ms !== undefined ? { ms: Math.round(ms) } : {}) } satisfies LiveClientMessage)) } catch { /* A closing socket reports itself through onclose. */ }
  }, [])
  // A microphone the system took away, as a phone does for a call or while the
  // page is in the background, is taken back without ending the recording.
  const recoverCaptureRef = useRef<() => Promise<void>>(async () => undefined)
  const attachStream = useCallback((stream: MediaStream, generation: number) => {
    const context = contextRef.current, worklet = workletRef.current
    if (!context || !worklet) return
    disconnectCaptureNodes()
    const nodes = connectMicrophoneCapture(context, stream, worklet, loadLocalPreferences())
    captureNodesRef.current = [nodes.source, nodes.limiter]
    stream.getTracks().forEach(track => track.addEventListener('ended', () => {
      if (generationRef.current !== generation || streamRef.current !== stream) return
      void recoverCaptureRef.current()
    }, { once: true }))
  }, [disconnectCaptureNodes])
  const recoverCapture = useCallback(() => {
    if (recoveringRef.current) return recoveringRef.current
    const generation = generationRef.current
    const blocked = () => { if (generationRef.current !== generation) return; setMicrophoneBlocked(true); sendNote('microphone_blocked') }
    const run = (async () => {
      const context = contextRef.current
      if (!context || !workletRef.current || !tapeRef.current) return
      if (context.state !== 'running') { try { await context.resume() } catch { /* A browser that wants a tap first is asked below. */ } }
      if (generationRef.current !== generation || contextRef.current !== context) return
      const stream = streamRef.current
      const sounding = !!stream?.active && stream.getTracks().every(track => track.readyState !== 'ended')
      if (!sounding) {
        let fresh: MediaStream
        try { fresh = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(loadLocalPreferences()) }) }
        catch { blocked(); return }
        if (generationRef.current !== generation || contextRef.current !== context) { fresh.getTracks().forEach(track => track.stop()); return }
        stream?.getTracks().forEach(track => track.stop())
        streamRef.current = fresh
        attachStream(fresh, generation)
        sendNote('microphone_restarted')
      }
      if (context.state !== 'running') { blocked(); return }
      setMicrophoneBlocked(false)
    })().finally(() => { if (recoveringRef.current === run) recoveringRef.current = null })
    recoveringRef.current = run
    return run
  }, [attachStream, sendNote])
  useEffect(() => { recoverCaptureRef.current = recoverCapture }, [recoverCapture])

  const handleMessage = useCallback((message: LiveServerMessage) => {
    if (message.type === 'snapshot') {
      const target = message.access?.targetLanguage ?? message.session.targetLanguage
      if (targetRef.current && target !== targetRef.current) return
      setSession(current => ({ ...current, ...message.session, targetLanguage: target, isOwner: message.access?.isOwner, permission: message.access?.permission })); setAccess(message.access ?? null); setRecording(message.recording ?? { active: false }); if (message.presence) setPresence(message.presence); setGaps(message.recognitionGaps ?? []); setSegments(current => mergeTranscript(current, message.segments)); latestSequenceRef.current = Math.max(latestSequenceRef.current, message.segments.at(-1)?.sequence ?? 0); return
    }
    if (message.type === 'recording') { setRecording(message.recording); return }
    if (message.type === 'presence') { setPresence(message.presence); return }
    if (message.type === 'gap') { setGaps(current => mergeGap(current, message.gap)); return }
    if (message.type === 'recognition') {
      // What was being said when recognition dropped is recognized again from the saved audio.
      if (message.state === 'interrupted' && draftRef.current) { const draft = draftRef.current; draftRef.current = null; setPartial(''); setSegments(current => current.filter(segment => segment.id !== draft.id)) }
      setRecording(current => ({ ...current, recognitionPaused: message.state === 'interrupted', recognitionCatchingUp: message.state === 'interrupted' && message.reason === 'catching_up' }))
      return
    }
    if (message.type === 'ready') { if (message.offsetMs !== undefined) { startedAtRef.current = Date.now() - message.offsetMs; setElapsedMs(message.offsetMs) } draftRef.current = null; reconnectRef.current = 0; setState('live'); setError(''); void reconcileSegments(); return }
    if (message.type === 'partial') {
      if (!showPartialsRef.current) return
      const previous = draftRef.current
      const revision = message.revision ?? message.upstreamSequence
      if (previous && revision <= (previous.sourceRevision ?? -1)) return
      const sequence = message.sequence ?? previous?.sequence ?? latestSequenceRef.current + 1
      const draft: Segment = {
        id: message.segmentId ?? previous?.id ?? `draft_${sessionId}_${sequence}`, sessionId, sequence,
        sourceText: message.text, sourceRevision: revision, translation: '', translationStatus: 'not_requested', final: false,
        startMs: message.startMs ?? previous?.startMs ?? Math.max(0, startedAtRef.current ? Date.now() - startedAtRef.current : 0), endMs: 0,
        createdAt: previous?.createdAt ?? new Date().toISOString(), detectedLanguage: message.language,
        speakerId: message.speakerId ?? previous?.speakerId,
      }
      draftRef.current = draft; setPartial(message.text)
      setSegments(current => mergeTranscript(current, [draft]))
      return
    }
    if (message.type === 'final') {
      draftRef.current = null; setPartial('')
      latestSequenceRef.current = Math.max(latestSequenceRef.current, message.segment.sequence)
      const segment = { ...message.segment, detectedLanguage: message.detectedLanguage ?? message.segment.detectedLanguage }
      setSegments(current => mergeTranscript(current, [segment]))
      return
    }
    if (message.type === 'translation') {
      if ('targetLanguage' in message && message.targetLanguage !== targetRef.current) return
      setSegments(current => updateTranslation(current, message.segmentId, message.translation, message.status, message.revision, message.error, message.requestId, {translationPhase:message.phase,...(message.resolvedSourceLanguage?{detectedLanguage:message.resolvedSourceLanguage,languageSource:'translator' as const,sourceDetection:message.sourceDetection}:{})}))
      return
    }
    if (message.type === 'speaker') {
      setSegments(current => current.map(segment => segment.id === message.segmentId ? { ...segment, speakerId: message.speakerId, speakerLabel: message.speakerLabel } : segment))
      return
    }
    if (message.type === 'source_text') {
      setSegments(current => current.map(segment => segment.id === message.segmentId ? { ...segment, sourceText: message.sourceText } : segment))
      return
    }
    if (message.type === 'provider_error') { setError(`${message.provider === 'asr' ? 'Recognition' : 'Translation'} provider reported ${message.code}.`); return }
    if (message.type === 'stopped') { setSession((current) => current ? { ...current, status: message.status } : current); if (message.status === 'failed') setError('The live session ended unexpectedly. Your received transcript is still safe.'); else setError(''); setState(message.status === 'failed' ? 'error' : 'ended'); void reconcileSegments(); return }
    if (message.type === 'error') {
      if (message.code === 'AUTH_REVOKED') dispatchAuthSessionInvalid({ reason: 'expired', message: message.message })
      setError(message.message); setState('error')
    }
  }, [reconcileSegments, sessionId])

  // Hands kept audio to the connection while it takes it; a connection that
  // has stopped taking any for a while is dropped and made again.
  const pump = useCallback((socket: WebSocket | null = socketRef.current, everything = false) => {
    const tape = tapeRef.current
    if (!tape || !socket || socket.readyState !== WebSocket.OPEN || !socketReadyRef.current) return
    while (everything || socket.bufferedAmount < liveTiming.highWaterBytes) {
      const next = tape.next(liveTiming.chunkBytes)
      if (!next) break
      socket.send(next); tape.markSent(next.byteLength)
    }
    const now = Date.now(); const watch = progressRef.current
    if (socket.bufferedAmount < liveTiming.highWaterBytes || socket.bufferedAmount < watch.buffered) watch.at = now
    watch.buffered = socket.bufferedAmount
    if (now - watch.at > liveTiming.stallMs) socket.close(4000, 'connection stalled')
  }, [])
  const finishEnd = useCallback((socket: WebSocket) => {
    endWhenReadyRef.current = false
    pump(socket, true)
    intentionalSocketsRef.current.add(socket)
    socket.send(JSON.stringify({ type: 'end' } satisfies LiveClientMessage))
    if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current)
    const generation = generationRef.current
    finishTimerRef.current = window.setTimeout(() => { if (generationRef.current !== generation) return; if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client end timeout'); setSession((current) => current ? { ...current, status: 'completed' } : current); setState((current) => current === 'stopping' ? 'ended' : current); tapeRef.current = null; void reconcileSegments() }, 4_000)
  }, [pump, reconcileSegments])
  const scheduleReconnect = useCallback((sampleRate: number, generation: number) => {
    reconnectRef.current += 1
    const attempt = reconnectRef.current
    setState(endWhenReadyRef.current ? 'stopping' : 'reconnecting')
    // Someone else recording now is not a dropped connection: stop trying.
    if (attempt % 3 === 0 && !endWhenReadyRef.current) {
      void api.sessions.get(sessionId).then(fresh => {
        if (generationRef.current !== generation || !fresh.recording?.active || fresh.recording.isMine) return
        setRecording(fresh.recording)
        setError(`${fresh.recording.holderName || 'Another viewer'} is recording now. Audio kept here could not be sent.`)
        setState('error')
      }).catch(() => undefined)
    }
    const delay = endWhenReadyRef.current ? 0 : Math.min(liveTiming.reconnectMostMs, liveTiming.reconnectFirstMs * 2 ** Math.min(6, attempt - 1)) * (0.8 + Math.random() * 0.4)
    if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined
      // Whatever the microphone is doing, what was kept still has to reach the server.
      if (generationRef.current === generation && tapeRef.current) connectSocketRef.current?.(sampleRate, generation)
    }, delay)
  }, [sessionId])
  const connectSocket = useCallback((sampleRate: number, generation: number) => {
    if (generationRef.current !== generation) return
    retireSocket(socketRef.current, false)
    socketReadyRef.current = false
    connectArgsRef.current = { sampleRate, generation }
    setState(endWhenReadyRef.current ? 'stopping' : reconnectRef.current ? 'reconnecting' : 'connecting')
    // Coming back after a dropped connection goes on with this browser's own recording.
    const resume = Boolean(tapeRef.current?.anchored) || reconnectRef.current > 0
    const socket = new WebSocket(api.liveSocketUrl(sessionId, takeoverRef.current, resume && !takeoverRef.current)); takeoverRef.current = false; socket.binaryType = 'arraybuffer'; socketRef.current = socket
    let terminal = false
    const isCurrent = () => generationRef.current === generation && socketRef.current === socket
    socket.onopen = () => {
      if (!isCurrent() || intentionalSocketsRef.current.has(socket)) { socket.close(1000, 'stale connection'); return }
      const diagnostics = diagnosticsRef.current
      const tape = tapeRef.current
      socket.send(JSON.stringify(makeLiveHello(sampleRate, {
        reason: resume ? 'reconnect' : 'start', attempt: reconnectRef.current,
        ...(diagnostics.lastClose ? { lastClose: diagnostics.lastClose } : {}),
        hiddenMs: Math.round(diagnostics.hiddenMs + (diagnostics.hiddenSince ? Date.now() - diagnostics.hiddenSince : 0)),
        captureGapMs: Math.round(diagnostics.captureGapMs), lostMs: Math.round(tape?.lostMs ?? 0), keptMs: Math.round(tape?.pendingMs ?? 0),
        audioState: contextRef.current?.state ?? 'none', visible: document.visibilityState === 'visible',
      })))
    }
    socket.onmessage = (event) => {
      if (!isCurrent() || typeof event.data !== 'string') return
      try {
        const message = JSON.parse(event.data) as LiveServerMessage
        // The server could not go on with this connection; the recording goes on with another.
        if (message.type === 'error' && RETRYABLE_ERRORS.has(message.code) && tapeRef.current?.anchored) {
          diagnosticsRef.current.lastClose = { code: 0, reason: `server ${message.code}`, afterMs: Date.now() - diagnosticsRef.current.connectedAt }
          retireSocket(socket, false); scheduleReconnect(sampleRate, generation); return
        }
        terminal = message.type === 'stopped' || message.type === 'error'
        handleMessage(message)
        if (message.type === 'ready') {
          socketReadyRef.current = true
          diagnosticsRef.current.connectedAt = Date.now()
          // A page that went to the background before this connection was ready says so now.
          if (document.visibilityState === 'hidden') sendNote('hidden')
          const tape = tapeRef.current
          if (tape) {
            // Sending goes on from where the saved audio ends; what was kept is announced first.
            const offsetMs = message.offsetMs ?? 0
            const kept = tape.anchor(offsetMs)
            if (kept >= liveTiming.catchUpMs) socket.send(JSON.stringify({ type: 'catch_up', ms: Math.ceil(kept) } satisfies LiveClientMessage))
            startedAtRef.current = Date.now() - offsetMs - kept
            setLostMs(tape.lostMs); setKeptMs(0)
          }
          progressRef.current = { buffered: 0, at: Date.now() }
          pump(socket)
          if (endWhenReadyRef.current) { setState('stopping'); finishEnd(socket) }
        }
        if (terminal) { stopMedia(); retireSocket(socket) }
      } catch {
        terminal = true
        setError('The live service sent an unreadable message.')
        setState('error')
        stopMedia(); retireSocket(socket)
      }
    }
    socket.onerror = () => { if (isCurrent() && !tapeRef.current?.anchored) setError('The live connection was interrupted.') }
    socket.onclose = (event) => {
      if (!isCurrent()) return
      socketRef.current = null
      socketReadyRef.current = false
      const diagnostics = diagnosticsRef.current
      diagnostics.lastClose = { code: event.code, reason: event.reason.slice(0, 120), afterMs: diagnostics.connectedAt ? Date.now() - diagnostics.connectedAt : 0 }
      if (terminal) return
      if (intentionalSocketsRef.current.has(socket)) { stopMedia(); setSession((current) => current ? { ...current, status: 'completed' } : current); setState('ended'); void reconcileSegments(); return }
      // A microphone that stopped with the connection, as on a phone that put
      // the page away, is taken back while the connection is made again.
      if (!streamRef.current?.active && !endWhenReadyRef.current) void recoverCapture()
      // A dropped connection never ends the recording: audio is kept, and sent once it is back.
      scheduleReconnect(sampleRate, generation)
    }
  }, [finishEnd, handleMessage, pump, reconcileSegments, recoverCapture, retireSocket, scheduleReconnect, sendNote, sessionId, stopMedia])
  // Back online: try again at once rather than waiting out the backoff.
  useEffect(() => {
    const online = () => {
      const args = connectArgsRef.current
      if (!args || reconnectTimerRef.current === undefined || socketRef.current) return
      window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = undefined
      connectSocketRef.current?.(args.sampleRate, args.generation)
    }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [])
  // The page going to the background is told to the server, which then waits
  // longer for audio; coming back takes the microphone back and makes a lost
  // connection again at once.
  useEffect(() => {
    const changed = () => {
      const diagnostics = diagnosticsRef.current
      const now = Date.now()
      if (document.visibilityState === 'hidden') {
        if (!diagnostics.hiddenSince) { diagnostics.hiddenSince = now; diagnostics.lastHiddenAt = now }
        sendNote('hidden')
        return
      }
      const hiddenFor = diagnostics.hiddenSince ? now - diagnostics.hiddenSince : 0
      diagnostics.hiddenMs += hiddenFor; diagnostics.hiddenSince = 0
      if (!tapeRef.current) return
      sendNote('visible', hiddenFor)
      void recoverCapture()
      const args = connectArgsRef.current
      if (args && reconnectTimerRef.current !== undefined && !socketRef.current) {
        window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = undefined
        connectSocketRef.current?.(args.sampleRate, args.generation)
      }
    }
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('pageshow', changed)
    return () => { document.removeEventListener('visibilitychange', changed); window.removeEventListener('pageshow', changed) }
  }, [recoverCapture, sendNote])
  // A microphone gone silent on a visible page is taken back at once.
  useEffect(() => {
    if (state !== 'live' && state !== 'reconnecting') return
    const timer = window.setInterval(() => {
      const last = lastFrameAtRef.current
      if (last && Date.now() - last > liveTiming.captureStallMs && document.visibilityState === 'visible') void recoverCapture()
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [recoverCapture, state])
  // While the connection is down, how much audio is kept is shown.
  useEffect(() => {
    if (state !== 'reconnecting' && state !== 'stopping') return
    const update = () => { const tape = tapeRef.current; setKeptMs(tape?.pendingMs ?? 0); setLostMs(tape?.lostMs ?? 0) }
    const first = window.setTimeout(update, 0)
    const timer = window.setInterval(update, 1_000)
    return () => { window.clearTimeout(first); window.clearInterval(timer) }
  }, [state])
  useEffect(() => {
    connectSocketRef.current = connectSocket
    return () => { if (connectSocketRef.current === connectSocket) connectSocketRef.current = null }
  }, [connectSocket])

  const start = useCallback(async (takeover = false) => {
    if (access?.permission !== 'record' && !__TLINGUAL_DEVELOPMENT_MOCK__) return
    takeoverRef.current = takeover
    if (!session || session.archivedAt || ['requesting', 'connecting', 'live', 'reconnecting', 'stopping'].includes(state)) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    retireSocket(); stopMedia(); pausedRef.current = false; setPaused(false)
    setState('requesting'); setError(''); reconnectRef.current = 0; endWhenReadyRef.current = false; setLostMs(0)
    diagnosticsRef.current = { hiddenSince: document.visibilityState === 'hidden' ? Date.now() : 0, lastHiddenAt: 0, hiddenMs: 0, captureGapMs: 0, lastClose: undefined, connectedAt: 0 }
    lastFrameAtRef.current = 0; setCaptureGap(null); setMicrophoneBlocked(false)
    try {
      const fresh = await api.sessions.get(sessionId)
      if (generationRef.current !== generation) return
      setSession(fresh.session)
      if (fresh.access?.permission !== 'record' && !__TLINGUAL_DEVELOPMENT_MOCK__) throw new Error('You have read-only access to this session.')
      setAccess(fresh.access ?? null); setRecording(fresh.recording ?? {active:false})
      if (fresh.recording?.active && !takeover) throw new Error(`${fresh.recording.holderName || 'Another viewer'} is already recording.`)
      if (fresh.session.archivedAt) { setState('ended'); return }
      const tail = fresh.segmentPage.hasMore ? (await api.sessions.segments(sessionId, { tail: true, limit: LIVE_TAIL_LIMIT })).items : fresh.segments
      if (generationRef.current !== generation) return
      setSegments(current => mergeTranscript(current.filter(segment => segment.final), tail))
      latestSequenceRef.current = Math.max(latestSequenceRef.current, tail.at(-1)?.sequence ?? 0)
      draftRef.current = null; setPartial('')
      const offset = Math.max(0, ...tail.map(segment => segment.endMs))
      startedAtRef.current = Date.now() - offset; setElapsedMs(offset)
      if (__TLINGUAL_DEVELOPMENT_MOCK__) {
        const { scheduleDevelopmentLiveSimulation } = await import('./developmentLiveSimulation')
        if (generationRef.current !== generation) return
        mockTimersRef.current = scheduleDevelopmentLiveSimulation({ sessionId, setPartial, setSegments, showPartial: showPartialsRef.current })
        demoActiveRef.current = true
        setSession((current) => current ? { ...current, status: 'live', startedAt: current.startedAt ?? new Date().toISOString(), endedAt: null } : current)
        setState('live')
        return
      }
      const preferences = loadLocalPreferences()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(preferences) })
      if (generationRef.current !== generation) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      // The context, rather than a requested device constraint, determines the
      // actual PCM sample rate announced to our same-origin recorder.
      const context = new AudioContext()
      contextRef.current = context
      await context.audioWorklet.addModule('/pcm-worklet.js?v=2')
      if (generationRef.current !== generation) {
        if (contextRef.current === context) contextRef.current = null
        if (streamRef.current === stream) streamRef.current = null
        stream.getTracks().forEach(track => track.stop()); void context.close()
        return
      }
      const worklet = new AudioWorkletNode(context, 't-lingual-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      // Kept and sent as 16-bit samples.
      const bytesPerMs = context.sampleRate * 2 / 1000
      const tape = new RecordingTape(bytesPerMs, Math.round(bytesPerMs * liveTiming.keepMs), Math.round(bytesPerMs * liveTiming.keepSentMs), 2)
      tapeRef.current = tape
      workletRef.current = worklet
      const failCapture = (caught: unknown) => {
        if (generationRef.current !== generation || workletRef.current !== worklet) return
        setError(errorMessage(caught)); setState('error')
        retireSocket(); stopMedia()
      }
      // Install the handler before connecting the node; otherwise the first
      // render quanta can be lost while the AudioContext resumes.
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer | { type: 'flushed'; requestId: number }>) => {
        const data = event.data
        if (!(data instanceof ArrayBuffer)) {
          if (data?.type === 'flushed' && flushWaiterRef.current?.requestId === data.requestId) {
            flushWaiterRef.current.resolve(true); flushWaiterRef.current = null
          }
          return
        }
        if (generationRef.current !== generation || workletRef.current !== worklet || tapeRef.current !== tape) return
        // Sound coming back after a stretch without it: the recorder and the server are told.
        const now = Date.now(), last = lastFrameAtRef.current
        lastFrameAtRef.current = now
        if (last && now - last > liveTiming.captureGapMs) {
          const diagnostics = diagnosticsRef.current
          const hidden = document.visibilityState === 'hidden' || diagnostics.lastHiddenAt >= last - 1_000
          diagnostics.captureGapMs += now - last
          setCaptureGap({ ms: now - last, hidden })
          sendNote('capture_gap', now - last)
        }
        tape.push(pausedRef.current ? new ArrayBuffer(data.byteLength / 2) : toPcm16(data))
        try { pump() } catch (caught) { failCapture(caught) }
      }
      attachStream(stream, generation)
      const silent = context.createGain(); silent.gain.value = 0
      worklet.connect(silent); silent.connect(context.destination)
      await ensureAudioContextRunning(context)
      if (generationRef.current !== generation) {
        if (workletRef.current === worklet) workletRef.current = null
        if (contextRef.current === context) contextRef.current = null
        if (streamRef.current === stream) streamRef.current = null
        worklet.disconnect(); stream.getTracks().forEach(track => track.stop()); void context.close()
        return
      }
      connectSocket(context.sampleRate, generation)
    } catch (caught) { if (generationRef.current !== generation) return; stopMedia(); retireSocket(); setState('error'); setError(caught instanceof DOMException && caught.name === 'NotAllowedError' ? 'Microphone access was not granted. Allow access in your browser and try again.' : errorMessage(caught)) }
  }, [access?.permission, attachStream, connectSocket, pump, retireSocket, sendNote, session, sessionId, state, stopMedia])
  const flushWorkletTail = useCallback(async () => {
    const worklet = workletRef.current
    if (!worklet) return true
    return await new Promise<boolean>(resolve => {
      const requestId = ++flushRequestRef.current
      const timeout = window.setTimeout(() => {
        if (flushWaiterRef.current?.requestId === requestId) flushWaiterRef.current = null
        resolve(false)
      }, 400)
      const finish = (flushed: boolean) => { window.clearTimeout(timeout); resolve(flushed) }
      flushWaiterRef.current = { requestId, resolve: finish }
      try { worklet.port.postMessage({ type: 'flush', requestId }) }
      catch { flushWaiterRef.current = null; finish(false) }
    })
  }, [])
  // What the server saved decides how an unconfirmed stop ended.
  const confirmPersisted = useCallback(async (generation: number, unsavedMs: number) => {
    const epoch = sessionEpochRef.current
    setState('error')
    setError('The connection ended before the stop request reached the server. Checking the persisted session status…')
    try {
      const persisted = await api.sessions.get(sessionId)
      if (generationRef.current !== generation || sessionEpochRef.current !== epoch) return
      setSession(persisted.session)
      setSegments((current) => mergeTranscript(current, persisted.segments))
      if (persisted.session.status === 'completed') {
        setError(unsavedMs ? 'Audio captured while reconnecting could not be saved. Start a new recording to continue.' : '')
        setState(unsavedMs ? 'error' : 'ended')
      } else if (persisted.session.status === 'failed') {
        setError(unsavedMs ? 'The connection didn’t come back in time, so audio kept while it was down couldn’t be saved. The rest of the recording is saved.' : 'The interrupted connection was recorded by the server. Your persisted transcript is still available.')
        setState('error')
      } else if (persisted.session.status === 'created') {
        setError('')
        setState('idle')
      } else {
        setError('The server still reports this session as live. Reconnect before trying to end it again.')
        setState('error')
      }
    } catch (caught) {
      if (generationRef.current === generation && sessionEpochRef.current === epoch) {
        setError(`The stop request could not be confirmed. ${errorMessage(caught)}`)
        setState('error')
      }
    }
    if (generationRef.current === generation && sessionEpochRef.current === epoch) void reconcileSegments()
  }, [reconcileSegments, sessionId])
  // A stop that waited for the connection in vain ends with what the server has.
  const giveUp = useCallback(async (unsavedMs: number) => {
    const generation = generationRef.current
    endWhenReadyRef.current = false
    retireSocket(); stopMedia()
    setKeptMs(unsavedMs)
    await confirmPersisted(generation, unsavedMs)
  }, [confirmPersisted, retireSocket, stopMedia])
  const stop = useCallback(async () => {
    if (!['live', 'reconnecting', 'connecting'].includes(state)) return
    const generation = generationRef.current
    setState('stopping')
    const endingSocket = socketRef.current
    if (workletRef.current) {
      const flushed = await flushWorkletTail()
      if (generationRef.current !== generation) return
      if (!flushed) {
        setError('The final microphone samples could not be saved. The recording was interrupted.')
        setState('error'); retireSocket(endingSocket); stopMedia(); return
      }
    }
    const tape = tapeRef.current
    const unsavedFrames = tape ? tape.pendingMs : 0
    const sentEnd = endingSocket?.readyState === WebSocket.OPEN && socketReadyRef.current
    if (sentEnd) { pump(endingSocket, true); intentionalSocketsRef.current.add(endingSocket); endingSocket.send(JSON.stringify({ type: 'end' } satisfies LiveClientMessage)) }
    else if (state === 'reconnecting' && tape?.anchored && !__TLINGUAL_DEVELOPMENT_MOCK__) {
      // Stopped while the connection is down: capture stops now, and what was
      // kept is sent once the connection is back, then the recording ends.
      endWhenReadyRef.current = true
      stopCapture()
      const args = connectArgsRef.current
      if (args && !socketRef.current) { if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = undefined; connectSocketRef.current?.(args.sampleRate, args.generation) }
      finishTimerRef.current = window.setTimeout(() => { if (generationRef.current === generation && endWhenReadyRef.current) void giveUp(Math.round(tapeRef.current?.pendingMs ?? 0)) }, liveTiming.stopGraceMs)
      return
    }
    stopMedia()
    if (__TLINGUAL_DEVELOPMENT_MOCK__) {
      try {
        const { MockApi } = await import('../../api/mock')
        if (!(api instanceof MockApi)) throw new Error('Development demo API is unavailable')
        const completed = api.finishDevelopmentLive(sessionId)
        demoActiveRef.current = false
        if (generationRef.current === generation) {
          const settled = api.settleDevelopmentPending(sessionId)
          setSegments((current) => current.map((segment) => settled.find((item) => item.id === segment.id) ?? segment))
          pausedRef.current = false; setPaused(false); setPartial(''); setSession({...completed,targetLanguage:targetRef.current || completed.targetLanguage}); setState('ended')
        }
      } catch (caught) {
        if (generationRef.current === generation) { setError(errorMessage(caught)); setState('error') }
      }
    }
    else if (!sentEnd) {
      retireSocket(endingSocket)
      if (generationRef.current === generation) {
        if (state === 'connecting' || state === 'reconnecting' && !tape?.anchored) {
          setState(unsavedFrames ? 'error' : 'idle')
          setError(unsavedFrames ? 'Audio captured while connecting could not be saved. Start a new recording to continue.' : '')
        } else await confirmPersisted(generation, unsavedFrames)
      }
    } else finishTimerRef.current = window.setTimeout(() => { if (generationRef.current !== generation) return; if (endingSocket && endingSocket.readyState < WebSocket.CLOSING) endingSocket.close(1000, 'client end timeout'); setSession((current) => current ? { ...current, status: 'completed' } : current); setState((current) => current === 'stopping' ? 'ended' : current); void reconcileSegments() }, 4_000)
  }, [confirmPersisted, flushWorkletTail, giveUp, pump, reconcileSegments, retireSocket, sessionId, state, stopCapture, stopMedia])
  useEffect(() => { if (state === 'ended' || state === 'error') { stopMedia(); retireSocket() } }, [retireSocket, state, stopMedia])
  // A finished recording takes room: the sidebar's storage is read again.
  useEffect(() => { if (state === 'ended') notifyStorageChanged() }, [state])
  useEffect(() => {
    const finishDemo = () => {
      if (!__TLINGUAL_DEVELOPMENT_MOCK__ || !demoActiveRef.current) return
      demoActiveRef.current = false
      const demoApi = api as typeof api & { finishDevelopmentLive(id: string): InterpretationSession }
      try { mockTimersRef.current.flush?.(); demoApi.finishDevelopmentLive(sessionId) }
      catch { /* Logout finalizes the demo before removing its identity. */ }
    }
    // A page reloaded or closed ends its recording rather than leaving it to wait for a return.
    const leave = (event: PageTransitionEvent) => { if (!event.persisted) retireSocket() }
    window.addEventListener('pagehide', finishDemo)
    window.addEventListener('pagehide', leave)
    return () => { finishDemo(); window.removeEventListener('pagehide', finishDemo); window.removeEventListener('pagehide', leave); generationRef.current += 1; retireSocket(); stopMedia() }
  }, [retireSocket, sessionId, stopMedia])
  useEffect(() => {
    if (__TLINGUAL_DEVELOPMENT_MOCK__ || !session?.id || typeof EventSource === 'undefined') return
    const watchTarget = targetRef.current
    const events = new EventSource(api.eventsUrl(sessionId))
    events.onmessage = event => {
      if (watchTarget !== targetRef.current) return
      let message: LiveServerMessage
      try { message = JSON.parse(event.data) as LiveServerMessage } catch { setError('The conversation sent an unreadable update.'); return }
      // A run of this browser's own recording that failed is gone on with
      // over its own connection; only that connection ends the recording here.
      if (message.type === 'stopped' && message.status === 'failed' && tapeRef.current) return
      handleMessage(message)
    }
    events.onerror = () => { void api.sessions.get(sessionId).then(value => { if (watchTarget !== targetRef.current) return; setSegments(current => mergeTranscript(current,value.segments)); setTranslationConfigured(value.translationConfigured) }).catch(caught => { setError(errorMessage(caught)); setAccess(null); setSession(null); setState('error'); events.close() }) }
    return () => events.close()
  }, [handleMessage, session?.id, sessionId, watchAttempt])
  const changeLanguage = useCallback(async (targetLanguage: string) => {
    setLanguageBusy(true); setError('')
    try {
      if (__TLINGUAL_DEVELOPMENT_MOCK__ && demoActiveRef.current) { mockTimersRef.current.flush?.(); mockTimersRef.current.forEach(window.clearTimeout); mockTimersRef.current=[] }
      const next = await api.sessions.language(sessionId, targetLanguage); targetRef.current=next.targetLanguage; setAccess(next); setSession(current => current ? {...current,targetLanguage:next.targetLanguage}:current); setSegments(current => current.map(item => ({...item,translation:'',translationStatus:'not_requested',translationError:undefined,translationRevision:undefined}))); setWatchAttempt(value=>value+1); await reconcileSegments()
      if (__TLINGUAL_DEVELOPMENT_MOCK__ && demoActiveRef.current && !pausedRef.current) { const {scheduleDevelopmentLiveSimulation}=await import('./developmentLiveSimulation'); mockTimersRef.current=scheduleDevelopmentLiveSimulation({sessionId,setPartial,setSegments,showPartial:showPartialsRef.current}) }
    }
    catch(caught) {setError(errorMessage(caught))} finally {setLanguageBusy(false)}
  }, [reconcileSegments,sessionId])
  const stopOtherRecorder = useCallback(async () => {try {await api.sessions.stopRecorder(sessionId)} catch(caught) {setError(errorMessage(caught))}},[sessionId])
  const changeRecognition = useCallback(async (languages: string[]) => {
    const updated=await api.sessions.recognition(sessionId,languages)
    setSession(current=>({...updated,targetLanguage:current?.targetLanguage ?? updated.targetLanguage}))
  },[sessionId])
  return { changeRecognition, translationConfigured, access, recording, presence, gaps, languageBusy, changeLanguage, stopOtherRecorder, session, segments, partial, state, paused, togglePause, error, elapsedMs, autoStart, compact, retryLoad, start, stop, unarchive, archiveBusy, keptMs, lostMs,
    captureGap, dismissCaptureGap: () => setCaptureGap(null), microphoneBlocked, resumeMicrophone: () => { void recoverCapture() } }
}
