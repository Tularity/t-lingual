/**
 * Behavioural guard for the overlay family.
 *
 * These five components share one machinery — portal, presence, focus trap,
 * scroll lock, dismissal, inert background — and every defect this file has
 * caught so far came from that shared layer rather than from any one component.
 * The first was the worst: a portal that mounts one render late leaves every ref
 * inside it null during the commit that opens the surface, so the focus trap and
 * the inert marker both bailed and never ran again. Nothing threw. The dialog
 * simply opened with the page behind it fully reachable, which is invisible
 * unless something is actually driving the keyboard.
 *
 * Two behaviours are deliberately NOT asserted here and are covered in the
 * browser instead: the real `inert` attribute, which jsdom does not implement,
 * and anchored positioning, which needs a layout engine jsdom does not have.
 */
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../Dialog/Dialog'
import { Drawer, DrawerBody, DrawerHeader, DrawerTitle } from '../Drawer/Drawer'
import { Button } from '../Button/Button'
import { Popover } from '../Popover/Popover'
import { Tooltip } from '../Tooltip/Tooltip'
import { Menu, MenuItem, MenuSeparator } from '../Menu/Menu'

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

  // jsdom parses `:focus-visible` but never matches it, having no heuristic for
  // "was this focus reached by keyboard". Tooltip depends on that distinction to
  // open on Tab while staying quiet on a mouse click, so without this the test
  // measures jsdom rather than the component. Every focus produced here comes
  // from the keyboard, so treating it as `:focus` is what a browser would report.
  const matches = Element.prototype.matches
  Element.prototype.matches = function patched(selector: string) {
    return selector.includes(':focus-visible')
      ? matches.call(this, selector.replace(/:focus-visible/g, ':focus'))
      : matches.call(this, selector)
  }
})

/** True however the environment hid it — real `inert`, or the aria fallback. */
const hidden = (element: Element) =>
  element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'

/**
 * jsdom has no Web Animations, so every exit the suite drives resolves in the
 * same effect that starts it — the one branch of `usePresence` that can never
 * show a presence bug. Installing a `getAnimations` that reports one running
 * animation whose `finished` settles only on `release()` holds the exit open
 * long enough to look at the DOM during it, which is where the latched size,
 * the latched side and the re-open-mid-exit reversal actually live. `loop`
 * adds an infinite animation alongside, the kind a Spinner in the panel would
 * contribute; `windowed` adds one window of a windowed loop — finite, long, and
 * never settling while the loop is alive, like the compact mark's rounding.
 * The hook must wait on neither.
 */
function holdExits({ loop = false, windowed = false } = {}) {
  let release!: () => void
  const finished = new Promise<Animation>((resolve) => {
    release = () => resolve({} as Animation)
  })
  const finite = { playState: 'running', finished, effect: { getComputedTiming: () => ({ endTime: 470 }) } }
  const infinite = {
    playState: 'running',
    finished: new Promise<Animation>(() => {}),
    effect: { getComputedTiming: () => ({ endTime: Infinity }) },
  }
  const loopWindow = {
    id: 'tl-loop:compact-mark-round',
    playState: 'running',
    finished: new Promise<Animation>(() => {}),
    effect: { getComputedTiming: () => ({ endTime: 2400 }) },
  }
  Element.prototype.getAnimations = () =>
    [finite, ...(loop ? [infinite] : []), ...(windowed ? [loopWindow] : [])] as unknown as Animation[]
  return release
}

afterEach(() => {
  // Back to jsdom's real shape, so the tests that do not hold their exits keep
  // covering the synchronous branch.
  Reflect.deleteProperty(Element.prototype, 'getAnimations')
})

function DialogHarness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(true)}>end session</button>
      <p>page text</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>End session</DialogTitle>
          <DialogDescription>The transcript is kept.</DialogDescription>
        </DialogHeader>
        <DialogBody>Mandarin channel, 3 listeners.</DialogBody>
        <DialogFooter>
          {busy ? <Button loading>Confirm</Button> : <button>Confirm</button>}
        </DialogFooter>
      </Dialog>
    </div>
  )
}

