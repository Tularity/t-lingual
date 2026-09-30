import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {useI18n,translate,type ResolvedLanguage} from '../../app/i18n'
import { createPortal } from 'react-dom'
import { Button, Icon } from '@t-lingual/ui'
import type { Segment } from '../../api/contracts'
import { languageName } from '../../app/utils'
import { LanguageLabel, languageFlag } from '../languages'
import './transcript.css'

interface DocumentPiPAccess {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

type PiPWindow = Window & { documentPictureInPicture?: DocumentPiPAccess }
type PiPDocument = Document & { adoptedStyleSheets?: CSSStyleSheet[] }

/**
 * A recording the floating transcript can pause and resume: the floating
 * window's own play and pause, and its buttons, act on it.
 */
export interface PiPRecordingControl {
  /** Whether the microphone is being recorded now, rather than paused or stopped. */
  recording: boolean
  /** What the floating window says about the recording, as “Recording 12:04”. */
  label: string
  onPause(): void
  onResume(): void
}

export interface TranscriptPiPOptions {
  locale?: ResolvedLanguage
  segments: Segment[]
  title: string
  sourceLanguage: string
  targetLanguage: string
  paused?: boolean
  live?: boolean
  control?: PiPRecordingControl
}

function supportsDocumentPiP() {
  return typeof window !== 'undefined' && !!(window as PiPWindow).documentPictureInPicture?.requestWindow
}

/** WebKit's own presentation modes: all Safari offers on iPhone, and more on older Macs. */
type WebKitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitPresentationMode?: string
}

/**
 * How a drawn transcript can float as a video: WebKit's own presentation mode
 * where Safari offers it (it floats a canvas stream the standard call does
 * not), else the standard API, or not at all.
 */
