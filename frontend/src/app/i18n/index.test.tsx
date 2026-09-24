import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, ToastProvider, useTheme } from '../../design-system'
import { I18nProvider, I18nTextProvider, resolveInterfaceLanguage, translate, useI18n } from './index'

const mocks = vi.hoisted(() => ({
  user: null as null | { id: string },
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock('../auth', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('../../api/client', () => ({ api: { settings: { get: mocks.getSettings, updateInterface: mocks.updateSettings } } }))
function Probe() {
  const { t, locale, preference, setPreference, setThemePreference } = useI18n()
  const { mode, resolved } = useTheme()
  return <><output data-testid="locale">{locale}:{preference}:{mode}:{resolved}</output><span>{t('Settings')}</span><button onClick={() => setPreference('zh-Hans')}>Chinese interface</button><button onClick={() => setThemePreference('dark')}>Dark theme</button></>
}
function harness() { return <ThemeProvider><ToastProvider><I18nProvider><Probe /></I18nProvider></ToastProvider></ThemeProvider> }

describe('interface preferences', () => {
  beforeEach(() => {
    mocks.user = null
    mocks.getSettings.mockReset().mockImplementation(async () => ({ interfaceLanguage: mocks.user?.id === 'alice' ? 'zh-Hans' : 'en', themePreference: mocks.user?.id === 'alice' ? 'dark' : 'light' }))
    mocks.updateSettings.mockReset().mockImplementation(async (value) => value)
    localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

  it('provides translated text to an isolated root without account reads or persistence', () => {
    function TextProbe() {
      const { t, locale, setPreference } = useI18n()
      return <><output>{locale}: {t('Settings')}</output><button onClick={() => setPreference('en')}>Change</button></>
    }
    render(<I18nTextProvider locale="zh-Hans"><TextProbe /></I18nTextProvider>)
    expect(screen.getByText('zh-Hans: 设置')).toBeInTheDocument()
    expect(mocks.getSettings).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })
  it('resolves the first supported system language and interpolates translated strings', () => {
    expect(resolveInterfaceLanguage('system', ['de-DE', 'zh-TW', 'en-AU'])).toBe('de')
    expect(resolveInterfaceLanguage('system', ['fr-FR', 'en-AU'])).toBe('fr')
    expect(translate('zh-Hans', 'Microphone {number}', { number: 2 })).toBe('麦克风 2')
  })

  it('restores anonymous language choices without inheriting an account choice on logout', async () => {
    const user = userEvent.setup()
    const view = render(harness())
    await user.click(screen.getByRole('button', { name: 'Chinese interface' }))
    expect(localStorage.getItem('t-lingual.interface.anonymous')).toContain('"language":"zh-Hans"')
    view.unmount()
    const fresh = render(harness())
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('zh-Hans:zh-Hans:system:light'))
    mocks.user = { id: 'bob' }
    fresh.rerender(harness())
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en:en:light:light'))
    mocks.user = null
    fresh.rerender(harness())
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('zh-Hans:zh-Hans:system:light'))
  })
  it('ignores a late settings response from the previous account', async () => {
    let resolveAlice!: (value: { interfaceLanguage: string; themePreference: string }) => void
    mocks.getSettings.mockImplementation(() => mocks.user?.id === 'alice'
      ? new Promise((resolve) => { resolveAlice = resolve })
      : Promise.resolve({ interfaceLanguage: 'en', themePreference: 'light' }))
    mocks.user = { id: 'alice' }
    const view = render(harness())
    mocks.user = { id: 'bob' }
    view.rerender(harness())
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en:en:light:light'))
    await act(async () => resolveAlice({ interfaceLanguage: 'zh-Hans', themePreference: 'dark' }))
    expect(screen.getByTestId('locale')).toHaveTextContent('en:en:light:light')
    expect(localStorage.getItem('t-lingual.interface.bob')).toContain('"language":"en"')
  })
  it('keeps preferences scoped to each account and applies changes without remounting the child', async () => {
    mocks.user = { id: 'alice' }
    const view = render(harness())
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('zh-Hans:zh-Hans:dark:dark'))
    expect(screen.getByText('设置')).toBeInTheDocument()
    mocks.user = { id: 'bob' }
    view.rerender(harness())
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en:en:light:light'))
    expect(screen.getByText('Settings')).toBeInTheDocument()
    const node = screen.getByTestId('locale')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Chinese interface' }))
    expect(screen.getByTestId('locale')).toBe(node)
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ interfaceLanguage: 'zh-Hans', themePreference: 'light' })))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dark theme' }))
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ interfaceLanguage: 'zh-Hans', themePreference: 'dark' })))
    expect(localStorage.getItem('t-lingual.interface.alice')).not.toContain('"language":"en"')
    expect(localStorage.getItem('t-lingual.interface.bob')).toContain('"language":"zh-Hans"')
    await act(async () => { mocks.user = null; view.rerender(harness()) })
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en:system:system:light'))
  })
})
