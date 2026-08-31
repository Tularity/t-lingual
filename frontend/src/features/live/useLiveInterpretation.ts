import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { InterpretationSession, LiveClientMessage, LiveServerMessage, Segment } from '../../api/contracts'
import { dispatchAuthSessionInvalid } from '../../api/sessionInvalid'
import { loadLocalPreferences } from '../../app/preferences'
import { errorMessage } from '../../app/utils'

export type LiveState = 'idle' | 'requesting' | 'connecting' | 'live' | 'reconnecting' | 'stopping' | 'ended' | 'error'
export function makeLiveHello(sampleRate: number): LiveClientMessage { return { type: 'start', audio: { encoding: 'pcm32f', sampleRate, channels: 1 } } }
export async function ensureAudioContextRunning(context: Pick<AudioContext, 'resume' | 'state'>) {
  await context.resume()
  if (context.state !== 'running') throw new Error('Browser audio is suspended. Interact with the page and try starting again.')
}

function mergeSegments(current: Segment[], persisted: Segment[]) {
  const byID = new Map(current.map((segment) => [segment.id, segment]))
  persisted.forEach((segment) => byID.set(segment.id, segment))
  return [...byID.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

export function useLiveInterpretation(sessionId: string) {
  const [session, setSession] = useState<InterpretationSession | null>(null); const [segments, setSegments] = useState<Segment[]>([]); const [partial, setPartial] = useState('')
  const [state, setState] = useState<LiveState>('idle'); const [error, setError] = useState(''); const [elapsedMs, setElapsedMs] = useState(0)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [autoStart, setAutoStart] = useState(false); const [compact, setCompact] = useState(false); const showPartialsRef = useRef(true)
  const socketRef = useRef<WebSocket | null>(null); const streamRef = useRef<MediaStream | null>(null); const contextRef = useRef<AudioContext | null>(null); const workletRef = useRef<AudioWorkletNode | null>(null)
  const reconnectRef = useRef(0); const reconnectTimerRef = useRef<number | undefined>(undefined); const finishTimerRef = useRef<number | undefined>(undefined); const mockTimersRef = useRef<number[]>([]); const startedAtRef = useRef(0)
  const generationRef = useRef(0); const sessionEpochRef = useRef(0); const intentionalSocketsRef = useRef(new WeakSet<WebSocket>()); const connectSocketRef = useRef<((sampleRate: number, generation: number) => void) | null>(null)

  const fetchPersistedSegments = useCallback(async (after: number | undefined, hasMore: boolean, epoch: number) => {
    const persisted: Segment[] = []
    let cursor = after
    let more = hasMore
    try {
      while (more) {
        const page = await api.sessions.segments(sessionId, { after: cursor, limit: 200 })
        if (sessionEpochRef.current !== epoch) return
        persisted.push(...page.items)
        if (!page.hasMore) break
        const previousCursor = cursor ?? -1
        if (page.nextAfter <= previousCursor) throw new Error('The transcript service returned a non-advancing cursor.')
        cursor = page.nextAfter
        more = page.hasMore
      }
    } finally {
      if (sessionEpochRef.current === epoch && persisted.length) {
        setSegments((current) => mergeSegments(current, persisted))
      }
    }
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
    Promise.all([api.sessions.get(sessionId), api.settings.get().catch(() => null)]).then(([value, preferences]) => {
      if (active && sessionEpochRef.current === epoch) {
        setSession(value.session); setSegments(mergeSegments([], value.segments))
        if (value.session.status === 'completed') setState('ended')
        else if (value.session.status === 'failed') {
          setError('This interpretation ended with an interruption. Its persisted transcript is still available.')
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
  }, [fetchPersistedSegments, loadAttempt, sessionId])
  const retryLoad = useCallback(() => {
    setSession(null); setSegments([]); setPartial(''); setError(''); setState('idle')
    setLoadAttempt((current) => current + 1)
  }, [])
  useEffect(() => { if (state !== 'live' && state !== 'reconnecting') return; const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1_000); return () => window.clearInterval(timer) }, [state])

  const stopMedia = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    workletRef.current?.disconnect(); workletRef.current = null
    void contextRef.current?.close(); contextRef.current = null
    mockTimersRef.current.forEach(window.clearTimeout); mockTimersRef.current = []
    if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current)
    if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current)
    reconnectTimerRef.current = undefined; finishTimerRef.current = undefined
  }, [])
  const retireSocket = useCallback((socket = socketRef.current) => {
    if (!socket) return
    if (socketRef.current === socket) socketRef.current = null
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
    if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client cleanup')
  }, [])

  const handleMessage = useCallback((message: LiveServerMessage) => {
    if (message.type === 'ready') { reconnectRef.current = 0; setState('live'); setError(''); void reconcileSegments(); return }
    if (message.type === 'partial') { if (showPartialsRef.current) setPartial(message.text); return }
    if (message.type === 'final') { setPartial(''); setSegments((current) => mergeSegments(current, [message.segment])); return }
    if (message.type === 'translation') { setSegments((current) => current.map((segment) => segment.id === message.segmentId ? { ...segment, translationStatus: message.status, translation: message.translation, translationError: message.error, translatorRequestId: message.requestId } : segment)); return }
    if (message.type === 'provider_error') { setError(`${message.provider === 'asr' ? 'Recognition' : 'Translation'} provider reported ${message.code}.`); return }
    if (message.type === 'stopped') { setSession((current) => current ? { ...current, status: message.status } : current); if (message.status === 'failed') setError('The live session ended unexpectedly. Your received transcript is still safe.'); else setError(''); setState(message.status === 'failed' ? 'error' : 'ended'); void reconcileSegments(); return }
    if (message.type === 'error') {
      if (message.code === 'AUTH_REVOKED') dispatchAuthSessionInvalid({ reason: 'expired', message: message.message })
      setError(message.message); setState('error')
    }
  }, [reconcileSegments])

  const connectSocket = useCallback((sampleRate: number, generation: number) => {
    if (generationRef.current !== generation) return
    retireSocket()
    setState(reconnectRef.current ? 'reconnecting' : 'connecting')
    const socket = new WebSocket(api.liveSocketUrl(sessionId)); socket.binaryType = 'arraybuffer'; socketRef.current = socket
    let terminal = false
    const isCurrent = () => generationRef.current === generation && socketRef.current === socket
    socket.onopen = () => { if (isCurrent() && !intentionalSocketsRef.current.has(socket)) socket.send(JSON.stringify(makeLiveHello(sampleRate))); else socket.close(1000, 'stale connection') }
    socket.onmessage = (event) => {
      if (!isCurrent() || typeof event.data !== 'string') return
      try {
        const message = JSON.parse(event.data) as LiveServerMessage
        terminal = message.type === 'stopped' || message.type === 'error'
        handleMessage(message)
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

  const start = useCallback(async () => {
    if (!session || session.status === 'completed' || session.status === 'failed' || ['requesting', 'connecting', 'live'].includes(state)) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    retireSocket(); stopMedia()
    setState('requesting'); setError(''); reconnectRef.current = 0; startedAtRef.current = Date.now(); setElapsedMs(0)
    try {
      if (__TLINGUAL_DEVELOPMENT_MOCK__) {
        const { scheduleDevelopmentLiveSimulation } = await import('./developmentLiveSimulation')
        if (generationRef.current !== generation) return
        setState('live')
        mockTimersRef.current = scheduleDevelopmentLiveSimulation({ sessionId, setPartial, setSegments })
        return
      }
      const preferences = loadLocalPreferences(); const constraints: MediaTrackConstraints = { channelCount: 1, echoCancellation: preferences.echoCancellation, noiseSuppression: preferences.noiseSuppression }
      if (preferences.inputDeviceId !== 'default') constraints.deviceId = { exact: preferences.inputDeviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      if (generationRef.current !== generation) { stream.getTracks().forEach((track) => track.stop()); return }
      streamRef.current = stream
      stream.getTracks().forEach((track) => track.addEventListener('ended', () => {
        if (generationRef.current !== generation || streamRef.current !== stream) return
        setError('The microphone stopped unexpectedly. Check the selected input device and try again.')
        setState('error')
      }, { once: true }))
      const context = new AudioContext(); contextRef.current = context; await context.audioWorklet.addModule('/pcm-worklet.js')
      if (generationRef.current !== generation) {
        if (contextRef.current === context) contextRef.current = null
        if (streamRef.current === stream) streamRef.current = null
        stream.getTracks().forEach((track) => track.stop()); void context.close()
        return
      }
      const source = context.createMediaStreamSource(stream); const worklet = new AudioWorkletNode(context, 't-lingual-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); const silent = context.createGain(); silent.gain.value = 0
      source.connect(worklet); worklet.connect(silent); silent.connect(context.destination); workletRef.current = worklet
      await ensureAudioContextRunning(context)
      if (generationRef.current !== generation) {
        if (workletRef.current === worklet) workletRef.current = null
        if (contextRef.current === context) contextRef.current = null
        if (streamRef.current === stream) streamRef.current = null
        worklet.disconnect(); stream.getTracks().forEach((track) => track.stop()); void context.close()
        return
      }
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => { const socket = socketRef.current; if (generationRef.current === generation && workletRef.current === worklet && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 1_000_000) socket.send(event.data) }
      connectSocket(context.sampleRate, generation)
    } catch (caught) { if (generationRef.current !== generation) return; stopMedia(); retireSocket(); setState('error'); setError(caught instanceof DOMException && caught.name === 'NotAllowedError' ? 'Microphone access was not granted. Allow access in your browser and try again.' : errorMessage(caught)) }
  }, [connectSocket, retireSocket, session, sessionId, state, stopMedia])
  const stop = useCallback(async () => {
    if (!['live', 'reconnecting', 'connecting'].includes(state)) return
    const generation = generationRef.current
    setState('stopping')
    const endingSocket = socketRef.current
    if (endingSocket) intentionalSocketsRef.current.add(endingSocket)
    const sentEnd = endingSocket?.readyState === WebSocket.OPEN
    if (sentEnd) endingSocket.send(JSON.stringify({ type: 'end' } satisfies LiveClientMessage))
    stopMedia()
    if (__TLINGUAL_DEVELOPMENT_MOCK__) { await new Promise((resolve) => window.setTimeout(resolve, 350)); if (generationRef.current === generation) { setSession((current) => current ? { ...current, status: 'completed' } : current); setState('ended') } }
    else if (!sentEnd) {
      retireSocket(endingSocket)
      if (generationRef.current === generation) {
        if (state === 'connecting') {
          setState('idle')
          setError('')
        } else {
          const epoch = sessionEpochRef.current
          setState('error')
          setError('The connection ended before the stop request reached the server. Checking the persisted session status…')
          try {
            const persisted = await api.sessions.get(sessionId)
            if (generationRef.current !== generation || sessionEpochRef.current !== epoch) return
            setSession(persisted.session)
            setSegments((current) => mergeSegments(current, persisted.segments))
            if (persisted.session.status === 'completed') {
              setError('')
              setState('ended')
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
  }, [reconcileSegments, retireSocket, sessionId, state, stopMedia])
  useEffect(() => { if (state === 'ended' || state === 'error') { stopMedia(); retireSocket() } }, [retireSocket, state, stopMedia])
  useEffect(() => () => { generationRef.current += 1; retireSocket(); stopMedia() }, [retireSocket, sessionId, stopMedia])
  return { session, segments, partial, state, error, elapsedMs, autoStart, compact, retryLoad, start, stop }
}
