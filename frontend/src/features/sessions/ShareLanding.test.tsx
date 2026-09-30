import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ShareLanding } from './ShareLanding'

const mocks = vi.hoisted(() => ({ redeem: vi.fn(), join: vi.fn(), navigate: vi.fn(), status: 'anonymous' as string }))
vi.mock('../../api/client', () => ({ api: { sharing: { redeem: mocks.redeem, join: mocks.join } } }))
vi.mock('../../app/router', () => ({ useRouter: () => ({ navigate: mocks.navigate }) }))
vi.mock('../../app/auth', () => ({ useAuth: () => ({ status: mocks.status }) }))
vi.mock('../../app/AppShell', () => ({ Brand: () => <span>T Lingual</span> }))

const languageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'language')

describe('shared link entry', () => {
  beforeEach(() => {
    mocks.redeem.mockReset()
    mocks.join.mockReset()
    mocks.navigate.mockReset()
    mocks.status = 'anonymous'
  })
  afterEach(() => {
    window.sessionStorage.clear()
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

  it('opens a link as the signed-in person, once the sign-in state is known', async () => {
    window.history.replaceState(null, '', '/share#MEMBER_TOKEN')
    mocks.status = 'loading'
    mocks.join.mockResolvedValue({ sessionId: 'session_joined' })
    const { rerender } = render(<ShareLanding />)
    expect(mocks.join).not.toHaveBeenCalled()
    expect(mocks.redeem).not.toHaveBeenCalled()
    mocks.status = 'authenticated'
    rerender(<ShareLanding />)
    await waitFor(() => expect(mocks.join).toHaveBeenCalledWith('MEMBER_TOKEN'))
    expect(mocks.navigate).toHaveBeenCalledWith('/sessions/session_joined', { replace: true })
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('asks a guest to sign in for a link that is only for signed-in people, and keeps it for afterwards', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/share#MEMBERS_ONLY_TOKEN')
    mocks.redeem.mockRejectedValue(Object.assign(new Error('Sign in to open this link.'), { code: 'SIGN_IN_REQUIRED' }))
    render(<ShareLanding />)
    expect(await screen.findByRole('heading', { name: 'Sign in to open this conversation' })).toBeInTheDocument()
    expect(window.location.href).not.toContain('MEMBERS_ONLY_TOKEN')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(mocks.navigate).toHaveBeenCalledWith('/login')
    expect(window.sessionStorage.getItem('t-lingual:pending-share')).toBe('MEMBERS_ONLY_TOKEN')
  })
})
