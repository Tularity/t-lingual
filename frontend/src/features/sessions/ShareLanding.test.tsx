import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ShareLanding } from './ShareLanding'

const mocks = vi.hoisted(() => ({ redeem: vi.fn(), navigate: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { sharing: { redeem: mocks.redeem } } }))
vi.mock('../../app/router', () => ({ useRouter: () => ({ navigate: mocks.navigate }) }))
vi.mock('../../app/AppShell', () => ({ Brand: () => <span>T Lingual</span> }))

const languageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'language')

describe('shared link entry', () => {
  beforeEach(() => {
    mocks.redeem.mockReset()
    mocks.navigate.mockReset()
  })
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    if (languageDescriptor) Object.defineProperty(navigator, 'language', languageDescriptor)
  })

  it('removes the fragment before redeeming and opens the shared session with a supported browser language', async () => {
    window.history.replaceState(null, '', '/share#SENSITIVE_INVITE_TOKEN')
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'fr-FR' })
    mocks.redeem.mockImplementation(async () => {
      expect(window.location.hash).toBe('')
      expect(window.location.pathname).toBe('/share')
      return { sessionId: 'session_shared' }
    })

    render(<ShareLanding />)

    await waitFor(() => expect(mocks.redeem).toHaveBeenCalledWith('SENSITIVE_INVITE_TOKEN', 'fr'))
    expect(mocks.navigate).toHaveBeenCalledWith('/shared/session_shared', { replace: true })
    expect(window.location.href).not.toContain('SENSITIVE_INVITE_TOKEN')
  })

  it('keeps the token only in memory for a retry and defaults unknown locales to English', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/share#ONE_TIME_LINK_TOKEN')
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'xx-XX' })
    mocks.redeem.mockRejectedValueOnce(new Error('Link temporarily unavailable')).mockResolvedValueOnce({ sessionId: 'session_after_retry' })

    render(<ShareLanding />)
    expect(await screen.findByText('Link temporarily unavailable')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(mocks.redeem).toHaveBeenCalledTimes(2))
    expect(mocks.redeem).toHaveBeenNthCalledWith(2, 'ONE_TIME_LINK_TOKEN', 'en')
    expect(mocks.navigate).toHaveBeenCalledWith('/shared/session_after_retry', { replace: true })
  })
})
