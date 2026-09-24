/* ---------------------------------------------------------------------------
 * THE MARK'S GEOMETRY
 *
 * The Tularity mark is a disc of fine diagonal hatching with a T cut out of
 * it. The letter is never drawn: it is a T-shaped hole punched through
 * parallel lines. A few of the longer lines are broken once, a few pieces take
 * a second colour, and the T's straight, aligned, far wider edges win against
 * both. Light through a slatted coin.
 *
 * Everything is computed rather than stored as path data, because the mark
 * ships in three cuts and its loaders need to address each line. The work is
 * done in the hatch's own frame: `u` runs along a line, `v` across them, and
 * the screen point is `centre + u·d + v·n` for the unit direction `d` and its
 * normal `n`. In that frame a line is an interval of `u`, the disc bounds it at
 * `±sqrt((R - w/2)² - v²)` — the round caps stay inside the circle exactly —
 * and the T's two rectangles, grown by half a stroke so a cap can never dip
 * into them, each subtract one interval. What is left is the ink.
 *
 * THE CIRCLE COMES FIRST
 * ----------------------
 * Two rules keep the silhouette a complete circle. The lines sit at half-pitch
 * offsets, `(k + ½)·pitch`, never on the centre: on whole multiples the
 * outermost pair lands a full pitch short of the hatch's two poles — top-left
 * and bottom-right for a rising hatch — and the disc reads as clipped there.
 * And every line keeps a dash of at least RIM_KEEP at each end that reaches
 * the rim, even where the T would cut it shorter: the T gives way instead,
 * eroded by exactly the amount the dash needs. A letter with a corner shaved
 * by a hair is still the letter; a circle with a notch is a different shape.
 * The T's top-right corner is where this happens — along the hatch direction
 * it lies closest to the rim. The T's top-left corner sits on the hatch's
 * top-left pole instead, where the outermost line is short and is the whole
 * silhouette; that line is never cut at all, and runs straight across the
 * corner.
 *
 * THE BREAKS ARE NOT RANDOM
 * -------------------------
 * They look it, and they must never change: a brand mark that redraws itself
 * differently on every render is not a mark. The breaks come from a seeded
 * generator with a fixed seed, so the same cut yields the same drawing on
 * every machine. Only a long piece breaks, at most twice, and a break leaves a
 * real dash on either side and a clear gap of at least 1.7 stroke widths — a
 * narrower gap reads as a line half-joined rather than a line broken, and a
 * break near a piece's end reads as a speck. A break may not line up with one
 * on the two lines either side, which is what would otherwise draw a false
 * seam across the hatch. The T's gaps stay more than twice any break's.
 *
 * THE ACCENTS
 * -----------
 * A handful of pieces per cut — four on the display cut — take a second ink,
 * alternating the brand brown and a deeper amber. The seeded generator picks
 * them from the medium-length pieces, on lines at least three apart and spread
 * over the four quadrants, so they read as a few deliberate touches rather
 * than a pattern or a blot. Everything else is the one base amber.
 *
 * THREE CUTS, NOT ONE DRAWING SCALED
 * ----------------------------------
 * Twenty hatch lines in sixteen pixels are a grey disc. The small and micro
 * cuts use fewer, heavier lines, a wider T and no breaks — the texture is the
 * first thing a small size has to give up, and the T the last.
 * ------------------------------------------------------------------------- */

/** Centre of the 24-unit view box on both axes. */
export const MARK_CENTRE = 12
/** The circle every line end, cap included, lies within. */
export const MARK_RADIUS = 10.5
/** Hatch angle in degrees: lines rise to the right. Mark.css repeats this
 *  number in the `live` keyframes, which scale along the lines. */
export const MARK_ANGLE = 45

export type MarkCut = 'display' | 'small' | 'micro'
export type MarkTexture = 'broken' | 'solid'

export interface MarkRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MarkSegment {
  /** Hatch line index, top-left to bottom-right. */
  line: number
  /** Position of this piece along its line, bottom-left to top-right. */
  piece: number
  /** True when an end of this piece was cut by the T rather than by the rim
   *  or a break — the ink that draws the letter's edge. */
  edge: boolean
  /** Which of the mark's inks paints this piece: 1 the base amber, which is
   *  nearly everything; 2 the deeper amber and 3 the brand brown, the handful
   *  of accent pieces. Assigned here, not in CSS, because it is part of the
   *  drawing and must be the same on every render. */
  ink: 1 | 2 | 3
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
}

