import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { InterpretationSession, LiveClientMessage, LiveServerMessage, Segment, ViewerAccess, RecordingState } from '../../api/contracts'
import { dispatchAuthSessionInvalid } from '../../api/sessionInvalid'
import { loadLocalPreferences } from '../../app/preferences'
import { connectMicrophoneCapture, microphoneConstraints } from './audioCapture'
import { CaptureFrameQueue } from './captureFrameQueue'
import { errorMessage } from '../../app/utils'
import { LIVE_TAIL_LIMIT, mergeTranscript, updateTranslation } from './transcriptState'

export type LiveState = 'idle' | 'requesting' | 'connecting' | 'live' | 'reconnecting' | 'stopping' | 'ended' | 'error'
export function makeLiveHello(sampleRate: number): LiveClientMessage { return { type: 'start', audio: { encoding: 'pcm32f', sampleRate, channels: 1 } } }
export function sendPCMFrame(socket: Pick<WebSocket, 'bufferedAmount' | 'send'>, frame: ArrayBuffer) {
  if (socket.bufferedAmount + frame.byteLength >= 1_000_000) throw new Error('Audio connection is too slow. Recording stopped to protect the saved audio.')
  socket.send(frame)
}
export async function ensureAudioContextRunning(context: Pick<AudioContext, 'resume' | 'state'>) {
  await context.resume()
  if (context.state !== 'running') throw new Error('Browser audio is suspended. Interact with the page and try starting again.')
}


