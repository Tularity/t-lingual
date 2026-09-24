/**
 * Pins the invariants the geometry promises, so the next tuning of a cut cannot
 * silently notch the circle, put ink deep inside the T, leave a break that
 * reads as half-joined, change the drawing between renders, or move a size
 * onto a cut that turns to a grey disc.
 */
import { describe, expect, it } from 'vitest'
import {
  MARK_CENTRE,
  MARK_RADIUS,
  cutForSize,
  layoutMark,
  type MarkCut,
  type MarkLayout,
  type MarkRect,
  type MarkSegment,
} from './markGeometry'

const CUTS: MarkCut[] = ['display', 'small', 'micro']
const ACCENTS: Record<MarkCut, number> = { display: 4, small: 2, micro: 1 }
const S = Math.SQRT1_2

function distanceFromCentre(x: number, y: number): number {
  return Math.hypot(x - MARK_CENTRE, y - MARK_CENTRE)
}

function length(segment: MarkSegment): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
}

function ends(segment: MarkSegment): [number, number][] {
  return [
    [segment.x1, segment.y1],
    [segment.x2, segment.y2],
  ]
}

/** How far the ink of a capped end at (x, y) reaches into the clear
 *  rectangle; 0 when it stays outside. */
function penetration(x: number, y: number, r: number, rect: MarkRect): number {
  return Math.max(0, Math.min(x - (rect.x1 - r), rect.x2 + r - x, y - (rect.y1 - r), rect.y2 + r - y))
}

/** True when the capped end at (x, y) touches the rim. */
function atRim(x: number, y: number, r: number): boolean {
  return distanceFromCentre(x, y) + r >= MARK_RADIUS - 0.03
}

/** Position along the hatch direction — the geometry's `u`. */
function along(x: number, y: number): number {
  return (x - MARK_CENTRE - (y - MARK_CENTRE)) / (2 * S)
}

function pitchOf(layout: MarkLayout): number {
  return layout.offsets[1] - layout.offsets[0]
}

/** Distance from a point to a capped stroke, 0 on the ink. */
function distanceToInk(px: number, py: number, segment: MarkSegment): number {
  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - segment.x1) * dx + (py - segment.y1) * dy) / len2))
  return Math.max(0, Math.hypot(px - (segment.x1 + t * dx), py - (segment.y1 + t * dy)) - segment.width / 2)
}

/** The same hatch with no T cut out of it: the silhouette the disc would have
 *  on its own, which is the reference the real rim is held to. */
function uncut(layout: MarkLayout): MarkSegment[] {
  const width = layout.segments[0].width
  const reach = MARK_RADIUS - width / 2
  return layout.offsets.flatMap((v, line) => {
    const half = Math.sqrt(reach * reach - v * v)
    if (!(half > 0)) return []
    return [
      {
        line,
        piece: 0,
        edge: false,
        ink: 1 as const,
        x1: MARK_CENTRE + S * (-half + v),
        y1: MARK_CENTRE + S * (v + half),
        x2: MARK_CENTRE + S * (half + v),
        y2: MARK_CENTRE + S * (v - half),
        width,
      },
    ]
  })
}

/** How much barer the rim is than the uncut hatch's, at its worst point, in
 *  view-box units. The hatch's own rim gaps — wide near its poles, where the
 *  lines meet the circle at a glancing angle — do not count; only what the T
 *  took away does. A notch shows up here as a jump; a rim kept whole reads 0. */
function notch(layout: MarkLayout): number {
  const reference = uncut(layout)
  let worst = 0
  for (let deg = 0; deg < 360; deg += 2) {
    const a = (deg * Math.PI) / 180
    const px = MARK_CENTRE + MARK_RADIUS * Math.cos(a)
    const py = MARK_CENTRE + MARK_RADIUS * Math.sin(a)
    let actual = Infinity
    let natural = Infinity
    for (const segment of layout.segments) actual = Math.min(actual, distanceToInk(px, py, segment))
    for (const segment of reference) natural = Math.min(natural, distanceToInk(px, py, segment))
    worst = Math.max(worst, actual - natural)
  }
  return worst
}

interface Gap {
  line: number
  from: MarkSegment
  to: MarkSegment
  /** Clear space between the two caps. */
  clear: number
  /** Centre of the gap along the line. */
  at: number
}

/** Every gap between consecutive pieces on one line. */
function gaps(layout: MarkLayout): Gap[] {
  const byLine = new Map<number, MarkSegment[]>()
  for (const s of layout.segments) byLine.set(s.line, [...(byLine.get(s.line) ?? []), s])
  const out: Gap[] = []
  for (const pieces of byLine.values()) {
    for (let i = 1; i < pieces.length; i += 1) {
      const from = pieces[i - 1]
      const to = pieces[i]
      out.push({
        line: from.line,
        from,
        to,
        clear: Math.hypot(to.x1 - from.x2, to.y1 - from.y2) - from.width,
        at: (along(from.x2, from.y2) + along(to.x1, to.y1)) / 2,
      })
    }
  }
  return out
}

/** The breaks alone: gaps the cut's own texture has that the solid one has not. */
function breaks(cut: MarkCut): Gap[] {
  const key = (g: Gap) => `${g.line}:${along(g.from.x2, g.from.y2).toFixed(1)}`
  const solid = new Set(gaps(layoutMark(cut, 'solid')).map(key))
  return gaps(layoutMark(cut)).filter((g) => !solid.has(key(g)))
}