describe('Dialog', () => {
  it('dismisses only the top of two sibling modals while keeping the older form intact', async () => {
    const user = userEvent.setup()
    function Stacked() {
      const [codeOpen, setCodeOpen] = useState(false)
      const [helpOpen, setHelpOpen] = useState(false)
      return <><button onClick={() => setCodeOpen(true)}>Open code access</button>
        <Dialog open={codeOpen} onOpenChange={setCodeOpen} aria-label="Code access">
          <DialogBody><label>Six-digit code<input aria-label="Six-digit code" /></label>
            <button onClick={() => setHelpOpen(true)}>How to register</button></DialogBody>
        </Dialog>
        <Dialog open={helpOpen} onOpenChange={setHelpOpen} aria-label="Registration help" size="full">
          <DialogBody><p>Help documentation remains interactive.</p><button onClick={() => setHelpOpen(false)}>Close help</button></DialogBody>
        </Dialog>
      </>
    }
    render(<Stacked />)
    await user.click(screen.getByRole('button', { name: 'Open code access' }))
    await user.type(screen.getByRole('textbox', { name: 'Six-digit code' }), '123456')
    await user.click(screen.getByRole('button', { name: 'How to register' }))
    const help = await screen.findByRole('dialog', { name: 'Registration help' })
    const code = screen.getByRole('dialog', { name: 'Code access', hidden: true })
    expect(hidden(code.closest('.tl-dialog')!)).toBe(true)
    await user.click(screen.getByText('Help documentation remains interactive.'))
    expect(help).toBeInTheDocument()
    expect(code).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Registration help' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Code access' })).toBe(code)
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toHaveValue('123456')
    await user.click(screen.getByRole('button', { name: 'How to register' }))
    const secondHelp = await screen.findByRole('dialog', { name: 'Registration help' })
    await user.click(screen.getByRole('button', { name: 'Close help' }))
    await waitFor(() => expect(secondHelp).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toHaveValue('123456')
    await user.click(screen.getByRole('button', { name: 'How to register' }))
    const thirdHelp = await screen.findByRole('dialog', { name: 'Registration help' })
    const scrim = thirdHelp.closest('.tl-dialog')!.querySelector('.tl-dialog__scrim')!
    await user.click(scrim)
    await waitFor(() => expect(thirdHelp).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Code access' })).toBe(code)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Code access' })).toBeNull())
  })
  it('lets a menu inside a dialog consume Escape and outside presses one layer at a time', async () => {
    const user = userEvent.setup()
    render(<Dialog defaultOpen aria-label="Manage conversation"><DialogBody>
      <Menu trigger={<button>More actions</button>} aria-label="Conversation actions"><MenuItem>Rename</MenuItem></Menu>
      <button>Another control</button>
    </DialogBody></Dialog>)
    const dialog = await screen.findByRole('dialog', { name: 'Manage conversation' })
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    const menu = screen.getByRole('menu')
    menu.focus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(dialog).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('button', { name: 'Another control' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(dialog).toBeInTheDocument()
  })

  it('names itself, hides the background, and gives focus back on close', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    const trigger = screen.getByText('end session')
    trigger.focus()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('End session')
    expect(dialog).toHaveAccessibleDescription('The transcript is kept.')

    const appRoot = trigger.closest('div')!.parentElement!
    await waitFor(() => expect(hidden(appRoot)).toBe(true))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Released on the way out, and focus put back where the user left it — a
    // dialog that drops focus on <body> restarts the keyboard user at the top
    // of the page with no signal that it happened.
    expect(hidden(appRoot)).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Tab inside the panel', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    await user.click(screen.getByText('end session'))
    const dialog = await screen.findByRole('dialog')
    await user.tab()
    await user.tab()
    await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('closes promptly with a loading button inside it', async () => {
    // A loading Button renders the compact mark's wave, an infinite animation,
    // and `usePresence` waits on every animation in the subtree. The mark cancels
    // its loops under `[data-state='exiting']` so the dialog is released by
    // its own transitions rather than by the 1200ms backstop. jsdom runs no
    // animations, so the cancel rule itself is checked in the browser; what
    // this pins is that the composition mounts, closes and unmounts at all,
    // well inside the backstop, and releases the page on the way out.
    const user = userEvent.setup()
    render(<DialogHarness busy />)
    const trigger = screen.getByText('end session')
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('[data-tl="spinner"]')).not.toBeNull()

    const started = Date.now()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 900 })
    expect(Date.now() - started).toBeLessThan(900)
    expect(document.body.style.overflow).toBe('')
  })

  it('grows from the origin it was given', async () => {
    render(
      <Dialog open aria-label="Pinned" origin={{ x: 100, y: 200 }}>
        <DialogBody>From a point.</DialogBody>
      </Dialog>,
    )
    const dialog = await screen.findByRole('dialog')
    // The delta is measured from the centre of jsdom's 1024x768 viewport, and
    // it has to be on the panel's very first commit or @starting-style zooms
    // from the wrong place.
    expect(dialog.style.getPropertyValue('--_origin-x')).toBe('-412px')
    expect(dialog.style.getPropertyValue('--_origin-y')).toBe('-184px')
  })

  it('opens and exits from the clicked button even when its handler blurs it', async () => {
    const user = userEvent.setup()
    const release = holdExits()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <><button onClick={event => { event.currentTarget.blur(); setOpen(true) }}>open pointer dialog</button>
        <Dialog open={open} onOpenChange={setOpen} aria-label="Pointer dialog"><DialogBody>Content</DialogBody></Dialog></>
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open pointer dialog' })
    const bounds = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 70, top: 110, width: 120, height: 40 } as DOMRect)
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Pointer dialog' })
    expect(document.activeElement).not.toBe(trigger)
    expect(dialog.style.getPropertyValue('--_origin-x')).toBe('-382px')
    expect(dialog.style.getPropertyValue('--_origin-y')).toBe('-254px')
    bounds.mockReturnValue({ left: 900, top: 700, width: 20, height: 20 } as DOMRect)
    await user.keyboard('{Escape}')
    expect(dialog).toHaveAttribute('data-state', 'exiting')
    expect(dialog.style.getPropertyValue('--_origin-x')).toBe('-382px')
    release()
  })

  it('keeps the trigger origin when opening removes the button from the document', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>{!open && <button onClick={() => setOpen(true)}>open disappearing dialog</button>}
        <Dialog open={open} onOpenChange={setOpen} aria-label="Disappearing dialog"><DialogBody>Content</DialogBody></Dialog></>
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open disappearing dialog' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 300, top: 200, width: 60, height: 20 } as DOMRect)
    await user.click(trigger)
    expect(trigger.isConnected).toBe(false)
    const dialog = await screen.findByRole('dialog', { name: 'Disappearing dialog' })
    expect(dialog.style.getPropertyValue('--_origin-x')).toBe('-182px')
    expect(dialog.style.getPropertyValue('--_origin-y')).toBe('-174px')
  })
  it.each(['{Enter}', ' '])('uses the keyboard trigger centre before focus moves to the modal (%s)', async key => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <><button onClick={event => { event.currentTarget.blur(); setOpen(true) }}>open keyboard dialog</button>
        <Dialog open={open} onOpenChange={setOpen} aria-label="Keyboard dialog"><DialogBody>Content</DialogBody></Dialog></>
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open keyboard dialog' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 800, top: 600, width: 80, height: 40 } as DOMRect)
    trigger.focus()
    await user.keyboard(key)
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard dialog' })
    expect(dialog.style.getPropertyValue('--_origin-x')).toBe('328px')
    expect(dialog.style.getPropertyValue('--_origin-y')).toBe('236px')
  })
  it('leaves at the size it had while open, and keeps its node when re-opened mid-exit', async () => {
    const release = holdExits()
    const sized = (open: boolean, size: 'md' | 'lg') => (
      <Dialog open={open} size={size} aria-label="Sized">
        <DialogBody>Wide.</DialogBody>
      </Dialog>
    )
    const view = render(sized(true, 'lg'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('data-state', 'entered')

    // The idiomatic nullable-state driver reverts `size` on the close render.
    view.rerender(sized(false, 'md'))
    expect(dialog).toHaveAttribute('data-state', 'exiting')
    expect(dialog).toHaveAttribute('data-size', 'lg')

    // A re-open before the exit resolves reverses the same node in place. A
    // fresh node here would mean the panel snapped to its origin and every
    // child remounted — a form mid-edit would lose its state.
    view.rerender(sized(true, 'md'))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog).toHaveAttribute('data-state', 'entering')
    expect(dialog).toHaveAttribute('data-size', 'md')

    view.rerender(sized(false, 'md'))
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('does not wait on a loop that can never finish', async () => {
    const release = holdExits({ loop: true })
    const busy = (open: boolean) => (
      <Dialog open={open} aria-label="Busy">
        <DialogBody>Saving.</DialogBody>
      </Dialog>
    )
    const view = render(busy(true))
    await screen.findByRole('dialog')
    view.rerender(busy(false))
    release()
    // Well inside the 1200ms backstop, which is what an awaited infinite
    // animation would otherwise leave as the only way out.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 900 })
  })

  it('does not wait on the window of a windowed loop', async () => {
    // A window is finite to the Web Animations API, so without its loop id the
    // hook would wait on a promise that settles only when the loop stops —
    // and stretch the backstop to the window's 2400ms end besides.
    const release = holdExits({ windowed: true })
    const busy = (open: boolean) => (
      <Dialog open={open} aria-label="Busy">
        <DialogBody>Saving.</DialogBody>
      </Dialog>
    )
    const view = render(busy(true))
    await screen.findByRole('dialog')
    view.rerender(busy(false))
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 900 })
  })

  it('does not fault a dialog that is correctly labelled', async () => {
    // Regression: the dev guard used to run on the commit before the portal
    // inserted anything, so it reported "no accessible name" for every dialog
    // that had one. A guard that cries wolf is a guard nobody reads.
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args[0])
    try {
      const user = userEvent.setup()
      render(<DialogHarness />)
      await user.click(screen.getByText('end session'))
      await screen.findByRole('dialog')
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveAccessibleName('End session'))
    } finally {
      console.error = original
    }
    expect(errors.filter((e) => String(e).includes('no accessible name'))).toEqual([])
  })
})

