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
    recognition: {capabilities:async()=>({configured:true,languages:['en','zh-Hans','fr'],automatic:true,diarization:true})},
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

vi.mock('../../app/auth', () => ({ useAuth: () => ({ refresh: mocks.refresh, user: {
  id: 'user', username: 'listener', displayName: 'Sam Listener', role: 'user', status: 'active',
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
} }) }))
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

  it('places the save action after the full-width settings panel without a saved-status banner', async () => {
    const user = userEvent.setup()
    const view = render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)
    await user.click(await screen.findByRole('tab', { name: 'Appearance' }))
    const panel = screen.getByRole('tabpanel')
    const footer = view.container.querySelector('.settings-footer')
    expect(panel).toHaveClass('settings-panel')
    expect(footer).not.toBeNull()
    expect(Boolean(footer && (footer.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true)
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save).toBeDisabled()
    await user.click(screen.getByRole('switch', { name: 'Compact transcripts' }))
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ compactTranscriptLayout: true })))
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
    await user.click(screen.getByRole('radio',{name:/Communication/}))
    const echoCancellation = screen.getByRole('switch', { name: 'Echo cancellation' })
    expect(echoCancellation).toHaveAttribute('aria-checked', 'true')
    await user.click(echoCancellation)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Account settings weren’t saved')).toBeInTheDocument()
    expect(loadLocalPreferences().echoCancellation).toBe(false)
  })

  it('shows the signed-in identity and links directly to security controls', async () => {
    const user = userEvent.setup()
    render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument()
    expect(screen.getAllByText('Sam Listener')).toHaveLength(2)
    expect(screen.getByText('Member since')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Security settings' }))
    expect(screen.getByRole('heading', { name: 'Your passkeys' })).toBeInTheDocument()
  })

  it('keeps recognition and personal translation defaults independent, including same-language captions', async () => {
    mocks.updateSettings.mockImplementation(async (value) => value)
    const user = userEvent.setup()
    render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)
    await user.click(await screen.findByRole('tab', { name: 'Languages' }))
    await user.click(screen.getByRole('button', { name: /Translate to/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /English/ }))
    expect(screen.getByRole('button', { name: /Translate to/ })).toHaveTextContent('English')
    expect(screen.getByRole('button', { name: /Spoken language|Default recognition language/ })).toHaveTextContent('English')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultSourceLanguage: 'en', defaultTargetLanguage: 'en' })))
  })
  it('saves the selected inactivity archive policy to the account', async () => {
    mocks.updateSettings.mockImplementation(async (value) => value)
    const user = userEvent.setup()
    render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)
    await user.click(await screen.findByRole('tab', { name: 'Sessions' }))
    const archive = screen.getByRole('combobox', { name: 'Archive after inactivity' })
    expect(archive).toHaveValue('24')
    expect(screen.getByText(/Viewing a transcript does not reset/u)).toBeInTheDocument()
    await user.selectOptions(archive, '72')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ autoArchiveHours: 72 })))
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument()
  })

  it('keeps pending changes actionable after switching to a security section', async () => {
    const user = userEvent.setup()
    render(<ThemeProvider><ToastProvider><SettingsPage /></ToastProvider></ThemeProvider>)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    await user.click(await screen.findByRole('tab', { name: 'Audio' }))
    await user.click(screen.getByRole('radio',{name:/Communication/}))
    await user.click(screen.getByRole('switch', { name: 'Echo cancellation' }))
    await user.click(screen.getByRole('tab', { name: 'Security' }))
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save changes' }).closest('.settings-footer')).not.toBeNull()
  })
})
