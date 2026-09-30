import { afterSignIn, rememberShare } from './pendingShare'

const mocks = vi.hoisted(() => ({ join: vi.fn() }))
vi.mock('../api/client', () => ({ api: { sharing: { join: mocks.join } } }))

describe('a link waiting for sign-in', () => {
  beforeEach(() => { mocks.join.mockReset(); window.sessionStorage.clear() })

  it('goes to the workspace when nothing is waiting', async () => {
    expect(await afterSignIn()).toBe('/sessions')
    expect(mocks.join).not.toHaveBeenCalled()
  })

  it('opens the waiting link once, as the person who just signed in', async () => {
    mocks.join.mockResolvedValue({ sessionId: 'ses/1' })
    rememberShare('TOKEN')
    expect(await afterSignIn()).toBe('/sessions/ses%2F1')
    expect(mocks.join).toHaveBeenCalledWith('TOKEN')
    expect(await afterSignIn()).toBe('/sessions')
    expect(mocks.join).toHaveBeenCalledTimes(1)
  })

  it('falls back to the workspace when the link no longer opens', async () => {
    mocks.join.mockRejectedValue(new Error('The requested resource was not found.'))
    rememberShare('GONE')
    expect(await afterSignIn()).toBe('/sessions')
    expect(window.sessionStorage.getItem('t-lingual:pending-share')).toBeNull()
  })
})