export interface MarkLayout {
  cut: MarkCut
  /** Hatch line count, for the loaders' per-line phase. */
  lines: number
  /** Perpendicular offset of each hatch line from the centre. */
  offsets: number[]
  /** The two clear rectangles of the letter, in view-box units. */
  bar: MarkRect
  stem: MarkRect
  segments: MarkSegment[]
}

interface CutSpec {
  pitch: number
  width: number
  bar: MarkRect
  stem: MarkRect
  texture: MarkTexture
  /** How many pieces take an accent ink. */
  accents: number
}

const CUTS: Record<MarkCut, CutSpec> = {
  /* 48px and up: twenty lines at a hatch gap of 0.45, the breaks, and four
   * accents. The stem's 2.8 and the bar's 3.2 are each over twice any break. */
  display: {
    pitch: 1.05,
    width: 0.6,
    bar: { x1: 5.2, y1: 5.9, x2: 18.8, y2: 9.1 },
    stem: { x1: 10.6, y1: 9.1, x2: 13.4, y2: 20.5 },
    texture: 'broken',
    accents: 4,
  },
  /* 24-47px: ten lines, heavier, no breaks, two accents. */
  small: {
    pitch: 2.0,
    width: 1.15,
    bar: { x1: 5.0, y1: 5.9, x2: 19.0, y2: 9.1 },
    stem: { x1: 10.6, y1: 9.1, x2: 13.4, y2: 20.2 },
    texture: 'solid',
    accents: 2,
  },
  /* Below 24px: eight lines at a device pixel and a half, one accent, and the
   * T is the only hole. */
  micro: {
    pitch: 2.6,
    width: 1.5,
    bar: { x1: 5.4, y1: 5.7, x2: 18.6, y2: 9.3 },
    stem: { x1: 10.5, y1: 9.3, x2: 13.5, y2: 20.0 },
    texture: 'solid',
    accents: 1,
  },
}

/* -- Rules ------------------------------------------------------------------- */

/** "TULA", so the drawing is the same on every machine. */
const SEED = 0x54554c41
/** Shortest dash a line keeps at an end that reaches the rim; the T gives way
 *  to it. */
const RIM_KEEP = 1.4
/** A piece the T leaves between its bar and stem shorter than this is dropped
 *  rather than drawn as a speck in the letter's inner corner. */
const MIN_PIECE = 0.9
/** Only a piece at least this long is broken; twice this long, up to twice. */
const LONG_PIECE = 5.5
/** Each dash a break leaves is at least this long. */
const MIN_DASH = 2.2
/** Clear gap of a break in stroke widths — under this a line reads as
 *  half-joined — and its floor in view-box units. */
const BREAK_GAP_WIDTHS = 1.7
const BREAK_GAP_MIN = 1.0
/** Seeded variation added to a break's gap. */
const BREAK_JITTER = 0.25
/** Fraction of eligible slots that actually break. */
const BREAK_CHANCE = 0.6
/** Breaks on lines within STAGGER_LINES of each other stay this far apart. */
const BREAK_STAGGER = 1.8
const STAGGER_LINES = 2
/** Length window an accent piece is drawn from: long enough to read as a
 *  touch of colour, short enough not to be a line's whole run. */
const ACCENT_MIN = 2.0
const ACCENT_MAX = 7.5
/** Accent pieces sit on lines at least this far apart. */
const ACCENT_LINE_GAP = 3

/** mulberry32: small, fast, and good enough for a dozen decisions a line. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round = (value: number) => Math.round(value * 100) / 100

interface Interval {
  u0: number
  u1: number
}

/**
 * Where the hatch line at offset `v` passes through `rect` grown by `r` on
 * every side, as an interval of `u`, or null when it misses.
 */
function crossing(rect: MarkRect, r: number, v: number, s: number): Interval | null {
  const c = MARK_CENTRE
  // x(u) = c + s(u + v) and y(u) = c + s(v - u); each pair of bounds becomes a
  // pair of bounds on u, and the line is inside where both hold.
  const ux0 = (rect.x1 - r - c) / s - v
  const ux1 = (rect.x2 + r - c) / s - v
  const uy0 = v - (rect.y2 + r - c) / s
  const uy1 = v - (rect.y1 - r - c) / s
  const u0 = Math.max(ux0, uy0)
  const u1 = Math.min(ux1, uy1)
  return u1 > u0 ? { u0, u1 } : null
}

