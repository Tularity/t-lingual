import { render, screen, within } from '@testing-library/react'
import { Markdown, safeMarkdownImage, safeMarkdownLink } from './Markdown'

describe('safe Markdown rendering', () => {
  it('renders headings, lists, quotes, code, links and GFM tables as React nodes', () => {
    render(<Markdown source={'# Guide\n\n- First\n- Second\n\n> Careful\n\n```ts\nconst x = 1\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n[Read more](/docs)'} />)
    expect(screen.getByRole('heading', { name: 'Guide' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Careful').closest('blockquote')).toBeInTheDocument()
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('B')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Read more' })).toHaveAttribute('href', `${location.origin}/docs`)
  })

  it('does not render raw HTML or active URL schemes and never loads third-party images', () => {
    const source = '<script>alert(1)</script>\n\n<img src="/evil.svg" onerror="alert(1)">\n\n[Run](javascript:alert(1)) [Data](data:text/html,boom) [Safe](https://example.org/help)\n\n![Remote](https://example.org/pixel.png) ![Local](/brand/tularity.svg)'
    const { container } = render(<Markdown source={source} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: 'Safe' })).toHaveAttribute('target', '_blank')
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Local' })).toHaveAttribute('src', `${location.origin}/brand/tularity.svg`)
    expect(screen.getByText('Remote')).toBeInTheDocument()
    expect(safeMarkdownLink('java\nscript:alert(1)')).toBeUndefined()
    expect(safeMarkdownImage('data:image/svg+xml,<svg/>')).toBeUndefined()
    expect(safeMarkdownImage('//example.org/pixel.png')).toBeUndefined()
  })
})
