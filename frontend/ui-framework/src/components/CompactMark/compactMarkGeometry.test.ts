import { describe, expect, it } from 'vitest'
import {
  compactCutForSize,
  compactMarkPartition,
  layoutCompactMark,
  type CompactMarkCut,
} from './compactMarkGeometry'

const CUTS: CompactMarkCut[] = [4, 5]

/** Flood fill from one cell of a piece; the piece is connected when the fill
 *  reaches every one of its cells. */
function isConnected(rows: readonly string[], piece: string) {
  const cells = rows.flatMap((row, r) => [...row].flatMap((p, c) => (p === piece ? [`${r},${c}`] : [])))
  const seen = new Set([cells[0]])
  const queue = [cells[0]]
  while (queue.length) {
    const [r, c] = queue.pop()!.split(',').map(Number)
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${r + dr},${c + dc}`
      if (rows[r + dr]?.[c + dc] === piece && !seen.has(key)) {
        seen.add(key)
        queue.push(key)
      }
    }
  }
  return seen.size === cells.length
}

describe('compact mark partitions', () => {
  it.each(CUTS)('%i×%i is square and uses exactly the four pieces', (cut) => {
    const rows = compactMarkPartition(cut)
    expect(rows).toHaveLength(cut)
    rows.forEach((row) => expect(row).toHaveLength(cut))
    expect(new Set(rows.join(''))).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it.each(CUTS)('%i×%i keeps every piece in one piece', (cut) => {
    const rows = compactMarkPartition(cut)
    for (const piece of 'abcd') expect(isConnected(rows, piece)).toBe(true)
  })

  // Two cells of one piece touching only at a corner would pinch the piece to
  // a point, which no amount of rounding can draw as one shape.
  it.each(CUTS)('%i×%i never pinches a piece at a lattice point', (cut) => {
    const rows = compactMarkPartition(cut)
    for (let r = 0; r < cut - 1; r++) {
      for (let c = 0; c < cut - 1; c++) {
        const [tl, tr, bl, br] = [rows[r][c], rows[r][c + 1], rows[r + 1][c], rows[r + 1][c + 1]]
        expect(tl === br && tl !== tr && tl !== bl).toBe(false)
        expect(tr === bl && tr !== tl && tr !== br).toBe(false)
      }
    }
  })

  // The features the partitions are drawn to keep: the L owns the top-left
  // corner, the band the top-right, the tongue piece the bottom-left and the
  // small piece the bottom-right.
  it.each(CUTS)('%i×%i puts each piece in its corner of the logo', (cut) => {
    const rows = compactMarkPartition(cut)
    const last = cut - 1
    expect([rows[0][0], rows[0][last], rows[last][0], rows[last][last]]).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('layoutCompactMark', () => {
  it('picks the four-cell lattice up to 18px and five cells above', () => {
    expect([12, 14, 16, 18].map(compactCutForSize)).toEqual([4, 4, 4, 4])
    expect([19, 22, 32, 192].map(compactCutForSize)).toEqual([5, 5, 5, 5])
  })

  it.each(CUTS)('%i×%i classifies every side consistently with its neighbour', (cut) => {
    const { cells } = layoutCompactMark(cut)
    const at = (r: number, c: number) => cells.find((cell) => cell.row === r && cell.col === c)
    for (const cell of cells) {
      const right = at(cell.row, cell.col + 1)
      const below = at(cell.row + 1, cell.col)
      if (right) {
        expect(cell.edges.right).toBe(right.edges.left)
        expect(cell.edges.right).toBe(right.piece === cell.piece ? 'join' : 'inset')
      } else expect(cell.edges.right).toBe('outer')
      if (below) {
        expect(cell.edges.bottom).toBe(below.edges.top)
        expect(cell.edges.bottom).toBe(below.piece === cell.piece ? 'join' : 'inset')
      } else expect(cell.edges.bottom).toBe('outer')
    }
  })

  it.each(CUTS)('%i×%i rounds only the silhouette and convex piece corners', (cut) => {
    const { cells } = layoutCompactMark(cut)
    const last = cut - 1
    const outer = cells.filter((c) => (c.row === 0 || c.row === last) && (c.col === 0 || c.col === last))
    const outerRadii = outer.map((c) => Math.max(...c.radii))
    expect(new Set(outerRadii).size).toBe(1)
    for (const cell of cells) {
      const corners = [
        [cell.edges.top, cell.edges.left],
        [cell.edges.top, cell.edges.right],
        [cell.edges.bottom, cell.edges.right],
        [cell.edges.bottom, cell.edges.left],
      ]
      corners.forEach(([vertical, horizontal], i) => {
        // A corner flanked by a join is inside its piece and must stay square,
        // or the piece shows a notch where two of its cells meet.
        if (vertical === 'join' || horizontal === 'join') expect(cell.radii[i]).toBe(0)
        else expect(cell.radii[i]).toBeGreaterThan(0)
        // A scoop and a convex radius on one corner would be two different
        // shapes claiming the same pixels.
        if (cell.scoops[i]) expect(cell.radii[i]).toBe(0)
      })
    }
  })

  it.each(CUTS)('%i×%i scoops exactly the inner corners of each piece', (cut) => {
    const rows = compactMarkPartition(cut)
    const { cells } = layoutCompactMark(cut)
    let expected = 0
    for (let r = 0; r < cut - 1; r++) {
      for (let c = 0; c < cut - 1; c++) {
        const block = [rows[r][c], rows[r][c + 1], rows[r + 1][c + 1], rows[r + 1][c]]
        for (const piece of new Set(block)) if (block.filter((p) => p === piece).length === 3) expected++
      }
    }
    const scoops = cells.reduce((n, cell) => n + cell.scoops.filter(Boolean).length, 0)
    expect(scoops).toBe(expected)
    expect(expected).toBeGreaterThan(0)
  })

  it.each(CUTS)('%i×%i runs the wave from the lower-left corner to the upper right', (cut) => {
    const { cells } = layoutCompactMark(cut)
    const phase = (r: number, c: number) => cells.find((cell) => cell.row === r && cell.col === c)!.phase
    expect(phase(cut - 1, 0)).toBe(0)
    expect(phase(0, cut - 1)).toBe(1)
    // One diagonal, one phase: the band crosses as a straight front.
    expect(phase(0, 0)).toBe(phase(cut - 1, cut - 1))
  })
})
