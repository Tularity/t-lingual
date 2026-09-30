import { createHash } from 'node:crypto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import { SiteSettingsPanel } from './SiteSettingsPanel'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), authorize: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { admin: { siteSettings: mocks.get, updateSiteSettings: mocks.update } } }))
vi.mock('../../app/passkeyAuthorization', () => ({ authorizePasskeyAction: mocks.authorize }))
const original = { registrationHelpMarkdown: '# Registration\n\nBring a passkey.', codeAttemptsPerMinute: 3, draftTranslationIntervalMs: 1000 }
const expectedScope = (input: typeof original) => `admin:site-settings:update:${createHash('sha256').update(JSON.stringify({ registrationHelpMarkdown: input.registrationHelpMarkdown, codeAttemptsPerMinute: input.codeAttemptsPerMinute, draftTranslationIntervalMs: input.draftTranslationIntervalMs }), 'utf8').digest('hex')}`
const renderPanel = () => render(<ToastProvider><SiteSettingsPanel /></ToastProvider>)

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(original)
  mocks.update.mockReset().mockImplementation(async (_token: string, input: typeof original) => input)
  mocks.authorize.mockReset().mockResolvedValue({ authorizationToken: 'verified-grant', expiresAt: 'later' })
})

describe('site settings administration', () => {
  it('binds normalized Markdown, rate and translation pace to the exact scope, then PUTs only after verification', async () => {
    let finishAuthorization!: (grant: { authorizationToken: string; expiresAt: string }) => void
    mocks.authorize.mockImplementation(() => new Promise(resolve => { finishAuthorization = resolve }))
    renderPanel()
    const editor = await screen.findByRole('textbox', { name: 'Registration instructions (Markdown)' })
    fireEvent.change(editor, { target: { value: '# Updated\r\n\r\n[Guide](/help)' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Attempts per minute per IP' }), { target: { value: '5' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Least time between requests (ms)' }), { target: { value: '1500' } })
    await userEvent.click(screen.getByRole('button', { name: 'Verify and save' }))
    const input = { registrationHelpMarkdown: '# Updated\n\n[Guide](/help)', codeAttemptsPerMinute: 5, draftTranslationIntervalMs: 1500 }
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith(expectedScope(input)))
    expect(mocks.update).not.toHaveBeenCalled()
    finishAuthorization({ authorizationToken: 'verified-grant', expiresAt: 'later' })
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('verified-grant', input))
    expect(screen.getByRole('textbox', { name: 'Registration instructions (Markdown)' })).toHaveValue(input.registrationHelpMarkdown)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify and save' })).toBeDisabled())
  })

  it('never requests a passkey or writes an invalid draft', async () => {
    renderPanel()
    const editor = await screen.findByRole('textbox', { name: 'Registration instructions (Markdown)' })
    fireEvent.change(editor, { target: { value: ' ' } })
    expect(screen.getByRole('button', { name: 'Verify and save' })).toBeDisabled()
    fireEvent.change(editor, { target: { value: '# Valid text' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Attempts per minute per IP' }), { target: { value: '11' } })
    expect(screen.getByRole('button', { name: 'Verify and save' })).toBeDisabled()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Attempts per minute per IP' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Least time between requests (ms)' }), { target: { value: '10001' } })
    expect(screen.getByRole('button', { name: 'Verify and save' })).toBeDisabled()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('keeps the edited draft if verification or server PUT fails', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Server rejected the update'))
    renderPanel()
    const editor = await screen.findByRole('textbox', { name: 'Registration instructions (Markdown)' })
    fireEvent.change(editor, { target: { value: '# My draft' } })
    await userEvent.click(screen.getByRole('button', { name: 'Verify and save' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    expect(editor).toHaveValue('# My draft')
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled()
    expect(mocks.get).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(editor).toHaveValue(original.registrationHelpMarkdown)
    mocks.authorize.mockRejectedValueOnce(new DOMException('Cancelled', 'NotAllowedError'))
    fireEvent.change(editor, { target: { value: '# Try again' } })
    await userEvent.click(screen.getByRole('button', { name: 'Verify and save' }))
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledTimes(2))
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(editor).toHaveValue('# Try again')
  })
})
