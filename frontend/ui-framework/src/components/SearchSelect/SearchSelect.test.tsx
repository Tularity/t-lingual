import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchSelect } from './SearchSelect'

const people = [
  { value: 'u1', label: 'Chloé Dubois', textValue: 'Chloé Dubois chloe', description: '@chloe' },
  { value: 'u2', label: 'Jonas Weber', textValue: 'Jonas Weber jonas', description: '@jonas' },
  { value: 'u3', label: 'Mei Lin', textValue: 'Mei Lin mei', description: '@mei', disabled: true },
  { value: 'u4', label: 'Priya Natarajan', textValue: 'Priya Natarajan priya', description: '@priya' },
]

describe('SearchSelect', () => {
  it('filters as the reader types, ignoring case and accents, and chooses with the pointer', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<SearchSelect aria-label="Account" placeholder="Choose a person" options={people} onValueChange={onValueChange} searchLabel="Search people" emptyLabel="Nobody matches" />)
    await user.click(screen.getByRole('button', { name: /^Account/ }))
    const search = screen.getByRole('combobox', { name: 'Search people' })
    await waitFor(() => expect(search).toHaveFocus())
    await user.type(search, 'CHLOE')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Chloé Dubois@chloe'])
    await user.clear(search)
    await user.type(search, 'zzz')
    expect(screen.getByText('Nobody matches')).toBeInTheDocument()
    await user.clear(search)
    await user.click(screen.getByRole('option', { name: /Jonas Weber/ }))
    expect(onValueChange).toHaveBeenCalledWith('u2')
    expect(screen.getByRole('button', { name: /^Account Jonas Weber/ })).toBeInTheDocument()
  })

  it('moves through the rows with the arrow keys, past disabled ones, and chooses with Enter', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<SearchSelect aria-label="Account" options={people} defaultValue="u2" onValueChange={onValueChange} />)
    await user.click(screen.getByRole('button', { name: /^Account/ }))
    const search = screen.getByRole('combobox')
    // Opens on the current choice.
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Jonas/ }).id)
    expect(screen.getByRole('option', { name: /Jonas/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Priya/ }).id)
    await user.keyboard('{Enter}')
    expect(onValueChange).toHaveBeenCalledWith('u4')
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
