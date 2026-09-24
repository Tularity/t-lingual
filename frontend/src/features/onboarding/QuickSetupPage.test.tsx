import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, ToastProvider } from '../../design-system'
import { QuickSetupPage } from './QuickSetupPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), complete: vi.fn(), navigate: vi.fn(), push: vi.fn() }))
const initial = {
  defaultSourceLanguage: 'auto', defaultTargetLanguage: 'en', autoStartMicrophone: false,
  showPartialTranscripts: true, compactTranscriptLayout: false, autoArchiveHours: 24,
  interfaceLanguage: 'en', themePreference: 'system' as const, onboardingComplete: false,
}
vi.mock('../../api/client', () => ({ api: { settings: { get: mocks.get, update: mocks.update } } }))
vi.mock('../../app/auth', () => ({ useAuth: () => ({ completeOnboarding: mocks.complete }) }))
vi.mock('../../app/router', () => ({ useRouter: () => ({ navigate: mocks.navigate }) }))
vi.mock('../sessions/useRecognitionLanguages', () => ({ useRecognitionLanguages: () => ({
  choices: [{ code: 'en', label: 'English', native: 'English' }, { code: 'zh-Hans', label: 'Chinese', native: '简体中文' }],
  loading: false, error: '', retry: vi.fn(),
}) }))
function view(onComplete?: () => void) { return render(<ThemeProvider><ToastProvider><QuickSetupPage onComplete={onComplete} /></ToastProvider></ThemeProvider>) }

describe('quick setup', () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue(initial)
    mocks.update.mockReset().mockImplementation(async value => value)
    mocks.complete.mockReset().mockResolvedValue(undefined)
    mocks.navigate.mockReset()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('saves independent language defaults, marks onboarding complete, refreshes auth, then navigates', async () => {
    const user = userEvent.setup()
    view()
    expect(await screen.findByRole('heading', { name: 'Make this space yours' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Default recognition language/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /English/ }))
    await user.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ defaultSourceLanguage: 'en', defaultTargetLanguage: 'en', onboardingComplete: true })))
    const payload = mocks.update.mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('interfaceLanguage')
    expect(payload).not.toHaveProperty('themePreference')
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/sessions', { replace: true }))
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]!)
  })

  it('shows a recoverable load error and uses a supplied completion callback', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Settings unavailable'))
    const done = vi.fn()
    const user = userEvent.setup()
    view(done)
    expect(await screen.findByText('Settings unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Make this space yours' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps the form available after a failed save', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Offline'))
    const user = userEvent.setup()
    view()
    await user.click(await screen.findByRole('button', { name: 'Save and continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled()
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})
