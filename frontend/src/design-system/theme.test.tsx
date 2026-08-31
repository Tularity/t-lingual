import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, useTheme } from './theme'
import { removeBrowserStorage } from '../platform/storage'

function ThemeProbe() {
  const { mode, resolved, setMode } = useTheme()
  return <>
    <output aria-label="Theme mode">{mode}</output>
    <output aria-label="Resolved theme">{resolved}</output>
    <button type="button" onClick={() => setMode('dark')}>Use dark</button>
  </>
}

describe('theme storage resilience', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    removeBrowserStorage('local', 't-lingual.theme')
  })

  it('starts and changes theme when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })

    render(<ThemeProvider><ThemeProbe /></ThemeProvider>)

    expect(screen.getByLabelText('Theme mode')).toHaveTextContent('system')
    expect(screen.getByLabelText('Resolved theme')).toHaveTextContent('light')
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'))

    await userEvent.click(screen.getByRole('button', { name: 'Use dark' }))
    expect(screen.getByLabelText('Theme mode')).toHaveTextContent('dark')
    expect(screen.getByLabelText('Resolved theme')).toHaveTextContent('dark')
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
  })
})
