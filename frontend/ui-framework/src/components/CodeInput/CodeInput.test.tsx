import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Field } from '../Field/Field'
import { CodeInput, type CodeInputProps } from './CodeInput'

/** Labelled "Code" unless a Field labels it. */
function Controlled({ labelled = true, ...props }: Partial<CodeInputProps> & { labelled?: boolean }) {
  const [value, setValue] = useState(props.value ?? '')
  return <CodeInput aria-label={labelled ? 'Code' : undefined} {...props} value={value} onValueChange={(next) => { setValue(next); props.onValueChange?.(next) }} />
}

const cells = () => [...document.querySelectorAll('.tl-code-input__cell')]

describe('CodeInput', () => {
  it('is one labelled field for one-time codes, drawn as a tile per character', () => {
    render(<Field label="Six-digit code"><Controlled labelled={false} /></Field>)
    const field = screen.getByRole('textbox', { name: 'Six-digit code' })
    expect(field).toHaveAttribute('autocomplete', 'one-time-code')
    expect(field).toHaveAttribute('inputmode', 'numeric')
    expect(field).toHaveAttribute('maxlength', '6')
    expect(cells()).toHaveLength(6)
    expect(cells()[0].parentElement).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps only digits, fills the tiles in order, and completes once', async () => {
    const onComplete = vi.fn()
    render(<Controlled onComplete={onComplete} />)
    const field = screen.getByRole('textbox', { name: 'Code' })
    await userEvent.type(field, '4a2 8-0')
    expect(field).toHaveValue('4280')
    expect(cells().map((cell) => cell.textContent)).toEqual(['4', '2', '8', '0', '', ''])
    expect(onComplete).not.toHaveBeenCalled()
    await userEvent.type(field, '19')
    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledWith('428019')
    // Full: nothing more goes in, and it does not complete again.
    await userEvent.type(field, '7')
    expect(field).toHaveValue('428019')
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('shows the next tile to fill while focused', async () => {
    render(<Controlled />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Code' }), '42')
    expect(cells().map((cell) => cell.hasAttribute('data-active'))).toEqual([false, false, true, false, false, false])
  })

  it('starts a wrong code afresh with the next character typed', async () => {
    const changes: string[] = []
    render(<Controlled value="428019" invalid onValueChange={(next) => changes.push(next)} />)
    const field = screen.getByRole('textbox', { name: 'Code' })
    expect(field).toHaveAttribute('aria-invalid', 'true')
    field.focus()
    fireEvent.keyDown(field, { key: '5' })
    expect(changes).toEqual(['5'])
  })

  it('takes a whole pasted code in place of what is there, and completes', () => {
    const onComplete = vi.fn()
    render(<Controlled value="12" onComplete={onComplete} />)
    fireEvent.paste(screen.getByRole('textbox', { name: 'Code' }), { clipboardData: { getData: () => ' 654 321 ' } })
    expect(onComplete).toHaveBeenCalledWith('654321')
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveValue('654321')
  })

  it('cannot be changed while it is being checked', () => {
    render(<Controlled value="428019" busy />)
    const field = screen.getByRole('textbox', { name: 'Code' })
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveAttribute('aria-busy', 'true')
  })

  it('upper-cases letters and digits when asked for them', async () => {
    render(<Controlled characters="alphanumeric" length={8} />)
    const field = screen.getByRole('textbox', { name: 'Code' })
    await userEvent.type(field, 'ab-12cd')
    expect(field).toHaveValue('AB12CD')
  })

  it('asks a dialog to start its focus here when told to autofocus', () => {
    render(<Controlled autoFocus />)
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveAttribute('data-autofocus')
  })
})