/** Sorts intervals and joins any that overlap — the bar and the stem share a
 *  joint, and a line through it is cut once, not twice. */
function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.u0 - b.u0)
  const merged: Interval[] = []
  for (const next of sorted) {
    const last = merged[merged.length - 1]
    if (last && next.u0 <= last.u1) last.u1 = Math.max(last.u1, next.u1)
    else merged.push({ ...next })
  }
  return merged
}

interface Piece {
  span: Interval
  /** The piece starts / ends where the T cut it. */
  cutStart: boolean
  cutEnd: boolean
}

/** Removes the merged, sorted `cuts` from `span`, in order. */
function subtract(span: Interval, cuts: Interval[]): Piece[] {
  const pieces: Piece[] = []
  let start = span.u0
  let startWasCut = false
  for (const cut of cuts) {
    if (cut.u1 <= span.u0 || cut.u0 >= span.u1) continue
    if (cut.u0 > start) {
      pieces.push({ span: { u0: start, u1: Math.min(cut.u0, span.u1) }, cutStart: startWasCut, cutEnd: true })
    }
    start = Math.max(start, cut.u1)
    startWasCut = true
  }
  if (start < span.u1) pieces.push({ span: { u0: start, u1: span.u1 }, cutStart: startWasCut, cutEnd: false })
  return pieces
}

/**
 * Breaks a piece at seeded positions when it is long enough, returning the
 * dashes in order. A piece shorter than LONG_PIECE comes back whole. Every
 * slot consumes the same number of draws whether or not it breaks, so one
 * decision cannot reshuffle the ones after it. `previous` holds the break
 * positions of the lines just before this one; `taken` collects this line's.
 */
function breakUp(piece: Interval, width: number, rnd: () => number, previous: number[], taken: number[]): Interval[] {
  const length = piece.u1 - piece.u0
  const slots = Math.min(2, Math.floor(length / LONG_PIECE))
  if (slots === 0) return [piece]
  const gap = Math.max(BREAK_GAP_MIN, BREAK_GAP_WIDTHS * width)
  const parts: Interval[] = []
  let from = piece.u0
  for (let slot = 0; slot < slots; slot += 1) {
    const roll = rnd()
    const where = rnd()
    const size = rnd()
    if (roll > BREAK_CHANCE) continue
    // Half the centre-to-centre distance of the two dash ends: the clear gap
    // plus the two half-width caps that round them.
    const clear = (gap + size * BREAK_JITTER + width) / 2
    const slot0 = piece.u0 + (length * slot) / slots
    const slot1 = piece.u0 + (length * (slot + 1)) / slots
    const lo = Math.max(slot0, from) + MIN_DASH + clear
    const hi = slot1 - MIN_DASH - clear
    if (hi <= lo) continue
    const at = lo + (hi - lo) * where
    if (previous.some((p) => Math.abs(p - at) < BREAK_STAGGER)) continue
    parts.push({ u0: from, u1: at - clear })
    from = at + clear
    taken.push(at)
  }
  parts.push({ u0: from, u1: piece.u1 })
  return parts
}

/**
 * Chooses `count` accent pieces and paints them, alternating brown and deep
 * amber. Candidates are the medium-length pieces off the two outermost lines
 * (a coloured rim line reads as a shadow on the disc); they are visited in a
 * seeded order and taken when they sit far enough from the ones already
 * chosen. The first pass insists on a fresh quadrant each time so the touches
 * spread over the disc; a second pass, rarely needed, fills any remainder.
 */
