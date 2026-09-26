import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Field } from '../Field/Field'
import { Select, SelectGroup, SelectOption } from './Select'

function Speed({ onValueChange }: { onValueChange?: (value: string) => void }) {
  const [value, setValue] = useState('1')
  return (
    <Field label="Playback speed">
      <Select
        value={value}
        onValueChange={(next) => {
          setValue(next)
          onValueChange?.(next)
        }}
      >
        <SelectOption value="0.5">0.5×</SelectOption>
        <SelectOption value="1">1×</SelectOption>
        <SelectGroup label="Faster">
          <SelectOption value="1.5">1.5×</SelectOption>
          <SelectOption value="2" disabled>2×</SelectOption>
        </SelectGroup>
      </Select>
    </Field>
  )
}

describe('Select', () => {
  it('is a button named by its label and then its current choice', () => {
    render(<Speed />)
    expect(screen.getByRole('button', { name: 'Playback speed 1×' })).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('opens the framework menu on the current choice and picks another', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<Speed onValueChange={changed} />)
    await user.click(screen.getByRole('button', { name: /^Playback speed/u }))
    const current = await screen.findByRole('menuitemradio', { name: '1×' })
    expect(current).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(current).toHaveFocus())
    // Grouped options are part of the same single choice.
    await user.click(screen.getByRole('menuitemradio', { name: '1.5×' }))
    expect(changed).toHaveBeenCalledWith('1.5')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Playback speed 1.5×' })).toHaveFocus()
  })

  it('does not choose a disabled option', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<Speed onValueChange={changed} />)
    await user.click(screen.getByRole('button', { name: /^Playback speed/u }))
    await user.click(await screen.findByRole('menuitemradio', { name: '2×' }))
    expect(changed).not.toHaveBeenCalled()
  })

  it('shows the placeholder, quieter, until something is chosen', () => {
    render(
      <Select aria-label="Account" placeholder="Choose a user" defaultValue="">
        <SelectOption value="sam">Sam</SelectOption>
      </Select>,
    )
    const button = screen.getByRole('button', { name: 'Account Choose a user' })
    expect(button).toHaveAttribute('data-empty')
  })

  it('reserves the widest choice without exposing the copies', () => {
    const { container } = render(
      <Select aria-label="Sort" defaultValue="a">
        <SelectOption value="a">Short</SelectOption>
        <SelectOption value="b">A considerably longer choice</SelectOption>
      </Select>,
    )
    const sizers = container.querySelectorAll('.tl-select__sizer')
    expect(sizers).toHaveLength(2)
    sizers.forEach((sizer) => expect(sizer).toHaveAttribute('aria-hidden', 'true'))
    expect(screen.getByRole('button', { name: 'Sort Short' })).toBeInTheDocument()
  })

  it('submits its value with a form when named', () => {
    const { container } = render(
      <form>
        <Select aria-label="Role" name="role" defaultValue="admin">
          <SelectOption value="user">Member</SelectOption>
          <SelectOption value="admin">Administrator</SelectOption>
        </Select>
      </form>,
    )
    expect(new FormData(container.querySelector('form')!).get('role')).toBe('admin')
  })
})
