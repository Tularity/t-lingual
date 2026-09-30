import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, ToastProvider } from '../design-system'
import { RouterProvider } from './router'
import { AppShell, nextThemeMode } from './AppShell'
import { WorkspacesProvider, pinnedFirst, sidebarWorkspaces } from './workspaces'

const auth = vi.hoisted(() => ({
  logout: vi.fn(async () => undefined),
  user: {
    id: 'usr_1',
    username: 'listener',
    displayName: 'Listener',
    role: 'user' as const,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
}))

vi.mock('./auth', () => ({
  useAuth: () => ({ user: auth.user, logout: auth.logout }),
}))

const workspace = (id: string, name: string, createdAt: string, lastUsedAt: string, pinnedAt: string | null = null) => ({ id, name, icon: '', createdAt, updatedAt: createdAt, lastUsedAt, pinnedAt, sessionCount: 0 })
const listed = vi.hoisted(() => ({ items: [] as unknown[], pin: vi.fn() }))
vi.mock('../api/client', () => ({ api: { workspaces: { list: async () => ({ items: listed.items, hasShared: false }), use: async () => undefined, pin: listed.pin } } }))

function renderShell() {
  return render(
    <ThemeProvider><RouterProvider>
      <ToastProvider><WorkspacesProvider userId="usr_1">
        <AppShell><h1>Current page</h1></AppShell>
      </WorkspacesProvider></ToastProvider>
    </RouterProvider></ThemeProvider>,
  )
}

function showMobileTrigger() {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')
  if (!trigger) throw new Error('Mobile navigation trigger was not rendered')
  const header = trigger.closest<HTMLElement>('.mobile-header')
  if (header) header.style.display = 'grid'
  return trigger
}

describe('application shell navigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/workspaces/wsp_a')
    listed.items = [workspace('wsp_a', '', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z'), workspace('wsp_b', 'Research', '2026-09-02T00:00:00Z', '2026-09-04T00:00:00Z')]
    document.body.className = ''
    // jsdom has no layout; the framework excludes truly hidden controls.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 100, height: 36, top: 0, right: 100, bottom: 36, left: 0, toJSON: () => ({}) })
  })

  afterEach(() => vi.restoreAllMocks())

  it('treats the mobile drawer as a focus-trapped modal and restores focus on Escape', async () => {
    const user = userEvent.setup()
    renderShell()
    const trigger = showMobileTrigger()
    await user.click(trigger)

    const drawer = screen.getByRole('dialog', { name: 'Mobile navigation' })
    const close = within(drawer).getByRole('button', { name: 'Close navigation' })
    await waitFor(() => expect(close).toHaveFocus())
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(document.body.style.overflow).toBe('hidden')

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(within(drawer).getByRole('button', { name: 'Sign out' })).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.body.style.overflow).not.toBe('hidden')

    await user.click(trigger)
    await user.click(await within(screen.getByRole('dialog', { name: 'Mobile navigation' })).findByRole('link', { name: 'Research' }))
    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument()
  })

  it('offers the language menu and the theme toggle in both desktop and mobile headers', () => {
    renderShell()
    const desktop = document.querySelector('.app-topbar')!
    const mobile = document.querySelector<HTMLElement>('.mobile-header')!
    mobile.style.display = 'grid'
    expect(within(desktop as HTMLElement).getByRole('button', { name: 'Interface language' })).toContainElement(desktop.querySelector('img[src="/flags/lang-en-au.svg"]'))
    expect(within(mobile as HTMLElement).getByRole('button', { name: 'Interface language' })).toBeInTheDocument()
    // The toggle says which mode it is in; there is no menu behind it.
    for (const header of [desktop, mobile]) {
      const toggle = within(header as HTMLElement).getByRole('button', { name: 'Colour theme: System theme' })
      expect(toggle).not.toHaveAttribute('aria-haspopup')
    }
    // Neither header has a guide button of its own any more.
    expect(within(desktop as HTMLElement).queryByRole('button', { name: 'Workspace guide' })).toBeNull()
    expect(within(mobile as HTMLElement).queryByRole('button', { name: 'Workspace guide' })).toBeNull()
  })

  it('steps the theme through following the system, light and dark', () => {
    expect(nextThemeMode('system')).toBe('light')
    expect(nextThemeMode('light')).toBe('dark')
    expect(nextThemeMode('dark')).toBe('system')
  })

  it('opens the workspace guide from the logo at the top of the navigation', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(within(document.querySelector('.app-sidebar') as HTMLElement).getByRole('button', { name: 'Workspace guide' }))
    expect(await screen.findByRole('dialog', { name: 'A little help, right here' })).toBeInTheDocument()
  })
  it('moves focus to main content after drawer navigation', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(showMobileTrigger())
    const drawer = screen.getByRole('dialog', { name: 'Mobile navigation' })
    await user.click(await within(drawer).findByRole('link', { name: 'Research' }))

    const main = screen.getByRole('main')
    await waitFor(() => expect(main).toHaveFocus())
    expect(window.location.pathname).toBe('/workspaces/wsp_b')
  })

  it('lists the workspaces, offers another while there are four or fewer, and names the open one in the breadcrumb', async () => {
    renderShell()
    const sidebar = within(document.querySelector('.app-sidebar') as HTMLElement)
    expect(await sidebar.findByRole('link', { name: 'My workspace' })).toHaveAttribute('aria-current', 'page')
    expect(sidebar.getByRole('link', { name: 'Research' })).toHaveAttribute('href', '/workspaces/wsp_b')
    expect(sidebar.getByRole('button', { name: 'New workspace' })).toBeInTheDocument()
    expect(sidebar.queryByRole('link', { name: 'More workspaces' })).toBeNull()
    // Sessions and history are gone; both live in workspaces now.
    expect(sidebar.queryByRole('link', { name: 'Sessions' })).toBeNull()
    expect(sidebar.queryByRole('link', { name: 'History' })).toBeNull()
    const breadcrumb = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(breadcrumb.getByText('My workspace')).toHaveAttribute('aria-current', 'page')
    // Until there are more than the sidebar shows, the full list is no step of its own.
    expect(breadcrumb.queryByRole('link', { name: 'Workspaces' })).toBeNull()
  })

  it('past four, keeps the four used most recently in the order they were made, and leads to the rest', async () => {
    listed.items = ['a', 'b', 'c', 'd', 'e'].map((id, index) => workspace(`wsp_${id}`, `Space ${id.toUpperCase()}`, `2026-09-0${index + 1}T00:00:00Z`, `2026-09-1${[4, 1, 3, 2, 5][index]}T00:00:00Z`))
    renderShell()
    const sidebar = within(document.querySelector('.app-sidebar') as HTMLElement)
    expect(await sidebar.findByRole('link', { name: 'More workspaces' })).toHaveAttribute('href', '/workspaces')
    const names = sidebar.getAllByRole('link').map((link) => link.textContent).filter((name) => name?.startsWith('Space'))
    expect(names).toEqual(['Space A', 'Space C', 'Space D', 'Space E'])
    expect(sidebar.queryByRole('button', { name: 'New workspace' })).toBeNull()
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '/workspaces')
  })
})

