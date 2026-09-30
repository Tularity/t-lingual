import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Presence, PresenceList } from '../../api/contracts'
import { PresenceStack } from './PresenceStack'

vi.mock('../../api/client', () => ({ api: {
  sharing: { personAvatarUrl: (sessionId: string, userId: string) => `/people/${sessionId}/${userId}.png` },
  account: { avatarUrl: () => '/own.png' },
} }))

const person = (key: string, name: string, extra: Partial<Presence> = {}): Presence => ({ key, name, kind: 'user', userId: `usr_${key}`, isMe: false, ...extra })

describe('who else has a session open', () => {
  it('shows nothing while nobody else is here', () => {
    const alone: PresenceList = { people: [person('me', 'Olive', { isMe: true })], total: 1 }
    const { container } = render(<PresenceStack sessionId="ses_1" presence={alone} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows faces, with the rest counted and listed in full on a click', async () => {
    const user = userEvent.setup()
    const presence: PresenceList = {
      people: [
        person('me', 'Olive', { isMe: true }),
        person('priya', 'Priya', { recording: true, avatarVersion: 7 }),
        { key: 'guest', name: 'Guest', kind: 'guest', isMe: false },
        person('jonas', 'Jonas'), person('sofia', 'Sofia'), person('hana', 'Hana'),
      ],
      total: 8,
    }
    render(<PresenceStack sessionId="ses_1" presence={presence} />)
    const stack = screen.getByRole('button', { name: '8 people here' })
    // Others first, then oneself; four faces, and the rest as a count.
    expect(screen.getByRole('img', { name: 'Priya · Recording' })).toHaveAttribute('src', '/people/ses_1/usr_priya.png')
    expect(screen.getByRole('img', { name: 'Guest' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Olive (you)' })).not.toBeInTheDocument()
    expect(screen.getByText('4 more')).toBeInTheDocument()

    await user.click(stack)
    expect(await screen.findByText('Here now')).toBeInTheDocument()
    expect(screen.getByText('Olive')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Recording')).toBeInTheDocument()
    expect(screen.getByText('And 2 more')).toBeInTheDocument()
  })
})
