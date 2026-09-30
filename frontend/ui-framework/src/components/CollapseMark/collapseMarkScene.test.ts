import { describe, expect, it } from 'vitest'
import { COLLAPSE_MARK_PIECES, COLLAPSE_MARK_PITCH } from './collapseMarkData'
import { COLLAPSE_MARK_COLLAPSE_START, COLLAPSE_MARK_GATHER_FROM, COLLAPSE_MARK_GONE } from './collapseMarkTiming'
import { COLLAPSE_MARK_FRAME, collapseBodyAngle, collapseMarkDots, collapseMarkScene } from './collapseMarkScene'

const scene = collapseMarkScene()

/** Every outline point of every visible piece at `t`, in the drawing's frame. */
function visiblePoints(t: number) {
  const tilt = (scene.tilt.sample(t)[0] * Math.PI) / 180
  return scene.pieces.flatMap((piece) => {
    if (piece.opacity.sample(t)[0] <= 0) return []
    const [tx, ty] = piece.translate.sample(t)
    const values = piece.material.sample(t)
    const points: [number, number][] = []
    for (let i = 0; i < values.length; i += 2) {
      const x = values[i] + tx - 83, y = values[i + 1] + ty - 97
      points.push([83 + x * Math.cos(tilt) - y * Math.sin(tilt), 97 + x * Math.sin(tilt) + y * Math.cos(tilt)])
    }
    return points
  })
}

