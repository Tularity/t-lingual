import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RegistrationHelpDialog } from './RegistrationHelpDialog'

const mocks = vi.hoisted(() => ({ content: vi.fn(), me: vi.fn(), siteSettings: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { site: { content: mocks.content }, auth: { me: mocks.me }, admin: { siteSettings: mocks.siteSettings } } }))
const markdown = '# Getting started\n\n1. Ask your administrator for a code.\n2. Create a passkey.\n\n[Guide](/help) [Bad](javascript:alert(1))\n\n![Remote pixel](https://remote.example.invalid/pixel.png)\n\n<script>alert("unsafe")</script>'

beforeEach(() => {
  mocks.content.mockReset().mockResolvedValue({ registrationHelpMarkdown: markdown })
  mocks.me.mockReset()
  mocks.siteSettings.mockReset()
})

describe('public registration help dialog', () => {
  it('loads without an account API, uses the full dialog, and renders sanitized Markdown', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    render(<RegistrationHelpDialog open onClose={close} />)
    const dialog = await screen.findByRole('dialog', { name: 'How to register' })
    expect(dialog).toHaveAttribute('data-size', 'full')
    expect(await screen.findByRole('heading', { name: 'Getting started' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toHaveTextContent('Create a passkey')
    expect(screen.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', new URL('/help', window.location.href).href)
    expect(screen.queryByRole('link', { name: 'Bad' })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Remote pixel' })).not.toBeInTheDocument()
    expect(screen.queryByText(/unsafe/)).not.toBeInTheDocument()
    expect(mocks.content).toHaveBeenCalledOnce()
    expect(mocks.me).not.toHaveBeenCalled()
    expect(mocks.siteSettings).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not fetch while closed and retries a public content failure in place', async () => {
    mocks.content.mockRejectedValueOnce(new Error('Help temporarily unavailable')).mockResolvedValueOnce({ registrationHelpMarkdown: markdown })
    const view = render(<RegistrationHelpDialog open={false} onClose={vi.fn()} />)
    expect(mocks.content).not.toHaveBeenCalled()
    view.rerender(<RegistrationHelpDialog open onClose={vi.fn()} />)
    expect(await screen.findByText('Help temporarily unavailable')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(mocks.content).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('heading', { name: 'Getting started' })).toBeInTheDocument()
    expect(mocks.me).not.toHaveBeenCalled()
    expect(mocks.siteSettings).not.toHaveBeenCalled()
  })
})