describe('Drawer', () => {
  it('renders anchored and labelled', async () => {
    render(
      <Drawer defaultOpen side="left" size="lg">
        <DrawerHeader>
          <DrawerTitle>Filters</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>Language pair, status, interpreter.</DrawerBody>
      </Drawer>,
    )
    const drawer = await screen.findByRole('dialog')
    expect(drawer).toHaveAccessibleName('Filters')
    expect(drawer).toHaveAttribute('data-side', 'left')
    // Open from the first render: nothing to animate in from, so no entrance.
    expect(drawer).toHaveAttribute('data-state', 'entered')
  })

  it('keeps its side through the exit and clears a stale swipe on re-open', async () => {
    const release = holdExits()
    const sheet = (open: boolean, side?: 'bottom') => (
      <Drawer open={open} side={side} aria-label="Sheet">
        <DrawerBody>Swipe me.</DrawerBody>
      </Drawer>
    )
    const view = render(sheet(true, 'bottom'))
    const drawer = await screen.findByRole('dialog')
    const root = drawer.parentElement!
    expect(root).toHaveAttribute('data-state', 'entered')
    expect(drawer.querySelector('.tl-drawer__grabber')).not.toBeNull()

    // What a swipe dismissal leaves on the root, followed by the close it
    // triggers — driven from state that also reverts `side` to its default.
    root.style.setProperty('--_drag', '250px')
    root.style.setProperty('--_progress', '0.5')
    view.rerender(sheet(false))
    expect(root).toHaveAttribute('data-state', 'exiting')
    expect(root).toHaveAttribute('data-side', 'bottom')
    // Still a bottom sheet while it leaves: the grabber must not drop out and
    // shove the header up on the first exit frame.
    expect(drawer.querySelector('.tl-drawer__grabber')).not.toBeNull()
    expect(root.style.getPropertyValue('--_drag')).toBe('250px')

    // Re-opened before the exit resolved: same node, and the swipe offset gone
    // before paint, or the sheet would re-enter parked where the finger left it.
    view.rerender(sheet(true, 'bottom'))
    expect(screen.getByRole('dialog')).toBe(drawer)
    expect(root).toHaveAttribute('data-state', 'entering')
    expect(root.style.getPropertyValue('--_drag')).toBe('')
    expect(root.style.getPropertyValue('--_progress')).toBe('')
    expect(root).not.toHaveAttribute('data-dragging')

    view.rerender(sheet(false))
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Popover', () => {
  it('opens on click and closes on Escape without locking the page', async () => {
    const user = userEvent.setup()
    render(
      <Popover aria-label="Session details" trigger={<button>more</button>}>
        <button>Rename</button>
      </Popover>,
    )
    const trigger = screen.getByText('more')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    const panel = await screen.findByRole('dialog')
    expect(panel).toHaveAccessibleName('Session details')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // The whole difference from Dialog: non-modal, so the page keeps scrolling.
    expect(document.body.style.overflow).toBe('')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})

describe('Tooltip', () => {
  it('opens on keyboard focus and describes rather than names its trigger', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Tooltip content="Copies the whole transcript">
          <button aria-describedby="existing">copy</button>
        </Tooltip>
        <span id="existing">already described</span>
      </>,
    )
    const trigger = screen.getByText('copy')
    await user.tab()
    expect(document.activeElement).toBe(trigger)

    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Copies the whole transcript')
    // Appended, not replaced: a tooltip supplements the accessible description
    // and must never clobber one the consumer already set.
    expect(trigger.getAttribute('aria-describedby')).toContain('existing')
    expect(trigger.getAttribute('aria-describedby')).toContain(tip.id)
  })
})

function MenuHarness() {
  return (
    <Menu trigger={<button>actions</button>} aria-label="Session actions">
      <MenuItem>Rename</MenuItem>
      <MenuItem>Export transcript</MenuItem>
      <MenuSeparator />
      <MenuItem disabled>Delete</MenuItem>
    </Menu>
  )
}

describe('Menu', () => {
  it('opens with a pointer without pre-selecting an item', async () => {
    const user = userEvent.setup()
    render(<MenuHarness />)
    const trigger = screen.getByText('actions')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')

    await user.click(trigger)
    const menu = await screen.findByRole('menu')
    // Pointer users have not expressed an intent to move through the list, and
    // highlighting the first item implies Enter would activate it.
    expect(document.activeElement).toBe(menu)
  })

  it('opens on ArrowDown with the first item focused, and restores focus on Escape', async () => {
    const user = userEvent.setup()
    render(<MenuHarness />)
    const trigger = screen.getByText('actions')
    trigger.focus()
    await user.keyboard('{ArrowDown}')

    await screen.findByRole('menu')
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])

    await user.keyboard('{End}')
    expect((document.activeElement as HTMLElement).textContent).toBe('Delete')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
