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

export interface TranscriptPiPOptions {
  locale?: ResolvedLanguage
  segments: Segment[]
  title: string
  sourceLanguage: string
  targetLanguage: string
  paused?: boolean
  live?: boolean
}

function supportsDocumentPiP() {
  return typeof window !== 'undefined' && !!(window as PiPWindow).documentPictureInPicture?.requestWindow
}

function supportsVideoPiP() {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled
    && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
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
  return <div ref={rootRef} className="tv-pip" aria-label={options.title}>
    <section className="tv-pip__pane" aria-label={t("Original speech")}><header className="tv-pip__head"><div><LanguageLabel code={sourceLanguage} /><span>{t("Original")}</span>{options.paused && <span>{t("Paused")}</span>}</div><Button size="xs" variant="ghost" iconOnly icon={<Icon name="close" size={13} />} aria-label={t("Close transcript picture-in-picture")} onClick={close} /></header><div className="tv-pip__body">{latest.length === 0 ? <p className="tv-pip__empty">{t("Waiting for speech…")}</p> : latest.map(segment => <article key={`${segment.sessionId}:${segment.sequence}`} className="tv-pip__row"><p dir="auto">{segment.sourceText}{!segment.final && <span className="tv-row__caret" aria-hidden="true" />}</p></article>)}</div></section>
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
    context.fillText(`${pane.code === 'auto' ? t('Mixed languages') : options.locale==='zh-Hans'?new Intl.DisplayNames(['zh-Hans'],{type:'language'}).of(pane.code):languageName(pane.code)} · ${pane.label}${index === 0 && options.paused ? ` · ${t('Paused')}` : ''}`, 45, top + 23)
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

interface VideoState {
  video: HTMLVideoElement
  stream: MediaStream
  frame: number
  onLeave: () => void
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
  const videoState = useRef<VideoState | null>(null)
  const opening = useRef(false)
  const mounted = useRef(true)
  const requestEpoch = useRef(0)
  const supported = supportsDocumentPiP() || supportsVideoPiP()

  const releaseVideo = useCallback(() => {
    const state = videoState.current
    if (!state) return
    videoState.current = null
    cancelAnimationFrame(state.frame)
    state.video.removeEventListener('leavepictureinpicture', state.onLeave)
    state.stream.getTracks().forEach((track) => track.stop())
    state.video.pause()
    state.video.srcObject = null
    state.video.remove()
    setIsOpen(false)
  }, [])

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
    if (videoState.current) {
      if (document.pictureInPictureElement === videoState.current.video) void document.exitPictureInPicture().catch(() => undefined)
      releaseVideo()
    }
    setIsOpen(false)
  }, [releaseVideo])

  const open = useCallback(async () => {
    if (opening.current || documentWindow.current || videoState.current) return
    if (!supported) { setError('Picture-in-picture is not available in this browser.'); return }
    opening.current = true
    const epoch = ++requestEpoch.current
    setError('')
    try {
      const documentPiP = (window as PiPWindow).documentPictureInPicture
      if (documentPiP) {
        const pipWindow = await documentPiP.requestWindow({ width: 480, height: 300 })
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
      } else {
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 400
        drawVideoFrame(canvas, latestOptions.current)
        const stream = canvas.captureStream(12)
        const video = document.createElement('video')
        video.muted = true; video.playsInline = true; video.autoplay = true
        video.srcObject = stream
        video.className = 'tv-pip-video-source'
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0'
        document.body.append(video)
        const state: VideoState = { video, stream, frame: 0, onLeave: releaseVideo }
        videoState.current = state
        const draw = () => {
          if (videoState.current !== state) return
          drawVideoFrame(canvas, latestOptions.current)
          state.frame = requestAnimationFrame(draw)
        }
        draw()
        await video.play()
        if (!mounted.current || requestEpoch.current !== epoch || videoState.current !== state) return
        await video.requestPictureInPicture()
        if (!mounted.current || requestEpoch.current !== epoch || videoState.current !== state) {
          if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined)
          return
        }
        video.addEventListener('leavepictureinpicture', state.onLeave, { once: true })
        setIsOpen(true)
      }
    } catch (caught) {
      if (requestEpoch.current === epoch) {
        close()
        setError(caught instanceof Error ? caught.message : 'Picture-in-picture could not be opened.')
      }
    } finally { if (requestEpoch.current === epoch) opening.current = false }
  }, [close, releaseVideo, supported])

  const toggle = useCallback(() => { if (isOpen) close(); else void open() }, [close, isOpen, open])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; close() } }, [close])
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