describe('layoutMark', () => {
  for (const cut of CUTS) {
    const layout = layoutMark(cut)

    it(`${cut}: every cap stays inside the disc, and every piece is a dash`, () => {
      expect(layout.segments.length).toBeGreaterThan(0)
      for (const segment of layout.segments) {
        const r = segment.width / 2
        for (const [x, y] of ends(segment)) {
          // Rounding to hundredths can put an end a hundredth past the line.
          expect(distanceFromCentre(x, y) + r).toBeLessThanOrEqual(MARK_RADIUS + 0.02)
        }
        expect(length(segment)).toBeGreaterThanOrEqual(0.85)
      }
    })

    it(`${cut}: ink enters the T only where a rim dash needs it, and never past halfway`, () => {
      for (const segment of layout.segments) {
        const r = segment.width / 2
        for (const [x, y] of ends(segment)) {
          for (const rect of [layout.bar, layout.stem]) {
            const depth = penetration(x, y, r, rect)
            if (depth < 0.01) continue
            // A shaved corner, never a bridge: the ink stays on the near side
            // of the rectangle's centreline.
            const clear = Math.min(rect.x2 - rect.x1, rect.y2 - rect.y1)
            expect(depth).toBeLessThan(clear / 2)
            // Only two pieces may erode: a pole line, which is never cut, and
            // the kept rim dash, whose other end is on the rim and which is
            // exactly RIM_KEEP long.
            if (segment.line === 0 || segment.line === layout.lines - 1) continue
            const [ox, oy] = ends(segment).find(([ex, ey]) => ex !== x || ey !== y)!
            expect(atRim(ox, oy, r)).toBe(true)
            expect(length(segment)).toBeLessThanOrEqual(1.42)
          }
        }
      }
    })

    it(`${cut}: the T never notches the rim`, () => {
      // Ink may erode the T, so the rim is exactly as full as the uncut
      // hatch's; a tenth of a unit covers coordinate rounding.
      expect(notch(layout)).toBeLessThan(0.1)
    })

    it(`${cut}: the hatch reaches both poles, so the silhouette is a full circle`, () => {
      const outermost = Math.max(...layout.offsets.map(Math.abs))
      // Within three quarters of a pitch of the rim on both sides — the
      // property that keeps the top-left and bottom-right of the disc from
      // reading as clipped — and the outermost line must actually exist.
      expect(MARK_RADIUS - outermost).toBeLessThanOrEqual(pitchOf(layout) * 0.75)
      expect(Math.min(...layout.offsets)).toBeCloseTo(-outermost, 5)
      expect(layout.segments.some((s) => s.line === 0)).toBe(true)
      expect(layout.segments.some((s) => s.line === layout.lines - 1)).toBe(true)
    })

    it(`${cut}: the T is cut by real pieces, and they are marked as its edge`, () => {
      expect(layout.segments.filter((s) => s.edge).length).toBeGreaterThanOrEqual(6)
    })

    it(`${cut}: a handful of accents, spread out, brown first then deep`, () => {
      const accents = layout.segments.filter((s) => s.ink !== 1)
      expect(accents.length).toBe(ACCENTS[cut])
      expect(accents.filter((s) => s.ink === 3).length).toBe(Math.ceil(ACCENTS[cut] / 2))
      for (const a of accents) {
        expect(a.line).toBeGreaterThan(0)
        expect(a.line).toBeLessThan(layout.lines - 1)
        expect(length(a)).toBeGreaterThanOrEqual(2)
        expect(length(a)).toBeLessThanOrEqual(7.5)
        for (const b of accents) if (a !== b) expect(Math.abs(a.line - b.line)).toBeGreaterThanOrEqual(3)
      }
    })
  }

  it('is the same drawing on every call', () => {
    expect(layoutMark('display')).toEqual(layoutMark('display'))
    expect(JSON.stringify(layoutMark('display'))).toBe(JSON.stringify(layoutMark('display')))
  })

  it('breaks only the display cut, only long pieces, and never half-way', () => {
    expect(breaks('small')).toHaveLength(0)
    expect(breaks('micro')).toHaveLength(0)
    const display = breaks('display')
    expect(display.length).toBeGreaterThanOrEqual(3)
    const layout = layoutMark('display')
    const stemClear = layout.stem.x2 - layout.stem.x1
    for (const b of display) {
      const w = b.from.width
      // Reads as broken: at least 1.7 stroke widths of clear space...
      expect(b.clear).toBeGreaterThanOrEqual(1.7 * w - 0.03)
      // ...and still less than half the stem, so the T stays the loudest gap.
      expect(b.clear).toBeLessThan(stemClear / 2)
      // A real dash on both sides, never a speck.
      expect(length(b.from)).toBeGreaterThanOrEqual(2.15)
      expect(length(b.to)).toBeGreaterThanOrEqual(2.15)
    }
  })

  it('never lines a break up with one on the two lines either side', () => {
    const display = breaks('display')
    for (const a of display) {
      for (const b of display) {
        if (a === b || Math.abs(a.line - b.line) > 2) continue
        expect(Math.abs(a.at - b.at)).toBeGreaterThanOrEqual(1.8 - 0.03)
      }
    }
  })
})

describe('cutForSize', () => {
  it('hands each size the cut whose hatch survives a 1x rasteriser', () => {
    expect(cutForSize(12)).toBe('micro')
    expect(cutForSize(16)).toBe('micro')
    expect(cutForSize(23)).toBe('micro')
    expect(cutForSize(24)).toBe('small')
    expect(cutForSize(32)).toBe('small')
    expect(cutForSize(47)).toBe('small')
    expect(cutForSize(48)).toBe('display')
    expect(cutForSize(128)).toBe('display')
  })
})
