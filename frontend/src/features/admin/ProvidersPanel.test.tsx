import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import { ProvidersPanel, providerUpdateScope } from './ProvidersPanel'

const mocks = vi.hoisted(() => ({ providers: vi.fn(), updateProviders: vi.fn(), authorize: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { admin: { providers: mocks.providers, updateProviders: mocks.updateProviders } } }))
vi.mock('../../app/passkeyAuthorization', () => ({ authorizePasskeyAction: mocks.authorize }))

describe('provider administration', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.providers.mockResolvedValue({ asrUrl: '', translatorUrl: '', asrConfigured: false, translatorConfigured: false })
    mocks.authorize.mockResolvedValue({ authorizationToken: 'grant', expiresAt: 'soon' })
    mocks.updateProviders.mockImplementation(async (_grant: string, input: { asrUrl: string; translatorUrl: string }) => ({ ...input, asrConfigured: !!input.asrUrl, translatorConfigured: !!input.translatorUrl }))
  })

  it('hashes compact URL JSON with the fixed field order', async () => {
    expect(await providerUpdateScope({ asrUrl: ' https://asr.example.test ', translatorUrl: '' }))
      .toBe('admin:providers:update:6a1d1e3bb209524a6ec7ab097fe208300bf9620101681fa54a1b08731ac57c8f')
  })

  it('reads current configuration and saves only after scoped passkey verification', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><ProvidersPanel /></ToastProvider>)
    expect(await screen.findAllByText('Not configured')).toHaveLength(2)
    expect(mocks.updateProviders).not.toHaveBeenCalled()

    await user.type(screen.getByRole('textbox', { name: 'ASR URL' }), 'https://asr.example.test')
    await user.type(screen.getByRole('textbox', { name: 'Translator URL' }), 'https://translator.example.test')
    await user.click(screen.getByRole('button', { name: 'Verify and save' }))

    await waitFor(() => expect(mocks.updateProviders).toHaveBeenCalledWith('grant', { asrUrl: 'https://asr.example.test', translatorUrl: 'https://translator.example.test' }))
    expect(mocks.authorize).toHaveBeenCalledWith(await providerUpdateScope({ asrUrl: 'https://asr.example.test', translatorUrl: 'https://translator.example.test' }))
    expect(await screen.findAllByText('Configured')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Verify and save' })).toBeDisabled()
  })

  it('does not write after a cancelled authorization and can discard edits', async () => {
    mocks.authorize.mockRejectedValueOnce(new DOMException('Cancelled', 'NotAllowedError'))
    const user = userEvent.setup()
    render(<ToastProvider><ProvidersPanel /></ToastProvider>)
    await screen.findAllByText('Not configured')
    await user.type(screen.getByRole('textbox', { name: 'ASR URL' }), 'https://asr.example.test')
    await user.click(screen.getByRole('button', { name: 'Verify and save' }))
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledOnce())
    expect(mocks.updateProviders).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('textbox', { name: 'ASR URL' })).toHaveValue('')
  })
})
