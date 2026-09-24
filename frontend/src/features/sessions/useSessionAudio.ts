import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { AudioPart, SessionAudio } from '../../api/contracts'
import { errorMessage } from '../../app/utils'

export function playableParts(parts: AudioPart[]) {
  return parts.filter(part => part.state !== 'recording' && part.durationMs > 0).sort((a, b) => a.startMs - b.startMs)
}
export function locateAudio(parts: AudioPart[], position: number) {
  const ready = playableParts(parts)
  const part = ready.find(item => position >= item.startMs && position < item.startMs + item.durationMs)
    ?? ready.find(item => item.startMs >= position) ?? ready.at(-1)
  return part ? { part, position: Math.max(part.startMs, Math.min(position, part.startMs + part.durationMs)) } : null
}

export function useSessionAudio(sessionId: string, refreshKey?: string) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const currentSessionRef = useRef(sessionId)
  const playRequestRef = useRef(0)
  useLayoutEffect(() => { currentSessionRef.current = sessionId; playRequestRef.current++ }, [sessionId])
  const bindAudio = useCallback((node: HTMLAudioElement | null) => {
    if (audioRef.current !== node) {
      playRequestRef.current++
      audioRef.current?.pause()
    }
    audioRef.current = node
  }, [])
  const [storedCatalog, setCatalog] = useState<SessionAudio>({ parts: [], durationMs: 0 })
  const [loadedFor, setLoadedFor] = useState(sessionId)
  const loadedSessionRef = useRef(sessionId)
  const switchingRef = useRef(false)
  const catalog = loadedFor === sessionId ? storedCatalog : { parts: [], durationMs: 0 }
  const [partId, setPartId] = useState('')
  const partIdRef = useRef(partId)
  useLayoutEffect(() => { partIdRef.current = partId }, [partId])
  const [positionMs, setPositionMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [failure, setFailure] = useState<{ sessionId: string; message: string; kind: 'catalog' | 'media' | 'play' | '' }>({ sessionId: '', message: '', kind: '' })
  const [rate, setRate] = useState(1)
  const [volume, setVolume] = useState(.85)
  const [seekToken, setSeekToken] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)
  const pendingRef = useRef({ time: 0, play: false })
  const selected = catalog.parts.find(part => part.id === partId && part.state !== 'recording' && part.durationMs > 0)
  const source = selected ? api.audio.partUrl(sessionId, selected.id) : undefined

  useEffect(() => {
    let active = true
    api.audio.list(sessionId).then(value => {
      if (!active) return
      const switchedSession = loadedSessionRef.current !== sessionId
      const removedPart = !switchedSession && Boolean(partIdRef.current) && !playableParts(value.parts).some(part => part.id === partIdRef.current)
      if (switchedSession) {
        loadedSessionRef.current = sessionId
        playRequestRef.current++
        audioRef.current?.pause()
        setPartId('')
        setPositionMs(0)
        setPlaying(false)
        setLoading(false)
        pendingRef.current = { time: 0, play: false }
        switchingRef.current = false
      } else if (removedPart) {
        playRequestRef.current++
        audioRef.current?.pause()
        setPartId('')
        setPositionMs(0)
        setPlaying(false)
        setLoading(false)
        pendingRef.current = { time: 0, play: false }
        switchingRef.current = false
      }
      setLoadedFor(sessionId)
      setCatalog(value)
      setCatalogLoading(false)
      setFailure(previous => !switchedSession && !removedPart && previous.sessionId === sessionId && previous.kind !== 'catalog' ? previous : { sessionId, message: '', kind: '' })
    }).catch(caught => {
      if (active) {
        setFailure({ sessionId, message: errorMessage(caught), kind: 'catalog' })
        setCatalogLoading(false)
      }
    })
    return () => { active = false }
  }, [sessionId, refreshKey, attempt])

  const playElement = useCallback(async () => {
    const element = audioRef.current
    const session = currentSessionRef.current
    if (!element || loadedSessionRef.current !== session) return
    const request = ++playRequestRef.current
    const stillCurrent = () => currentSessionRef.current === session && audioRef.current === element && playRequestRef.current === request
    try {
      await element.play()
      if (stillCurrent()) setFailure({ sessionId: session, message: '', kind: '' })
    } catch (caught) {
      if (stillCurrent()) {
        setPlaying(false)
        setFailure({ sessionId: session, message: errorMessage(caught), kind: 'play' })
      }
    }
  }, [])
  useEffect(() => {
    const element = audioRef.current
    if (!element || !source) return
    element.load()
    return () => element.pause()
  }, [source, reloadToken])
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = rate }, [rate])
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume }, [volume])

  const seek = useCallback((requested: number, autoplay = playing) => {
    const located = locateAudio(catalog.parts, requested)
    if (!located) return
    playRequestRef.current++
    setPositionMs(located.position)
    setSeekToken(value => value + 1)
    pendingRef.current = { time: (located.position - located.part.startMs) / 1000, play: autoplay }
    if (partId !== located.part.id) {
      switchingRef.current = true
      audioRef.current?.pause()
      setPartId(located.part.id)
      setLoading(true)
    } else if (audioRef.current) {
      audioRef.current.currentTime = pendingRef.current.time
      if (autoplay) void playElement()
    }
  }, [catalog.parts, partId, playElement, playing])
  const pause = useCallback(() => {
    playRequestRef.current++
    pendingRef.current.play = false
    audioRef.current?.pause()
    setPlaying(false)
  }, [])
  const play = useCallback(() => {
    pendingRef.current.play = true
    if (positionMs >= catalog.durationMs - 50) seek(playableParts(catalog.parts)[0]?.startMs ?? 0, true)
    else if (!selected) seek(positionMs, true)
    else void playElement()
  }, [catalog.durationMs, catalog.parts, playElement, positionMs, seek, selected])
  const onLoadedMetadata = () => {
    const element = audioRef.current
    if (!element || !source || loadedFor !== sessionId) return
    element.playbackRate = rate
    element.volume = volume
    element.currentTime = Math.min(pendingRef.current.time, Number.isFinite(element.duration) ? element.duration : pendingRef.current.time)
    switchingRef.current = false
    setLoading(false)
    if (pendingRef.current.play) void playElement()
  }
  const onEnded = () => {
    if (!pendingRef.current.play || switchingRef.current) return
    const ready = playableParts(catalog.parts), index = ready.findIndex(part => part.id === partId), next = ready[index + 1]
    if (next) seek(next.startMs, true)
    else { setPlaying(false); if (selected) setPositionMs(selected.startMs + selected.durationMs) }
  }
  const onTimeUpdate = () => { if (selected && audioRef.current) setPositionMs(selected.startMs + audioRef.current.currentTime * 1000) }
  const onError = () => {
    if (!source || loadedFor !== sessionId) return
    playRequestRef.current++
    setLoading(false)
    setPlaying(false)
    setFailure({ sessionId, message: 'The recording could not be loaded. Check your access and try again.', kind: 'media' })
  }
  const retry = () => {
    playRequestRef.current++
    if (selected) pendingRef.current.time = Math.max(0, (positionMs - selected.startMs) / 1000)
    audioRef.current?.pause()
    setFailure({ sessionId, message: '', kind: '' })
    setLoading(Boolean(source))
    setCatalogLoading(true)
    setReloadToken(value => value + 1)
    setAttempt(value => value + 1)
  }
  return {
    bindAudio, source, catalog, selected, positionMs: loadedFor === sessionId ? positionMs : 0,
    playing: loadedFor === sessionId && playing, loading: loadedFor === sessionId && loading,
    catalogLoading: (loadedFor !== sessionId && !(failure.sessionId === sessionId && failure.kind === 'catalog')) || catalogLoading,
    error: failure.sessionId === sessionId ? failure.message : '', rate, volume, seekToken,
    ready: playableParts(catalog.parts), play, pause, seek, setRate, setVolume,
    onLoadedMetadata, onEnded, onTimeUpdate, onError,
    onPlay: () => { if (source && loadedFor === sessionId) setPlaying(true) },
    onPause: () => setPlaying(false), retry,
  }
}

export type SessionPlayer = ReturnType<typeof useSessionAudio>