describe('collapse mark scene', () => {
  it('carries the four pieces and all 49 lattice cells', () => {
    expect(COLLAPSE_MARK_PIECES).toHaveLength(4)
    expect(COLLAPSE_MARK_PIECES.flatMap((p) => p.cells)).toHaveLength(49)
    const ranks = COLLAPSE_MARK_PIECES.flatMap((p) => p.cells.map((c) => c.rank)).sort((a, b) => a - b)
    expect(ranks).toEqual(Array.from({ length: 49 }, (_, i) => i))
  })

  it('starts and ends empty', () => {
    expect(scene.pieces.every((p) => p.opacity.sample(0)[0] === 0)).toBe(true)
    // Every cell has shrunk to nothing by the last key: a zero-size cell
    // collapses every point of its outline onto its own centre.
    for (const piece of scene.pieces) {
      const values = piece.material.sample(1)
      let spread = 0
      let offset = 0
      for (const points of piece.shape) {
        for (let p = 0; p < points; p++) {
          spread = Math.max(spread, Math.abs(values[offset + p * 2] - values[offset]), Math.abs(values[offset + p * 2 + 1] - values[offset + 1]))
        }
        offset += points * 2
      }
      expect(spread).toBeLessThan(0.002)
    }
  })

  it('is assembled and upright just before the collapse, and holds the logo tilt after its first third', () => {
    expect(scene.pieces.every((p) => p.opacity.sample(0.21)[0] === 1)).toBe(true)
    expect(scene.pieces.every((p) => p.translate.sample(0.21).every((v) => v === 0))).toBe(true)
    expect(scene.tilt.sample(0.21)[0]).toBe(-22)
    expect(collapseBodyAngle(0.21)).toBe(0)
    expect(collapseBodyAngle(0.38)).toBeCloseTo(22, 10)
    expect(collapseBodyAngle(0.9)).toBe(22)
  })

  it('never leaves the frame, which is centred on the body', () => {
    const [fx, fy, fw, fh] = COLLAPSE_MARK_FRAME
    expect([fx + fw / 2, fy + fh / 2]).toEqual([83, 97])
    const box = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i <= 120; i++) {
      for (const [x, y] of visiblePoints(i / 120)) {
        box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y)
        box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y)
      }
    }
    expect(box[0]).toBeGreaterThan(fx)
    expect(box[1]).toBeGreaterThan(fy)
    expect(box[2]).toBeLessThan(fx + fw)
    expect(box[3]).toBeLessThan(fy + fh)
  })

  describe('lingering', () => {
    const lingering = collapseMarkScene({ lingerFrom: 0 })
    /** Each cell's centre and width in `values`, from its outline's extent. */
    function cells(piece: (typeof lingering.pieces)[number], values: Float64Array) {
      const out: { x: number; y: number; width: number }[] = []
      let offset = 0
      for (const points of piece.shape) {
        const xs: number[] = [], ys: number[] = []
        for (let p = 0; p < points; p++) {
          xs.push(values[offset + p * 2]); ys.push(values[offset + p * 2 + 1])
        }
        out.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, width: Math.max(...xs) - Math.min(...xs) })
        offset += points * 2
      }
      return out
    }

    it('plays the same assembly, tilt and pieces as the collapse that carries its cells off', () => {
      expect(lingering.tilt.sample(0.5)).toEqual(scene.tilt.sample(0.5))
      lingering.pieces.forEach((piece, i) => {
        expect(piece.shape).toEqual(scene.pieces[i].shape)
        expect(piece.material.sample(0.2)).toEqual(scene.pieces[i].material.sample(0.2))
      })
    })

    it('leaves every cell at rest by the time the collapse is over, as a visible dot', () => {
      for (const piece of lingering.pieces) {
        const resting = cells(piece, piece.material.sample(COLLAPSE_MARK_GONE))
        expect(cells(piece, piece.material.sample(1))).toEqual(resting)
        for (const cell of resting) {
          expect(cell.width).toBeGreaterThan(COLLAPSE_MARK_PITCH * 0.15)
          expect(cell.width).toBeLessThan(COLLAPSE_MARK_PITCH * 0.5)
        }
      }
    })

    it('slows its drift to a stop rather than speeding away', () => {
      // Every cell still on its way late in the collapse covers only a
      // sliver of that way in the collapse's final stretch.
      const piece = lingering.pieces.find((p) => p.shape.length)!
      const before = cells(piece, piece.material.sample(0.6))
      const late = cells(piece, piece.material.sample(COLLAPSE_MARK_GONE - 0.02))
      const rest = cells(piece, piece.material.sample(COLLAPSE_MARK_GONE))
      rest.forEach((cell, i) => {
        const tail = Math.hypot(cell.x - late[i].x, cell.y - late[i].y)
        const whole = Math.hypot(cell.x - before[i].x, cell.y - before[i].y)
        if (whole > 1) expect(tail / whole).toBeLessThan(0.05)
      })
    })

    describe('from partway through the collapse', () => {
      const from = 0.45
      const partway = collapseMarkScene({ lingerFrom: from })
      const width = (piece: number, t: number, s = partway) => cells(s.pieces[piece], s.pieces[piece].material.sample(t)).map((c) => c.width)

      it('is the ordinary collapse until then', () => {
        partway.pieces.forEach((piece, i) => {
          for (const t of [COLLAPSE_MARK_COLLAPSE_START, 0.3, from]) expect(piece.material.sample(t)).toEqual(scene.pieces[i].material.sample(t))
        })
      })

      it('lets cells already fading go, and keeps every other as a dot at rest', () => {
        const everyCell = partway.pieces.flatMap((_, i) => width(i, COLLAPSE_MARK_GONE))
        const kept = everyCell.filter((w) => w > 0.5)
        const gone = everyCell.filter((w) => w <= 0.5)
        // Some had gone before lingering began, most had not.
        expect(gone.length).toBeGreaterThan(0)
        expect(kept.length).toBeGreaterThan(gone.length)
        for (const w of kept) expect(w).toBeLessThan(COLLAPSE_MARK_PITCH * 0.5)
        partway.pieces.forEach((piece, i) => {
          expect(cells(piece, piece.material.sample(1))).toEqual(cells(piece, piece.material.sample(COLLAPSE_MARK_GONE)))
          // Carried off in the ordinary collapse, the same cells are all gone.
          expect(width(i, COLLAPSE_MARK_GONE, scene).every((w) => w <= 0.5)).toBe(true)
        })
      })

      it('catches a cell on its way without a jump', () => {
        const piece = partway.pieces[0]
        const before = cells(piece, piece.material.sample(from))
        const after = cells(piece, piece.material.sample(from + 0.004))
        before.forEach((cell, i) => expect(Math.hypot(after[i].x - cell.x, after[i].y - cell.y)).toBeLessThan(2))
      })
    })
  })

  describe('dots to send away', () => {
    it('are none for a pass that never lingered', () => {
      expect(collapseMarkDots(null)).toEqual([])
    })

    it('are every cell, in the order they came apart, each ready once it has all but stopped', () => {
      const dots = collapseMarkDots(0)
      expect(dots).toHaveLength(49)
      expect(dots.map((d) => d.rank)).toEqual(Array.from({ length: 49 }, (_, i) => i))
      // The earliest are ready well before a third of the body is left standing…
      expect(dots.filter((d) => d.ready <= COLLAPSE_MARK_GATHER_FROM).length).toBeGreaterThan(5)
      // …and every one by the time the collapse is over.
      expect(Math.max(...dots.map((d) => d.ready))).toBeLessThanOrEqual(COLLAPSE_MARK_GONE)
    })

    it('leave out the cells already fading when lingering began', () => {
      const partway = collapseMarkDots(0.45)
      expect(partway.length).toBeLessThan(49)
      expect(partway.every((d) => d.ready > 0.45)).toBe(true)
    })
  })

  it('keys every track in order, including the collapse start', () => {
    for (const piece of scene.pieces) {
      expect(piece.material.keys).toContain(0.22)
      expect([...piece.material.keys]).toEqual([...piece.material.keys].sort((a, b) => a - b))
    }
  })
})
