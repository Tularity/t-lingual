import { useState, type FormEvent } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, Dialog, Skeleton, Tabs, Textarea, ToastProvider } from './components'

describe('design-system keyboard behaviour', () => {
  it('closes a modal dialog with Escape', async () => {
    const onClose = vi.fn()
    render(<ToastProvider><Dialog open title="Confirm change" onClose={onClose}>Dialog body</Dialog></ToastProvider>)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves tabs with arrow keys', async () => {
    const onChange = vi.fn()
    render(<Tabs label="Sections" value="one" onChange={onChange} items={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} />)
    screen.getByRole('tab', { name: 'One' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledWith('two')
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus()
  })

  it('keeps focus while controlled dialog input re-renders', async () => {
    function ControlledDialog() {
      const [value, setValue] = useState('')
      return <Dialog open title="Edit name" onClose={() => undefined}><label>Name<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label></Dialog>
    }
    render(<ControlledDialog />)
    const input = screen.getByRole('textbox', { name: 'Name' })
    await userEvent.type(input, 'continuous')
    expect(input).toHaveValue('continuous')
    expect(input).toHaveFocus()
  })

  it('renders skeleton dimensions without CSP-blocked inline styles', () => {
    const { container } = render(<Skeleton width="40%" height={120} />)
    const skeleton = container.firstElementChild
    expect(skeleton).not.toHaveAttribute('style')
    expect(skeleton).toHaveAttribute('data-width', '40')
    expect(skeleton).toHaveAttribute('data-height', '120')
  })

  it('connects textarea help and errors to the control', () => {
    const { rerender } = render(<Textarea label="Notes" hint="Keep this concise." />)
    const textarea = screen.getByRole('textbox', { name: 'Notes' })
    const hint = screen.getByText('Keep this concise.')
    expect(textarea).toHaveAttribute('aria-describedby', hint.id)

    rerender(<Textarea label="Notes" error="Notes are required." />)
    const error = screen.getByText('Notes are required.')
    expect(textarea).toHaveAttribute('aria-describedby', error.id)
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps reusable buttons non-submitting unless explicitly requested', async () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault())
    render(<form onSubmit={onSubmit}><Button>Secondary action</Button></form>)

    await userEvent.click(screen.getByRole('button', { name: 'Secondary action' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
