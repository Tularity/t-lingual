import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LanguageSelect } from './index'
import { Dialog, DialogHeader, DialogTitle, DialogBody } from '@t-lingual/ui'

const choices = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
]

function Harness() {
  const [value, setValue] = useState('en')
  return <LanguageSelect label="Spoken language" value={value} onChange={setValue} languages={choices} includeAuto hint="Choose a source language" />
}

describe('language select', () => {
  it('selects a portalled option without dismissing the enclosing dialog', async () => {
    function InDialog() {
      const [open, setOpen] = useState(true)
      return <Dialog open={open} onOpenChange={setOpen}><DialogHeader><DialogTitle>New conversation</DialogTitle></DialogHeader><DialogBody><Harness /></DialogBody></Dialog>
    }
    const user = userEvent.setup()
    render(<InDialog />)
    await user.click(screen.getByRole('button', { name: 'Spoken language English' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /French/ }))
    expect(screen.getByRole('dialog', { name: 'New conversation' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Spoken language French' }))
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'New conversation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spoken language French' })).toHaveFocus()
  })
  it('shows flags in the field and choices, with keyboard selection and focus return', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Spoken language English' })
    expect(trigger.querySelector('img')).toHaveAttribute('src', '/flags/lang-en-au.svg')

    await user.click(trigger)
    expect(await screen.findByRole('menuitemradio', { name: 'English' })).toHaveFocus()
    expect(await screen.findByRole('menuitemradio', { name: /French.*Français/u })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('menuitemradio', { name: /French.*Français/u }))
    const selected = screen.getByRole('button', { name: 'Spoken language French' })
    expect(selected.querySelector('img')).toHaveAttribute('src', '/flags/lang-fr.svg')

    selected.focus()
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.keyboard('j{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Spoken language Japanese' })).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Spoken language Japanese' }).querySelector('img')).toHaveAttribute('src', '/flags/lang-ja.svg')

    await user.keyboard('{ArrowDown}')
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Spoken language Japanese' })).toHaveFocus()
  })
})
