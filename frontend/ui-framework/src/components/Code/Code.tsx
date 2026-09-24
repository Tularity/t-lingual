import {
  forwardRef,
  useId,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import './Code.css'

export type CodeProps = HTMLAttributes<HTMLElement>

/**
 * Inline monospaced text: a session id, a header name, a status code.
 *
 * `overflow-wrap: anywhere` is the decision worth knowing about. A session id
 * contains no space, no hyphen and no other break opportunity, so a browser
 * treats it as one unbreakable word — inside a table cell or a narrow drawer it
 * pushes the whole column wider than the viewport rather than wrapping. Letting
 * it break anywhere is ugly for prose and correct for identifiers, and
 * identifiers are the only thing this component holds.
 */
export const Code = forwardRef<HTMLElement, CodeProps>(function Code(
  { className, ...rest },
  ref,
) {
  return (
    <code ref={ref} data-tl="code" className={cx('tl-code', className)} {...rest} />
  )
})

export interface CodeBlockProps extends HTMLAttributes<HTMLDivElement> {
  /** Header strip: a path, an endpoint, "Response body". */
  filename?: ReactNode
  /** Trailing slot in the header, usually a copy button. */
  actions?: ReactNode
  /** Soft-wrap long lines instead of scrolling sideways. On by default. */
  wrap?: boolean
  /** Caps the visible height at this many lines and scrolls past it. */
  maxLines?: number
}

/**
 * A block of preformatted text.
 *
 * NO SYNTAX HIGHLIGHTING, DELIBERATELY
 * ------------------------------------
 * What lands in these blocks is a session id, a config fragment or the body of
 * an API error. A highlighter would add a parser and a grammar bundle to a
 * framework that has no runtime dependencies, guess a language it was never
 * told, and colour a JSON error response in five hues that mean nothing about
 * what went wrong. Plain text at a comfortable measure is the better answer,
 * and it keeps the contrast story to a single foreground token.
 *
 * Wrapping is on by default because the content is usually one long line and a
 * horizontally scrolling error message is an error message nobody reads.
 *
 * The `<pre>` carries `tabIndex={0}` so that a block which does end up
 * scrolling — `maxLines` is set, or wrapping was turned off — can be scrolled
 * from the keyboard (WCAG 2.2 SC 2.1.1). When a filename is present it also
 * becomes a named group, so arriving there by Tab announces which block it is
 * rather than reading the first line of an opaque payload.
 */
export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(function CodeBlock(
  { filename, actions, wrap = true, maxLines, className, children, style, ...rest },
  ref,
) {
  const filenameId = useId()
  const hasHeader = filename != null || actions != null

  return (
    <div
      ref={ref}
      data-tl="code-block"
      data-wrap={wrap || undefined}
      className={cx('tl-code-block', className)}
      style={
        maxLines != null
          ? ({ ...style, '--_max-lines': maxLines } as CSSProperties)
          : style
      }
      {...rest}
    >
      {hasHeader && (
        <div className="tl-code-block__header">
          {filename != null && (
            <span id={filenameId} className="tl-code-block__filename">
              {filename}
            </span>
          )}
          {actions != null && <span className="tl-code-block__actions">{actions}</span>}
        </div>
      )}

      <pre
        className="tl-code-block__pre"
        data-clamped={maxLines != null || undefined}
        tabIndex={0}
        role={filename != null ? 'group' : undefined}
        aria-labelledby={filename != null ? filenameId : undefined}
      >
        <code className="tl-code-block__code">{children}</code>
      </pre>
    </div>
  )
})
