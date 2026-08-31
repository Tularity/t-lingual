import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, ToastProvider } from '../../design-system'
import { loadLocalPreferences } from '../../app/preferences'
import { removeBrowserStorage } from '../../platform/storage'
import { SettingsPage } from './SettingsPage'

const mocks = vi.hoisted(() => ({
  authorizationBegin: vi.fn(),
  authorizationFinish: vi.fn(),
  revokeSession: vi.fn(),
  updateSettings: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  getPasskey: vi.fn(),
  createPasskey: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    mode: 'mock',
    settings: {
      get: vi.fn().mockResolvedValue({
        defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false,
        showPartialTranscripts: true, compactTranscriptLayout: false,
      }),
      update: mocks.updateSettings,
    },
    passkeys: {
      list: vi.fn().mockResolvedValue([
        { id: 'key_a', userId: 'user', name: 'Primary key', createdAt: '2026-08-01T00:00:00Z', lastUsedAt: null },
        { id: 'key_b', userId: 'user', name: 'Backup key', createdAt: '2026-08-02T00:00:00Z', lastUsedAt: null },
      ]),
      authorizationBegin: mocks.authorizationBegin,
      authorizationFinish: mocks.authorizationFinish,
      registrationBegin: vi.fn(),
      registrationFinish: vi.fn(),
      remove: vi.fn(),
    },
    browserSessions: {
      list: vi.fn().mockResolvedValue([
        { id: 'current', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', lastSeen: '2026-09-01T01:00:00Z', userAgent: 'Current Chrome', ipAddress: '203.0.113.4', current: true },
        { id: 'other', createdAt: '2026-08-30T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', lastSeen: '2026-09-01T00:00:00Z', userAgent: 'Other Safari', ipAddress: '198.51.100.7', current: false },
      ]),
      revoke: mocks.revokeSession,
      revokeOthers: vi.fn(),
    },
  },
}))

vi.mock('../../api/webauthn', () => ({ getPasskey: mocks.getPasskey, createPasskey: mocks.createPasskey }))

vi.mock('../../app/auth', () => ({ useAuth: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../app/router', () => ({ useRouter: () => ({ navigate: mocks.navigate }) }))

describe('settings security session actions', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }))
    mocks.authorizationBegin.mockReset().mockResolvedValue({
      ceremonyToken: 'ceremony', options: { publicKey: {} }, expiresAt: 'soon',
    })
    mocks.authorizationFinish.mockReset().mockResolvedValue({ authorizationToken: 'verified-grant', expiresAt: 'soon' })
    mocks.getPasskey.mockReset().mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    mocks.createPasskey.mockReset().mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    mocks.revokeSession.mockReset().mockResolvedValue(undefined)
    mocks.updateSettings.mockReset().mockResolvedValue({
      defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false,
      showPartialTranscripts: true, compactTranscriptLayout: false,
    })
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.navigate.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    removeBrowserStorage('local', 't-lingual.local-preferences')
  })

  it('steps up before revoking another browser but lets the current browser sign itself out', async () => {
    const user = userEvent.setup()
    render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)

    await user.click(await screen.findByRole('tab', { name: 'Security' }))
    await user.click(screen.getByRole('button', { name: 'Sign out Other Safari' }))
    await user.click(screen.getByRole('button', { name: 'Verify and sign out' }))
    await waitFor(() => expect(mocks.revokeSession).toHaveBeenCalledWith('other', 'verified-grant'))
    expect(mocks.authorizationBegin).toHaveBeenCalledTimes(1)
    expect(mocks.authorizationFinish).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Sign out this browser' }))
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(mocks.revokeSession).toHaveBeenLastCalledWith('current', undefined))
    expect(mocks.authorizationBegin).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.navigate).toHaveBeenCalledWith('/login', { replace: true })
  })

  it('keeps browser-only microphone choices when account settings fail to save', async () => {
    mocks.updateSettings.mockRejectedValue(new Error('Settings service unavailable'))
    const user = userEvent.setup()
    render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)

    await user.click(await screen.findByRole('tab', { name: 'Audio' }))
    const echoCancellation = screen.getByRole('switch', { name: 'Echo cancellation' })
    expect(echoCancellation).toHaveAttribute('aria-checked', 'true')
    await user.click(echoCancellation)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Account settings weren’t saved')).toBeInTheDocument()
    expect(loadLocalPreferences().echoCancellation).toBe(false)
  })
})