function paintAccents(segments: MarkSegment[], count: number, lines: number): void {
  if (count <= 0) return
  const paint = seeded(SEED ^ 0x9e3779b9)
  const candidates = segments
    .map((segment) => ({
      segment,
      key: paint(),
      length: Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1),
    }))
    .filter(
      ({ segment, length }) =>
        length >= ACCENT_MIN && length <= ACCENT_MAX && segment.line > 0 && segment.line < lines - 1,
    )
    .sort((a, b) => a.key - b.key)

  const chosen: MarkSegment[] = []
  const quadrants = new Set<string>()
  const farEnough = (segment: MarkSegment) =>
    chosen.every((other) => Math.abs(other.line - segment.line) >= ACCENT_LINE_GAP)
  const quadrantOf = (segment: MarkSegment) =>
    `${(segment.x1 + segment.x2) / 2 < MARK_CENTRE ? 'l' : 'r'}${(segment.y1 + segment.y2) / 2 < MARK_CENTRE ? 't' : 'b'}`

  for (const { segment } of candidates) {
    if (chosen.length === count) break
    if (!farEnough(segment) || quadrants.has(quadrantOf(segment))) continue
    quadrants.add(quadrantOf(segment))
    chosen.push(segment)
  }
  for (const { segment } of candidates) {
    if (chosen.length === count) break
    if (chosen.includes(segment) || !farEnough(segment)) continue
    chosen.push(segment)
  }
  chosen.forEach((segment, k) => {
    segment.ink = k % 2 === 0 ? 3 : 2
  })
}

/* -- Layout ------------------------------------------------------------------ */

/** Which cut a mark rendered at `size` CSS pixels should use. */
export function cutForSize(size: number): MarkCut {
  if (size >= 48) return 'display'
  if (size >= 24) return 'small'
  return 'micro'
}

export function layoutMark(cut: MarkCut, texture?: MarkTexture): MarkLayout {
  const spec = CUTS[cut]
  const broken = (texture ?? spec.texture) === 'broken'
  const w = spec.width
  const r = w / 2
  const s = Math.SQRT1_2 // sin and cos of the 45° hatch
  const reach = MARK_RADIUS - r

  // Half-pitch offsets, symmetric about the centre — see the header.
  const count = Math.floor(reach / spec.pitch + 0.5)
  const offsets: number[] = []
  for (let k = -count; k < count; k += 1) offsets.push((k + 0.5) * spec.pitch)

  const segments: MarkSegment[] = []
  const recentBreaks: number[][] = []

  offsets.forEach((v, line) => {
    const half = Math.sqrt(reach * reach - v * v)
    if (!(half > 0)) return
    const rnd = seeded(SEED + line * 7919)

    // The pole lines are the silhouette at the hatch's two poles and are
    // exempt from the T — see the header.
    const pole = line === 0 || line === offsets.length - 1
    let cuts = pole
      ? []
      : merge([crossing(spec.bar, r, v, s), crossing(spec.stem, r, v, s)].filter((c): c is Interval => c !== null))
    if (cuts.length > 0) {
      // THE CIRCLE COMES FIRST — see the header. The first cut may not start
      // within RIM_KEEP of the line's start, nor the last end within RIM_KEEP
      // of its end; a cut this empties was only clipping a corner, and the
      // line runs straight across it.
      cuts[0] = { ...cuts[0], u0: Math.max(cuts[0].u0, RIM_KEEP - half) }
      const last = cuts.length - 1
      cuts[last] = { ...cuts[last], u1: Math.min(cuts[last].u1, half - RIM_KEEP) }
      cuts = cuts.filter((c) => c.u1 > c.u0)
    }
    const pieces = subtract({ u0: -half, u1: half }, cuts).filter(({ span }) => span.u1 - span.u0 >= MIN_PIECE)

    const breaks: number[] = []
    let index = 0
    for (const { span, cutStart, cutEnd } of pieces) {
      const parts = broken ? breakUp(span, w, rnd, recentBreaks.flat(), breaks) : [span]
      parts.forEach((part, i) => {
        segments.push({
          line,
          piece: index,
          edge: (i === 0 && cutStart) || (i === parts.length - 1 && cutEnd),
          ink: 1,
          x1: round(MARK_CENTRE + s * (part.u0 + v)),
          y1: round(MARK_CENTRE + s * (v - part.u0)),
          x2: round(MARK_CENTRE + s * (part.u1 + v)),
          y2: round(MARK_CENTRE + s * (v - part.u1)),
          width: w,
        })
        index += 1
      })
    }
    recentBreaks.push(breaks)
    if (recentBreaks.length > STAGGER_LINES) recentBreaks.shift()
  })

  paintAccents(segments, spec.accents, offsets.length)

  return { cut, lines: offsets.length, offsets, bar: spec.bar, stem: spec.stem, segments }
}
