import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cx } from '../../utils/cx'
import './Markdown.css'

function hasControl(value: string): boolean {
  return Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}
function safeUrl(value: string | undefined, base: string): URL | null {
  if (!value || hasControl(value)) return null
  try { return new URL(value, base) } catch { return null }
}

/** Links may navigate to HTTP(S), email, or a same-page anchor. Never execute URL schemes. */
export function safeMarkdownLink(value: string | undefined, base = typeof location === 'undefined' ? 'https://example.invalid/' : location.href): string | undefined {
  if (value?.startsWith('#') && !hasControl(value)) return value
  const url = safeUrl(value, base)
  if (!url || !['http:', 'https:', 'mailto:'].includes(url.protocol)) return undefined
  return url.href
}

/** Image requests are restricted to the current origin, including in a shared document. */
export function safeMarkdownImage(value: string | undefined, base = typeof location === 'undefined' ? 'https://example.invalid/' : location.href): string | undefined {
  const url = safeUrl(value, base)
  const origin = safeUrl(base, base)?.origin
  if (!url || !origin || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return undefined
  return url.href
}

const components: Components = {
  a({ href, children, title }) {
    const safe = safeMarkdownLink(href)
    if (!safe) return <span className="tl-markdown__unsafe-link">{children}</span>
    const external = new URL(safe, location.href).origin !== location.origin
    return <a href={safe} title={title} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a>
  },
  img({ src, alt }) {
    const safe = safeMarkdownImage(src)
    return safe ? <img src={safe} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
      : <span className="tl-markdown__image-blocked">{alt ?? ''}</span>
  },
}

export interface MarkdownProps {
  source: string
  className?: string
  label?: string
}
/** CommonMark/GFM as React nodes. Embedded HTML is ignored; scripts and remote images never load. */
export function Markdown({ source, className, label }: MarkdownProps) {
  return <div className={cx('tl-markdown', className)} aria-label={label}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{source}</ReactMarkdown>
  </div>
}