export function useLiveInterpretation(sessionId: string, guest = false) {
  const [translationConfigured, setTranslationConfigured] = useState<boolean | undefined>(undefined)
  const [access, setAccess] = useState<ViewerAccess | null>(null)
  const [recording, setRecording] = useState<RecordingState>({ active: false })
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
  const captureQueueRef = useRef<CaptureFrameQueue | null>(null)
  const socketReadyRef = useRef(false)
  const flushRequestRef = useRef(0)
  const flushWaiterRef = useRef<{ requestId: number; resolve: (flushed: boolean) => void } | null>(null)
  const socketRef = useRef<WebSocket | null>(null); const streamRef = useRef<MediaStream | null>(null); const contextRef = useRef<AudioContext | null>(null); const workletRef = useRef<AudioWorkletNode | null>(null)
  const reconnectRef = useRef(0); const reconnectTimerRef = useRef<number | undefined>(undefined); const finishTimerRef = useRef<number | undefined>(undefined); const mockTimersRef = useRef<number[] & { flush?: () => void }>([]); const startedAtRef = useRef(0)
  const draftRef = useRef<Segment | null>(null)
  const latestSequenceRef = useRef(0)
  const generationRef = useRef(0); const sessionEpochRef = useRef(0); const intentionalSocketsRef = useRef(new WeakSet<WebSocket>()); const connectSocketRef = useRef<((sampleRate: number, generation: number) => void) | null>(null)

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
        setTranslationConfigured(value.translationConfigured); setAccess(value.access ?? null); setRecording(value.recording ?? { active: false }); targetRef.current=value.access?.targetLanguage ?? value.session.targetLanguage; setSession(value.session); setSegments(mergeTranscript([], value.segments)); latestSequenceRef.current = value.segments.at(-1)?.sequence ?? 0; draftRef.current = null
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

  useEffect(() => {
    const resumeVisibleCapture = () => {
      const context = contextRef.current
      if (document.visibilityState !== 'visible' || context?.state !== 'suspended') return
      void context.resume().catch((caught: unknown) => {
        if (contextRef.current !== context) return
        setError(`Microphone audio could not resume. ${errorMessage(caught)}`)
        setState('error')
      })
    }
    document.addEventListener('visibilitychange', resumeVisibleCapture)
    return () => document.removeEventListener('visibilitychange', resumeVisibleCapture)
  }, [])
  const stopMedia = useCallback(() => {
    flushWaiterRef.current?.resolve(false); flushWaiterRef.current = null
    captureQueueRef.current?.clear(); captureQueueRef.current = null
    socketReadyRef.current = false
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    workletRef.current?.disconnect(); workletRef.current = null
    void contextRef.current?.close(); contextRef.current = null
    try { mockTimersRef.current.flush?.() } catch { /* Logout may already have finalized the demo and removed its identity. */ }
    mockTimersRef.current.forEach(window.clearTimeout); mockTimersRef.current = []
    if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current)
    if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current)
    reconnectTimerRef.current = undefined; finishTimerRef.current = undefined
  }, [])
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
  const retireSocket = useCallback((socket = socketRef.current) => {
    if (!socket) return
    if (socketRef.current === socket) { socketRef.current = null; socketReadyRef.current = false }
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
    if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client cleanup')
  }, [])

  const handleMessage = useCallback((message: LiveServerMessage) => {
    if (message.type === 'snapshot') {
      const target = message.access?.targetLanguage ?? message.session.targetLanguage
      if (targetRef.current && target !== targetRef.current) return
      setSession(current => ({ ...current, ...message.session, targetLanguage: target, isOwner: message.access?.isOwner, permission: message.access?.permission })); setAccess(message.access ?? null); setRecording(message.recording ?? { active: false }); setSegments(current => mergeTranscript(current, message.segments)); latestSequenceRef.current = Math.max(latestSequenceRef.current, message.segments.at(-1)?.sequence ?? 0); return
    }
    if (message.type === 'recording') { setRecording(message.recording); return }
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
    if (message.type === 'provider_error') { setError(`${message.provider === 'asr' ? 'Recognition' : 'Translation'} provider reported ${message.code}.`); return }
    if (message.type === 'stopped') { setSession((current) => current ? { ...current, status: message.status } : current); if (message.status === 'failed') setError('The live session ended unexpectedly. Your received transcript is still safe.'); else setError(''); setState(message.status === 'failed' ? 'error' : 'ended'); void reconcileSegments(); return }
    if (message.type === 'error') {
      if (message.code === 'AUTH_REVOKED') dispatchAuthSessionInvalid({ reason: 'expired', message: message.message })
      setError(message.message); setState('error')
    }
  }, [reconcileSegments, sessionId])

  const connectSocket = useCallback((sampleRate: number, generation: number) => {
    if (generationRef.current !== generation) return
    retireSocket()
    socketReadyRef.current = false
    setState(reconnectRef.current ? 'reconnecting' : 'connecting')
    const socket = new WebSocket(api.liveSocketUrl(sessionId, takeoverRef.current)); takeoverRef.current = false; socket.binaryType = 'arraybuffer'; socketRef.current = socket
    let terminal = false
    const isCurrent = () => generationRef.current === generation && socketRef.current === socket
    socket.onopen = () => { if (isCurrent() && !intentionalSocketsRef.current.has(socket)) socket.send(JSON.stringify(makeLiveHello(sampleRate))); else socket.close(1000, 'stale connection') }
    socket.onmessage = (event) => {
      if (!isCurrent() || typeof event.data !== 'string') return
      try {
        const message = JSON.parse(event.data) as LiveServerMessage
        terminal = message.type === 'stopped' || message.type === 'error'
        handleMessage(message)
        if (message.type === 'ready') {
          socketReadyRef.current = true
          try { captureQueueRef.current?.drain(frame => sendPCMFrame(socket, frame)) }
          catch (caught) { setError(errorMessage(caught)); setState('error'); stopMedia(); retireSocket(socket); return }
        }
        if (terminal) { stopMedia(); retireSocket(socket) }
      } catch {
        terminal = true
        setError('The live service sent an unreadable message.')
        setState('error')
        stopMedia(); retireSocket(socket)
      }
    }
    socket.onerror = () => { if (isCurrent()) setError('The live connection was interrupted.') }
    socket.onclose = () => {
      if (!isCurrent()) return
      socketRef.current = null
      socketReadyRef.current = false
      if (terminal) return
      if (intentionalSocketsRef.current.has(socket)) { stopMedia(); setSession((current) => current ? { ...current, status: 'completed' } : current); setState('ended'); void reconcileSegments(); return }
      if (!streamRef.current?.active) { setError('The microphone or live connection ended unexpectedly.'); setState('error'); return }
      reconnectRef.current += 1
      if (reconnectRef.current > 4) { setState('error'); setError('We couldn’t restore the live connection. Your received transcript is still safe.'); void reconcileSegments(); return }
      setState('reconnecting'); reconnectTimerRef.current = window.setTimeout(() => { if (generationRef.current === generation && streamRef.current?.active) connectSocketRef.current?.(sampleRate, generation) }, Math.min(8_000, 700 * 2 ** (reconnectRef.current - 1)))
    }
  }, [handleMessage, reconcileSegments, retireSocket, sessionId, stopMedia])
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
    setState('requesting'); setError(''); reconnectRef.current = 0
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
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (generationRef.current !== generation || streamRef.current !== stream) return
        setError('The microphone stopped unexpectedly. Check the selected input device and try again.')
        setState('error')
      }, { once: true }))
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
      const queue = new CaptureFrameQueue(Math.min(900_000, Math.round(context.sampleRate * 4 * 1.5)))
      captureQueueRef.current = queue
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
        if (generationRef.current !== generation || workletRef.current !== worklet) return
        const frame = pausedRef.current ? new ArrayBuffer(data.byteLength) : data
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN || !socketReadyRef.current) {
          if (!queue.enqueue(frame)) failCapture(new Error('Audio connection is too slow. Recording stopped to protect the saved audio.'))
          return
        }
        try {
          if (queue.length) queue.drain(buffered => sendPCMFrame(socket, buffered))
          sendPCMFrame(socket, frame)
        } catch (caught) { failCapture(caught) }
      }
      connectMicrophoneCapture(context, stream, worklet, preferences)
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
  }, [access?.permission, connectSocket, retireSocket, session, sessionId, state, stopMedia])
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
    const unsavedFrames = captureQueueRef.current?.length ?? 0
    const sentEnd = endingSocket?.readyState === WebSocket.OPEN && socketReadyRef.current
    if (sentEnd) { intentionalSocketsRef.current.add(endingSocket); endingSocket.send(JSON.stringify({ type: 'end' } satisfies LiveClientMessage)) }
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
        if (state === 'connecting') {
          setState(unsavedFrames ? 'error' : 'idle')
          setError(unsavedFrames ? 'Audio captured while connecting could not be saved. Start a new recording to continue.' : '')
        } else {
          const epoch = sessionEpochRef.current
          setState('error')
          setError('The connection ended before the stop request reached the server. Checking the persisted session status…')
          try {
            const persisted = await api.sessions.get(sessionId)
            if (generationRef.current !== generation || sessionEpochRef.current !== epoch) return
            setSession(persisted.session)
            setSegments((current) => mergeTranscript(current, persisted.segments))
            if (persisted.session.status === 'completed') {
              setError(unsavedFrames ? 'Audio captured while reconnecting could not be saved. Start a new recording to continue.' : '')
              setState(unsavedFrames ? 'error' : 'ended')
            } else if (persisted.session.status === 'failed') {
              setError('The interrupted connection was recorded by the server. Your persisted transcript is still available.')
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
        }
      }
    } else finishTimerRef.current = window.setTimeout(() => { if (generationRef.current !== generation) return; if (endingSocket && endingSocket.readyState < WebSocket.CLOSING) endingSocket.close(1000, 'client end timeout'); setSession((current) => current ? { ...current, status: 'completed' } : current); setState((current) => current === 'stopping' ? 'ended' : current); void reconcileSegments() }, 4_000)
  }, [flushWorkletTail, reconcileSegments, retireSocket, sessionId, state, stopMedia])
  useEffect(() => { if (state === 'ended' || state === 'error') { stopMedia(); retireSocket() } }, [retireSocket, state, stopMedia])
  useEffect(() => {
    const finishDemo = () => {
      if (!__TLINGUAL_DEVELOPMENT_MOCK__ || !demoActiveRef.current) return
      demoActiveRef.current = false
      const demoApi = api as typeof api & { finishDevelopmentLive(id: string): InterpretationSession }
      try { mockTimersRef.current.flush?.(); demoApi.finishDevelopmentLive(sessionId) }
      catch { /* Logout finalizes the demo before removing its identity. */ }
    }
    window.addEventListener('pagehide', finishDemo)
    return () => { finishDemo(); window.removeEventListener('pagehide', finishDemo); generationRef.current += 1; retireSocket(); stopMedia() }
  }, [retireSocket, sessionId, stopMedia])
  useEffect(() => {
    if (__TLINGUAL_DEVELOPMENT_MOCK__ || !session?.id || typeof EventSource === 'undefined') return
    const watchTarget = targetRef.current
    const events = new EventSource(api.eventsUrl(sessionId))
    events.onmessage = event => { if (watchTarget !== targetRef.current) return; try { handleMessage(JSON.parse(event.data) as LiveServerMessage) } catch { setError('The conversation sent an unreadable update.') } }
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
  return { changeRecognition, translationConfigured, access, recording, languageBusy, changeLanguage, stopOtherRecorder, session, segments, partial, state, paused, togglePause, error, elapsedMs, autoStart, compact, retryLoad, start, stop, unarchive, archiveBusy }
}