function videoPiPMode(): 'standard' | 'webkit' | null {
  if (typeof document === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null
  const probe = document.createElement('video') as WebKitVideo
  if (probe.webkitSupportsPresentationMode?.('picture-in-picture') && typeof probe.webkitSetPresentationMode === 'function') return 'webkit'
  if (document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function') return 'standard'
  return null
}

function copyStyles(target: Document) {
  for (const source of document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]')) {
    const clone = source.cloneNode(true) as HTMLStyleElement | HTMLLinkElement
    if (source instanceof HTMLLinkElement && clone instanceof HTMLLinkElement) clone.href = source.href
    target.head.append(clone)
  }
  const adopted = (document as PiPDocument).adoptedStyleSheets
  if (adopted?.length && 'adoptedStyleSheets' in target) {
    try { (target as PiPDocument).adoptedStyleSheets = adopted } catch { /* Stylesheet cloning above remains available. */ }
  }
  target.documentElement.dataset.theme = document.documentElement.dataset.theme || 'light'
  target.body.className = 'tl-root'
  target.title = 'T Lingual transcript'
}

function PiPContent({ options, close }: { options: TranscriptPiPOptions; close: () => void }) {
  const {t}=useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const latest = options.segments.slice(-6)
  const sourceLanguage = latest.at(-1)?.detectedLanguage ?? options.sourceLanguage
  const latestRevision = latest.map(segment => `${segment.sequence}:${segment.sourceRevision ?? 0}:${segment.translationRevision ?? 0}`).join(',')
  useEffect(() => {
    const bodies = rootRef.current?.querySelectorAll<HTMLElement>('.tv-pip__body')
    if (!bodies || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => bodies.forEach(body => { body.scrollTop = body.scrollHeight }))
    bodies.forEach(body => observer.observe(body))
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      rootRef.current?.querySelectorAll<HTMLElement>('.tv-pip__body').forEach(body => { body.scrollTop = body.scrollHeight })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [latestRevision])
  const control = options.control
  return <div ref={rootRef} className="tv-pip" aria-label={options.title}>
    <section className="tv-pip__pane" aria-label={t("Original speech")}><header className="tv-pip__head"><div><LanguageLabel code={sourceLanguage} /><span>{t("Original")}</span>{options.paused && !control && <span>{t("Paused")}</span>}</div><div>{control && <><span className="tv-pip__status" data-recording={control.recording || undefined}>{control.label}</span><Button size="xs" variant="ghost" icon={<Icon name={control.recording ? 'pause' : 'play'} size={13} />} onClick={control.recording ? control.onPause : control.onResume}>{control.recording ? t("Pause") : t("Record")}</Button></>}<Button size="xs" variant="ghost" iconOnly icon={<Icon name="close" size={13} />} aria-label={t("Close transcript picture-in-picture")} onClick={close} /></div></header><div className="tv-pip__body">{latest.length === 0 ? <p className="tv-pip__empty">{t("Waiting for speech…")}</p> : latest.map(segment => <article key={`${segment.sessionId}:${segment.sequence}`} className="tv-pip__row"><p dir="auto">{segment.sourceText}{!segment.final && <span className="tv-row__caret" aria-hidden="true" />}</p></article>)}</div></section>
    <section className="tv-pip__pane tv-pip__pane--translation" aria-label={t("Translation")}><header className="tv-pip__head"><div><LanguageLabel code={options.targetLanguage} /><span>{t("Translation")}</span></div></header><div className="tv-pip__body">{latest.filter(segment => segment.translation || segment.translationStatus === 'failed').map(segment => <article key={`${segment.sessionId}:${segment.sequence}`} className="tv-pip__row"><p dir="auto">{segment.translationStatus === 'failed' ? t('Translation unavailable') : segment.translation}{segment.translationStatus === 'pending' && <span className="tv-row__caret" aria-hidden="true" />}</p></article>)}</div></section>
  </div>
}

function canvasLines(context: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = []
  let line = ''
  for (const token of text.match(/\S+\s*/gu) ?? []) {
    if (context.measureText(line + token).width <= width) { line += token; continue }
    if (line.trim()) { lines.push(line.trimEnd()); line = '' }
    for (const character of Array.from(token)) {
      if (context.measureText(line + character).width > width && line) { lines.push(line.trimEnd()); line = '' }
      line += character
    }
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}
export function wrapCanvasText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const lines = canvasLines(context, text, maxWidth)
  const visible = lines.slice(0, maxLines)
  if (lines.length > maxLines && visible.length) {
    let last = visible[visible.length - 1]!
    while (last && context.measureText(`${last}…`).width > maxWidth) last = Array.from(last).slice(0, -1).join('')
    visible[visible.length - 1] = `${last}…`
  }
  visible.forEach((value, index) => context.fillText(value, x, y + index * lineHeight))
  return y + visible.length * lineHeight
}
const flagImages = new Map<string, HTMLImageElement>()
function canvasFlag(code: string) {
  const url = languageFlag(code)
  if (!url) return undefined
  let image = flagImages.get(url)
  if (!image) { image = new Image(); image.src = new URL(url, window.location.href).href; flagImages.set(url, image) }
  return image.complete && image.naturalWidth ? image : undefined
}
function drawVideoFrame(canvas: HTMLCanvasElement, options: TranscriptPiPOptions) {
  const t=(key:string)=>translate(options.locale??'en',key)
  const context = canvas.getContext('2d')
  if (!context) return
  const dark = document.documentElement.dataset.theme === 'dark'
  const latest = options.segments.slice(-6)
  const sourceLanguage = latest.at(-1)?.detectedLanguage ?? options.sourceLanguage
  const paneHeight = canvas.height / 2
  const panes = [
    { code: sourceLanguage, label: t('Original'), fill: dark ? '#211d19' : '#fffcf6', color: dark ? '#f4eee1' : '#30271e', lines: latest.map(segment => segment.sourceText) },
    { code: options.targetLanguage, label: t('Translation'), fill: dark ? '#292219' : '#f6f0e5', color: dark ? '#edc886' : '#775020', lines: latest.map(segment => segment.translationStatus === 'failed' ? segment.translationError || 'Translation unavailable' : segment.translation).filter(Boolean) },
  ]
  for (const [index, pane] of panes.entries()) {
    const top = index * paneHeight
    context.fillStyle = pane.fill; context.fillRect(0, top, canvas.width, paneHeight)
    context.textAlign = 'left'; context.direction = 'ltr'; context.font = '15px system-ui, sans-serif'; context.fillStyle = dark ? '#c5b9aa' : '#755f49'
    const flag = canvasFlag(pane.code)
    if (flag) {
      const ratio = flag.naturalWidth / flag.naturalHeight
      const width = Math.min(20, 20 * ratio), height = Math.min(20, 20 / ratio)
      context.drawImage(flag, 15 + (20 - width) / 2, top + 8 + (20 - height) / 2, width, height)
    }
    context.fillText(`${pane.code === 'auto' ? t('Mixed languages') : options.locale==='zh-Hans'?new Intl.DisplayNames(['zh-Hans'],{type:'language'}).of(pane.code):languageName(pane.code)} · ${pane.label}${index === 0 && options.paused && !options.control ? ` · ${t('Paused')}` : ''}`, 45, top + 23)
    if (index === 0 && options.control) {
      // Whether it is recording, where the floating window's play and pause act on it.
      const recording = options.control.recording
      context.textAlign = 'right'; context.font = '600 15px system-ui, sans-serif'
      context.fillStyle = recording ? (dark ? '#f08a7a' : '#b3261e') : (dark ? '#c5b9aa' : '#755f49')
      context.fillText(`${recording ? '● ' : ''}${options.control.label}`, canvas.width - 15, top + 23)
      context.textAlign = 'left'
    }
    context.save(); context.beginPath(); context.rect(12, top + 34, canvas.width - 24, paneHeight - 38); context.clip()
    let y = top + paneHeight - 12
    for (let item = pane.lines.length - 1; item >= 0 && y > top + 30; item--) {
      const text = pane.lines[item]!
      context.font = `${item === pane.lines.length - 1 ? '550' : '400'} 22px system-ui, sans-serif`
      context.fillStyle = pane.color
      const rtl = /^[^\p{L}]*[\u0590-\u08ff]/u.test(text)
      context.direction = rtl ? 'rtl' : 'ltr'; context.textAlign = rtl ? 'right' : 'left'
      const lines = canvasLines(context, text, canvas.width - 30)
      for (let line = lines.length - 1; line >= 0 && y > top + 30; line--) { context.fillText(lines[line]!, rtl ? canvas.width - 15 : 15, y); y -= 29 }
      y -= 5
    }
    context.restore()
  }
}

/**
 * The video a drawn transcript floats in: a canvas stream playing in a video
 * that is in the page, as Safari requires of a video it floats, but not seen.
 * It is made ready before it is asked for, so a click finds it with a frame.
 */
interface VideoSource {
  canvas: HTMLCanvasElement
  video: WebKitVideo
  stream: MediaStream
  /** Set while the page itself plays or pauses the video, so its events are not taken for the viewer's. */
  syncing: boolean
}

function createVideoSource(options: TranscriptPiPOptions): VideoSource {
  const canvas = document.createElement('canvas')
  canvas.width = 640; canvas.height = 400
  const stream = canvas.captureStream(15)
  const video = document.createElement('video') as WebKitVideo
  video.className = 'tv-pip-video-source'
  video.setAttribute('aria-hidden', 'true')
  video.muted = true; video.playsInline = true
  video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '')
  video.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none'
  video.srcObject = stream
  document.body.append(video)
  // Drawn once capture has begun, so the stream has its first frame.
  drawVideoFrame(canvas, options)
  return { canvas, video, stream, syncing: false }
}

/** Stops the capture and removes the video; `drawing` and `listeners` are its redraw timer and event listeners, if it floated. */
function destroyVideoSource(source: VideoSource, drawing: number, listeners: Array<[string, () => void]>) {
  window.clearInterval(drawing)
  for (const [type, listener] of listeners) source.video.removeEventListener(type, listener)
  source.stream.getTracks().forEach((track) => track.stop())
  source.syncing = true
  source.video.pause()
  source.video.srcObject = null
  source.video.remove()
}

/** Resolves once the video has a frame to show, or after half a second, as Safari may not say so before it floats. */
function hasFrame(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => { window.clearTimeout(timer); video.removeEventListener('canplay', done); resolve() }
    const timer = window.setTimeout(done, 500)
    video.addEventListener('canplay', done)
  })
}

