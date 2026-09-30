import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { DataTable, type DataTableColumn } from './DataTable'

interface Person { id: string; name: string; joined: number; team: string | null }

const people: Person[] = Array.from({ length: 45 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `Person ${String(index + 1).padStart(2, '0')}`,
  joined: 1000 + ((index * 7) % 45),
  team: index % 5 === 0 ? null : `Team ${index % 3}`,
}))

const columns: DataTableColumn<Person>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name, sortValue: (row) => row.name, hideable: false },
  { id: 'joined', header: 'Joined', cell: (row) => row.joined, sortValue: (row) => row.joined, numeric: true, firstSort: 'descending' },
  { id: 'team', header: 'Team', cell: (row) => row.team ?? '—', sortValue: (row) => row.team },
]

const names = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row').map((row) => within(row).getAllByRole('cell')[0]!.textContent)

describe('DataTable', () => {
  it('shows one page at a time and says where the reader is', async () => {
    const user = userEvent.setup()
    render(<DataTable caption="People" columns={columns} rows={people} rowKey={(row) => row.id} defaultPageSize={20} />)
    expect(names()).toHaveLength(20)
    expect(names()[0]).toBe('Person 01')
    expect(screen.getByText('1–20 of 45')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Page 3' }))
    expect(names()).toEqual(['Person 41', 'Person 42', 'Person 43', 'Person 44', 'Person 45'])
    expect(screen.getByText('41–45 of 45')).toBeInTheDocument()
  })

  it('sorts by a column, first in the direction the column asks for, and keeps missing values last', async () => {
    const user = userEvent.setup()
    render(<DataTable caption="People" columns={columns} rows={people} rowKey={(row) => row.id} defaultPageSize={50} />)
    const joined = screen.getByRole('columnheader', { name: /Joined/ })
    await user.click(within(joined).getByRole('button'))
    expect(joined).toHaveAttribute('aria-sort', 'descending')
    const values = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row').map((row) => Number(within(row).getAllByRole('cell')[1]!.textContent))
    expect(values).toEqual([...values].sort((a, b) => b - a))
    await user.click(within(joined).getByRole('button'))
    expect(joined).toHaveAttribute('aria-sort', 'ascending')

    const team = screen.getByRole('columnheader', { name: /Team/ })
    for (const direction of ['ascending', 'descending']) {
      if (team.getAttribute('aria-sort') !== direction) await user.click(within(team).getByRole('button'))
      const teams = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row').map((row) => within(row).getAllByRole('cell')[2]!.textContent)
      expect(teams.slice(-9).every((value) => value === '—')).toBe(true)
      expect(teams.slice(0, -9).includes('—')).toBe(false)
    }
  })

  it('lets the reader hide columns, but never the one that names a row or the last one showing', async () => {
    const user = userEvent.setup()
    const onHidden = vi.fn()
    render(<DataTable caption="People" columns={columns} rows={people} rowKey={(row) => row.id} onHiddenColumnsChange={onHidden} />)
    await user.click(screen.getByRole('button', { name: 'Table options' }))
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Name' })).toBeNull()
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Team' }))
    expect(onHidden).toHaveBeenLastCalledWith(['team'])
    expect(screen.queryByRole('columnheader', { name: /Team/ })).toBeNull()
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Joined' }))
    expect(screen.getAllByRole('columnheader')).toHaveLength(1)
  })

  it('changes the page size and density from the reader’s choice', async () => {
    const user = userEvent.setup()
    render(<DataTable caption="People" columns={columns} rows={people} rowKey={(row) => row.id} defaultPageSize={10} />)
    expect(names()).toHaveLength(10)
    await user.click(screen.getByRole('button', { name: /Rows per page/ }))
    await user.click(screen.getByRole('menuitemradio', { name: '50' }))
    expect(names()).toHaveLength(45)
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Table options' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Compact' }))
    expect(screen.getByRole('table')).toHaveAttribute('data-density', 'compact')
  })

  it('starts again from the first page when what narrowed the rows changes, and shows the empty state', async () => {
    const user = userEvent.setup()
    function Filtered() {
      const [query, setQuery] = useState('')
      const rows = people.filter((row) => row.name.includes(query))
      return <DataTable caption="People" columns={columns} rows={rows} rowKey={(row) => row.id} defaultPageSize={10} resetPageKey={query}
        toolbar={<input aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} />} empty="Nobody matches" />
    }
    render(<Filtered />)
    await user.click(screen.getByRole('button', { name: 'Page 4' }))
    expect(names()[0]).toBe('Person 31')
    await user.type(screen.getByRole('textbox', { name: 'Search' }), '1')
    expect(names()[0]).toBe('Person 01')
    await user.clear(screen.getByRole('textbox', { name: 'Search' }))
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'nobody')
    expect(screen.getByText('Nobody matches')).toBeInTheDocument()
    expect(screen.getByText('0 rows')).toBeInTheDocument()
  })
})
