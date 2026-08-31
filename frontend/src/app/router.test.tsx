import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, RouterProvider, matchPath, useRouter } from './router'

function LocationProbe() {
  const { path } = useRouter()
  return <><Link href="/history/ses%201">Open</Link><output>{path}</output></>
}

describe('minimal application router', () => {
  it('matches and decodes named path segments', () => {
    expect(matchPath('/history/:sessionId', '/history/ses%201')).toEqual({ sessionId: 'ses 1' })
    expect(matchPath('/history/:sessionId', '/history')).toBeNull()
    expect(matchPath('/history/:sessionId', '/history/%E0%A4%A')).toBeNull()
  })

  it('navigates same-origin links without a document reload', async () => {
    window.history.replaceState(null, '', '/sessions')
    render(<RouterProvider><LocationProbe /></RouterProvider>)
    await userEvent.click(screen.getByRole('link', { name: 'Open' }))
    expect(screen.getByText('/history/ses%201')).toBeInTheDocument()
  })
})