/** Marks the video as moved by the page until the returned release is called, a turn later. */
function holdSync(source: VideoSource) {
  source.syncing = true
  return () => { window.setTimeout(() => { source.syncing = false }, 0) }
}

/** Plays or pauses the floating video for the page's own reasons, not the viewer's. */
function setPlaying(source: VideoSource, playing: boolean) {
  if (playing !== source.video.paused) return
  const release = holdSync(source)
  if (playing) void source.video.play().catch(() => undefined).finally(release)
  else { source.video.pause(); release() }
}

export function useTranscriptPiP(options: TranscriptPiPOptions) {
  const {locale}=useI18n()
  const latestOptions = useRef({...options,locale})
  useEffect(() => { latestOptions.current = {...options,locale} }, [options,locale])
  const [isOpen, setIsOpen] = useState(false)
  const [error, setError] = useState('')
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const documentWindow = useRef<Window | null>(null)
  const onWindowClose = useRef<(() => void) | null>(null)
  const themeObserver = useRef<MutationObserver | null>(null)
  const videoSource = useRef<VideoSource | null>(null)
  const videoDrawing = useRef(0)
  const videoListeners = useRef<Array<[string, () => void]>>([])
  const videoOpen = useRef(false)
  const prepareTimer = useRef(0)
  const opening = useRef(false)
  const mounted = useRef(true)
  const requestEpoch = useRef(0)
  // What the browser offers does not change while the page is open.
  const [{ documentPiP, videoMode }] = useState(() => { const documentPiP = supportsDocumentPiP(); return { documentPiP, videoMode: documentPiP ? null : videoPiPMode() } })
  const supported = documentPiP || videoMode !== null

  /** Readies the video before it is needed; again after each use. */
  const prepareVideo = useCallback(() => {
    window.clearTimeout(prepareTimer.current)
    prepareTimer.current = window.setTimeout(() => {
      if (mounted.current && !videoSource.current) videoSource.current = createVideoSource(latestOptions.current)
    }, 0)
  }, [])

  const releaseVideo = useCallback(() => {
    const source = videoSource.current
    const wasOpen = videoOpen.current
    videoOpen.current = false
    if (source) { videoSource.current = null; destroyVideoSource(source, videoDrawing.current, videoListeners.current) }
    videoListeners.current = []
    setIsOpen(false)
    if (wasOpen && mounted.current) prepareVideo()
  }, [prepareVideo])

  const close = useCallback(() => {
    requestEpoch.current += 1
    opening.current = false
    const pipWindow = documentWindow.current
    documentWindow.current = null
    if (pipWindow) {
      themeObserver.current?.disconnect()
      themeObserver.current = null
      if (onWindowClose.current) pipWindow.removeEventListener('pagehide', onWindowClose.current)
      onWindowClose.current = null
      setPortalRoot(null)
      if (!pipWindow.closed) pipWindow.close()
    }
    const source = videoSource.current
    if (source && videoOpen.current) {
      if (document.pictureInPictureElement === source.video) void document.exitPictureInPicture().catch(() => undefined)
      if (source.video.webkitPresentationMode === 'picture-in-picture') source.video.webkitSetPresentationMode?.('inline')
      releaseVideo()
    }
    setIsOpen(false)
  }, [releaseVideo])

  const openVideo = useCallback(async (epoch: number) => {
    const source = videoSource.current ?? (videoSource.current = createVideoSource(latestOptions.current))
    drawVideoFrame(source.canvas, latestOptions.current)
    videoOpen.current = true
    // Played from the click, then floated: at once when it already has a
    // frame, which it has unless the click came before it could be made ready.
    const release = holdSync(source)
    const playing = source.video.play().catch(() => undefined)
    const enter = () => {
      if (videoMode === 'webkit') { source.video.webkitSetPresentationMode!('picture-in-picture'); return Promise.resolve() }
      return source.video.requestPictureInPicture().then(() => undefined)
    }
    try {
      await (source.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? enter() : playing.then(() => hasFrame(source.video)).then(enter))
    } finally { release() }
    if (!mounted.current || requestEpoch.current !== epoch || videoSource.current !== source) {
      if (document.pictureInPictureElement === source.video) void document.exitPictureInPicture().catch(() => undefined)
      return
    }
    const floating = () => document.pictureInPictureElement === source.video || source.video.webkitPresentationMode === 'picture-in-picture'
    const onLeave = () => {
      if (floating()) return
      if (videoSource.current === source) releaseVideo()
    }
    // The floating window's own play and pause act on the recording. Closing
    // it pauses the video too, so a pause counts only if it is still floating.
    const onPlay = () => {
      if (source.syncing) return
      const control = latestOptions.current.control
      if (control && !control.recording) control.onResume()
    }
    const onPause = () => {
      if (source.syncing) return
      window.setTimeout(() => {
        if (source.syncing || videoSource.current !== source || !floating() || !source.video.paused) return
        const control = latestOptions.current.control
        if (control?.recording) control.onPause()
        else if (!control) setPlaying(source, true)
      }, 700)
    }
    videoListeners.current = [['leavepictureinpicture', onLeave], ['webkitpresentationmodechanged', onLeave], ['play', onPlay], ['pause', onPause]]
    for (const [type, listener] of videoListeners.current) source.video.addEventListener(type, listener)
    // Drawn on a timer rather than each animation frame: animation frames
    // stop while the page is in the background, and the floating window is
    // most useful then.
    window.clearInterval(videoDrawing.current)
    videoDrawing.current = window.setInterval(() => { if (videoSource.current === source) drawVideoFrame(source.canvas, latestOptions.current) }, 250)
    setIsOpen(true)
  }, [releaseVideo, videoMode])

  const open = useCallback(async () => {
    if (opening.current || documentWindow.current || videoOpen.current) return
    if (!supported) { setError('Picture-in-picture is not available in this browser.'); return }
    opening.current = true
    const epoch = ++requestEpoch.current
    setError('')
    try {
      const documentAccess = (window as PiPWindow).documentPictureInPicture
      if (documentAccess) {
        const pipWindow = await documentAccess.requestWindow({ width: 480, height: 300 })
        if (!mounted.current || requestEpoch.current !== epoch) { pipWindow.close(); return }
        documentWindow.current = pipWindow
        copyStyles(pipWindow.document)
        pipWindow.document.title = latestOptions.current.title
        themeObserver.current = new MutationObserver(() => { pipWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'light' })
        themeObserver.current.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        const root = pipWindow.document.createElement('div')
        pipWindow.document.body.append(root)
        const onClose = () => { themeObserver.current?.disconnect(); themeObserver.current = null; documentWindow.current = null; onWindowClose.current = null; setPortalRoot(null); setIsOpen(false) }
        onWindowClose.current = onClose
        pipWindow.addEventListener('pagehide', onClose, { once: true })
        setPortalRoot(root)
        setIsOpen(true)
      } else await openVideo(epoch)
    } catch (caught) {
      if (requestEpoch.current === epoch) {
        close()
        releaseVideo()
        prepareVideo()
        setError(caught instanceof Error ? caught.message : 'Picture-in-picture could not be opened.')
      }
    } finally { if (requestEpoch.current === epoch) opening.current = false }
  }, [close, openVideo, prepareVideo, releaseVideo, supported])

  const toggle = useCallback(() => { if (isOpen) close(); else void open() }, [close, isOpen, open])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(prepareTimer.current)
      close()
      const source = videoSource.current
      if (source) { videoSource.current = null; destroyVideoSource(source, videoDrawing.current, videoListeners.current) }
    }
  }, [close])
  useEffect(() => { if (videoMode) prepareVideo() }, [prepareVideo, videoMode])
  // A floating video plays while the recording does, so its play and pause
  // show what pressing them will do.
  const recordingNow = options.control?.recording
  useEffect(() => {
    const source = videoSource.current
    if (!isOpen || !source || recordingNow === undefined) return
    drawVideoFrame(source.canvas, latestOptions.current)
    setPlaying(source, recordingNow)
  }, [isOpen, recordingNow])
  useEffect(() => {
    if (options.live !== false || !isOpen) return
    const timer = window.setTimeout(close, 0)
    return () => window.clearTimeout(timer)
  }, [close, isOpen, options.live])

  const portal: ReactNode = portalRoot ? createPortal(<PiPContent options={options} close={close} />, portalRoot) : null
  return { supported, isOpen, open, close, toggle, error, portal }
}

export function TranscriptPiPButton(options: TranscriptPiPOptions) {
  const {t}=useI18n()
  const pip = useTranscriptPiP(options)
  return <><Button variant="subtle" size="sm" icon={<Icon name="external" />} aria-pressed={pip.isOpen} disabled={!pip.supported} onClick={pip.toggle}>{pip.isOpen ? t('Close picture-in-picture') : t('Picture-in-picture')}</Button>{!pip.supported && <span className="tv-pip__error">{t("Picture-in-picture is unavailable in this browser.")}</span>}{pip.error && <span className="tv-pip__error" role="alert">{t(pip.error)}</span>}{pip.portal}</>
}