describe('administration in the sidebar', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/admin/people')
    listed.items = [workspace('wsp_a', '', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z')]
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 100, height: 36, top: 0, right: 100, bottom: 36, left: 0, toJSON: () => ({}) })
  })
  afterEach(() => { vi.restoreAllMocks(); auth.user.role = 'user' })

  it('is a category of its own, one page per link, only for administrators', async () => {
    renderShell()
    const sidebar = within(document.querySelector('.app-sidebar') as HTMLElement)
    await sidebar.findByRole('link', { name: 'My workspace' })
    expect(sidebar.queryByText('Administration')).toBeNull()
    expect(sidebar.queryByRole('link', { name: 'People' })).toBeNull()
  })

  it('lists every administration page and names the open one in the breadcrumb', async () => {
    ;(auth.user as { role: string }).role = 'admin'
    renderShell()
    const sidebar = within(document.querySelector('.app-sidebar') as HTMLElement)
    expect(await sidebar.findByText('Administration')).toBeInTheDocument()
    expect(sidebar.getAllByRole('link').map((link) => link.getAttribute('href')).filter((href) => href?.startsWith('/admin'))).toEqual(['/admin/codes', '/admin/people', '/admin/usage', '/admin/activity', '/admin/operations', '/admin/engines', '/admin/site'])
    expect(sidebar.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page')
    const breadcrumb = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(breadcrumb.getByText('Administration')).toBeInTheDocument()
    expect(breadcrumb.getByText('People')).toHaveAttribute('aria-current', 'page')
  })
})

describe('a pinned workspace in the sidebar', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/workspaces/wsp_a')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 100, height: 36, top: 0, right: 100, bottom: 36, left: 0, toJSON: () => ({}) })
  })
  afterEach(() => vi.restoreAllMocks())

  it('comes first with its pin, which unpins it; the others have none', async () => {
    const user = userEvent.setup()
    listed.items = [workspace('wsp_a', '', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z'),
      workspace('wsp_b', 'Research', '2026-09-02T00:00:00Z', '2026-09-04T00:00:00Z', '2026-09-06T00:00:00Z')]
    listed.pin.mockReset().mockImplementation(async (id: string) => ({ ...(listed.items as Array<Record<string, unknown>>).find(item => item.id === id), pinnedAt: null }))
    renderShell()
    const sidebar = within(document.querySelector('.app-sidebar') as HTMLElement)
    const unpin = await sidebar.findByRole('button', { name: 'Unpin Research' })
    const links = sidebar.getAllByRole('link').map(link => link.getAttribute('href')).filter(href => href?.startsWith('/workspaces/'))
    expect(links).toEqual(['/workspaces/wsp_b', '/workspaces/wsp_a'])
    expect(sidebar.queryByRole('button', { name: /Unpin My workspace/ })).toBeNull()
    await user.click(unpin)
    expect(listed.pin).toHaveBeenCalledWith('wsp_b', false)
    await waitFor(() => expect(sidebar.queryByRole('button', { name: 'Unpin Research' })).toBeNull())
  })
})

describe('the sidebar list of workspaces', () => {
  it('is the four used last, in the order they were made', () => {
    const made = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => workspace(id, id, `2026-09-0${index + 1}T00:00:00Z`, `2026-09-1${[0, 6, 1, 5, 4, 3][index]}T00:00:00Z`))
    expect(sidebarWorkspaces(made).map((item) => item.id)).toEqual(['b', 'd', 'e', 'f'])
    expect(sidebarWorkspaces(made.slice(0, 3)).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('puts every pinned workspace first, in the order it was pinned, before the ones used last', () => {
    const made = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => workspace(id, id, `2026-09-0${index + 1}T00:00:00Z`, `2026-09-1${[0, 6, 1, 5, 4, 3][index]}T00:00:00Z`,
      id === 'c' ? '2026-09-20T00:00:00Z' : id === 'a' ? '2026-09-21T00:00:00Z' : null))
    expect(sidebarWorkspaces(made).map((item) => item.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(pinnedFirst(made).map((item) => item.id)).toEqual(['c', 'a', 'b', 'd', 'e', 'f'])
    // Pinned past the sidebar's four, every pinned one is still listed.
    const allPinned = made.map((item, index) => ({ ...item, pinnedAt: `2026-09-2${index}T00:00:00Z` }))
    expect(sidebarWorkspaces(allPinned).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})
