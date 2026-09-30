/* ---------------------------------------------------------------------------
 * The collapse, as numbers over time, and a canvas player for them.
 *
 * One sequence, 0..1: the four pieces fade in from around the body and
 * assemble, upright; at 22% the collapse starts at the upper-right corner and
 * runs through the whole body, every cell shrinking toward a rounded tile
 * while it drifts up and to the right, slowly and then faster, until it is
 * gone. The body tilts to the logo's 22° during the first third of the
 * collapse and holds it. The last frame is empty.
 *
 * Or, lingering from some moment of the collapse on: every cell that has yet
 * to go shrinks only to a round dot and is thrown outward, away from the
 * body's centre and a little the tail's way, slowly, then faster, then
 * slowing to a stop, and stays; a cell already on its way is caught — its
 * drift slows from the speed it had to a stop as it too is thrown outward,
 * and it shrinks no further than a dot — unless it had already begun to fade,
 * in which case it goes on leaving. The last frame holds the dots, scattered,
 * and the player can then send them into a logo elsewhere on the page (a
 * gathering; see CollapseMarkGather).
 *
 * Every animated value is a track: a fixed list of key times and a way to
 * compute the value at any of them. The player samples only the two keys
 * around the current instant and interpolates between them linearly, so a
 * frame costs two geometry evaluations per key interval, not one per frame,
 * and the motion between keys is exactly as smooth as the keys are dense.
 * Values are rounded as they are sampled — angles and offsets to 1e-5,
 * outline points to 1e-3 — and that rounding is part of the drawing's
 * definition, not an optimisation: it is what keeps every copy of the
 * animation identical to the approved one.
 *
 * Pure apart from the player at the bottom, and free of the DOM apart from a
 * 2D canvas context, so the same module runs in a worker.
 * ------------------------------------------------------------------------- */
import {
  COLLAPSE_MARK_ANGLE,
  COLLAPSE_MARK_PIECES,
  COLLAPSE_MARK_PITCH,
  type CollapseMarkCellData,
} from './collapseMarkData'
import { COLLAPSE_MARK_COLLAPSE_START, COLLAPSE_MARK_GATHER_FLIGHT_MS, COLLAPSE_MARK_GATHER_STAGGER_MS, COLLAPSE_MARK_GONE } from './collapseMarkTiming'

type Point = [number, number]

/** Seconds for one sequence at normal speed. */
export const COLLAPSE_MARK_SECONDS = 12
/**
 * The frame the collapse is shown in, as a viewBox: the static logo file's
 * own, which is centred on the body square, so the body turns about the
 * middle of whatever box plays it and sits exactly where the static logo's
 * does. Over the whole sequence the drawing reaches at most 93 units across
 * and 72 up or down from the body centre, inside the frame's 120 and 90.
 */
export const COLLAPSE_MARK_FRAME = [-37, 7, 240, 180] as const

const CENTRE_X = 83
const CENTRE_Y = 97
const COLLAPSE_START = COLLAPSE_MARK_COLLAPSE_START
const FRONT_SPAN = 0.48
const TILT_LOCK = COLLAPSE_START + FRONT_SPAN / 3
const SHRINK_TIME = 0.1
const FLIGHT_TIME = 0.17
/** A lingering cell's resting size, as a share of the lattice pitch. */
const LINGER_SIZE = 0.42
/** A cell already this far through its life when lingering begins has begun
 *  to fade, and goes on leaving; one not so far is caught… */
const HOLD_BEFORE = 0.65
/** …and brought to rest over this much of the sequence, or what is left of
 *  the collapse, whichever is shorter. */
const HOLD_TIME = 0.2
/** Where each piece starts its approach from, before the tilt, by piece. */
const ORIGINS: readonly Point[] = [[-30, -18], [27, -20], [-26, 22], [28, 22]]

const n = (v: number) => Math.round(v * 100000) / 100000
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0]
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]

const frontProgress = (time: number) => clamp((time - COLLAPSE_START) / FRONT_SPAN)
/** The body's tilt at `time`: upright, then 22° within the first third of the collapse. */
export const collapseBodyAngle = (time: number) => COLLAPSE_MARK_ANGLE * smooth(0, 1 / 3, frontProgress(time))
const onset = (cell: CollapseMarkCellData) => COLLAPSE_START + (FRONT_SPAN * (cell.rank + 0.25)) / 49

/* ------------------------------------------------------------------------ */
/* One cell                                                                  */
/* ------------------------------------------------------------------------ */

interface Outline { centre: Point; points: { original: Point; direction: Point }[] }

/**
 * The outline as rays from its centroid: its own vertices plus 48 evenly
 * spaced directions, so it can be morphed point for point into a rounded
 * square sampled along the same rays.
 */
function prepareOutline(ring: readonly (readonly [number, number])[]): Outline {
  let area = 0, x = 0, y = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point, b = ring[(i + 1) % ring.length] as Point, weight = cross(a, b)
    area += weight; x += (a[0] + b[0]) * weight; y += (a[1] + b[1]) * weight
  }
  const centre: Point = [x / (3 * area), y / (3 * area)]
  const angles = [
    ...ring.map((p) => Math.atan2(p[1] - centre[1], p[0] - centre[0])),
    ...Array.from({ length: 48 }, (_, i) => -Math.PI + (i * Math.PI) / 24),
  ]
  const sorted = [...new Set(angles.map((a) => Math.round(a * 1e9) / 1e9))].sort((a, b) => a - b)
  const points = sorted.map((angle) => {
    const direction: Point = [Math.cos(angle), Math.sin(angle)]
    let distance = Infinity
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point, edge = subtract(ring[(i + 1) % ring.length] as Point, a), offset = subtract(a, centre)
      const denominator = cross(direction, edge)
      if (Math.abs(denominator) < 1e-9) continue
      const ray = cross(offset, edge) / denominator, segment = cross(offset, direction) / denominator
      if (ray > -1e-7 && segment >= -1e-7 && segment <= 1 + 1e-7) distance = Math.min(distance, Math.max(0, ray))
    }
    if (!Number.isFinite(distance)) throw new Error('Cell outline has no radial boundary')
    return { direction, original: [centre[0] + direction[0] * distance, centre[1] + direction[1] * distance] as Point }
  })
  return { centre, points }
}

/** Projects only the points inside a newly rounded corner; shared edges stay exact. */
function trimCorner(point: Point, half: number, radii: number[]): Point {
  const sx = point[0] >= 0 ? 1 : -1, sy = point[1] >= 0 ? 1 : -1
  const radius = radii[sy < 0 ? (sx < 0 ? 0 : 1) : sx < 0 ? 3 : 2]
  if (!radius) return point
  const cx = half - radius, cy = half - radius
  const dx = Math.abs(point[0]) - cx, dy = Math.abs(point[1]) - cy
  const distance = Math.hypot(dx, dy)
  if (dx <= 0 || dy <= 0 || distance <= radius) return point
  return [sx * (cx + (dx * radius) / distance), sy * (cy + (dy * radius) / distance)]
}

function roundedRay(direction: Point, half: number, radius: number): Point {
  const ax = Math.abs(direction[0]), ay = Math.abs(direction[1])
  let distance = half / Math.max(ax, ay)
  if (radius && ax * distance > half - radius && ay * distance > half - radius) {
    const c = half - radius, projection = c * (ax + ay)
    distance = projection + Math.sqrt(Math.max(0, projection * projection - 2 * c * c + radius * radius))
  }
  return [direction[0] * distance, direction[1] * distance]
}

function morphOutline(outline: Outline, pitch: number, scale: number, rounding: number, blend: number, edgeRadii: number[]): Point[] {
  const source = outline.points.map(({ original }) => trimCorner(original, pitch / 2, edgeRadii))
  const points: Point[] = outline.points.map(({ direction }, i) => {
    const target = roundedRay(direction, pitch / 2, pitch * rounding)
    return [source[i][0] * (1 - blend) + target[0] * blend, source[i][1] * (1 - blend) + target[1] * blend]
  })
  const area = (ring: Point[]) => Math.abs(ring.reduce((sum, p, i) => sum + cross(p, ring[(i + 1) % ring.length]), 0))
  // A small corner fragment must not gain material while becoming a regular cell.
  const ratio = Math.min(1, Math.sqrt(area(source) / Math.max(1e-9, area(points))))
  return points.map(([x, y]) => [x * scale * ratio, y * scale * ratio])
}

/**
 * A lingering cell's drift, 0 → 1 over its life: it gathers speed for the
 * first third and spends the rest slowing, arriving with no speed at all.
 */
const settle = (life: number) => 1 - (1 - life) ** 3 * (1 + 3 * life)
/** A fixed pseudo-random 0..1 for a cell, so the scatter is the same every time. */
const jitter = (cell: CollapseMarkCellData, salt: number) => {
  const v = Math.sin(cell.row * 12.9898 + cell.col * 78.233 + salt * 37.719) * 43758.5453
  return v - Math.floor(v)
}

/** A cell at one instant: its clocks, its size and rounding, where it is. */
interface CellState { age: number; life: number; size: number; radius: number; angle: number; x: number; y: number; opacity: number }

/** How far a leaving cell drifts over its whole life. */
const driftReach = (cell: CollapseMarkCellData) => 42 + ((cell.row + cell.col) % 3) * 5

/**
 * Where a cell is and what it looks like at `time` — lingering from
 * `lingerFrom` on, if given (see the header).
 */
function cellState(cell: CollapseMarkCellData, time: number, lingerFrom: number | null = null): CellState {
  if (lingerFrom !== null) {
    if (onset(cell) >= lingerFrom) return lingeringCellState(cell, time)
    if (time > lingerFrom && cellState(cell, lingerFrom).life < HOLD_BEFORE) return heldCellState(cell, time, lingerFrom)
  }
  const pitch = COLLAPSE_MARK_PITCH
  const age = clamp((time - onset(cell)) / SHRINK_TIME)
  const life = clamp((time - onset(cell)) / (SHRINK_TIME + FLIGHT_TIME))
  const size = pitch * (1 - smooth(0, 1, life)) ** 1.4
  const radius = 0.5 * smooth(0, 0.48, life)
  // The rotation clock slows continuously to rest; no velocity jump at release.
  const rotationTime = time <= onset(cell) ? time : onset(cell) + SHRINK_TIME * (age - age ** 3 + 0.5 * age ** 4)
  const angle = collapseBodyAngle(rotationTime), rad = (angle * Math.PI) / 180
  const anchorX = CENTRE_X + cell.x * Math.cos(rad) - cell.y * Math.sin(rad)
  const anchorY = CENTRE_Y + cell.x * Math.sin(rad) + cell.y * Math.cos(rad)
  const distance = driftReach(cell) * life ** 2.2
  return {
    age, life, size, radius, angle,
    x: anchorX + distance * 0.921,
    y: anchorY - distance * 0.391,
    opacity: 1 - smooth(0.65, 1, life),
  }
}

/** A lingering cell's throw outward, in full: the further out it was, the
 *  further it goes, each at its own slight angle and distance, so the lattice
 *  breaks up into a scatter. */
function scatter(cell: CollapseMarkCellData, anchorX: number, anchorY: number): Point {
  const dx = anchorX - CENTRE_X, dy = anchorY - CENTRE_Y, from = Math.hypot(dx, dy)
  // A cell at the very centre has no outward of its own: it takes one at random.
  const heading = (from > 1 ? Math.atan2(dy, dx) : jitter(cell, 3) * Math.PI * 2) + (jitter(cell, 1) - 0.5) * 0.7
  const reach = (8 + 0.8 * from) * (0.75 + 0.5 * jitter(cell, 2))
  return [Math.cos(heading) * reach, Math.sin(heading) * reach]
}

/** The same, for a cell that stays: it shrinks to a dot while its drift
 *  gets going, and is thrown outward from the body's centre, coming to rest. */
function lingeringCellState(cell: CollapseMarkCellData, time: number): CellState {
  const pitch = COLLAPSE_MARK_PITCH
  const age = clamp((time - onset(cell)) / SHRINK_TIME)
  const life = clamp((time - onset(cell)) / (SHRINK_TIME + FLIGHT_TIME))
  const size = pitch * (1 - (1 - LINGER_SIZE) * smooth(0, 0.6, life))
  const radius = 0.5 * smooth(0, 0.48, life)
  const rotationTime = time <= onset(cell) ? time : onset(cell) + SHRINK_TIME * (age - age ** 3 + 0.5 * age ** 4)
  const angle = collapseBodyAngle(rotationTime), rad = (angle * Math.PI) / 180
  const anchorX = CENTRE_X + cell.x * Math.cos(rad) - cell.y * Math.sin(rad)
  const anchorY = CENTRE_Y + cell.x * Math.sin(rad) + cell.y * Math.cos(rad)
  const [sx, sy] = scatter(cell, anchorX, anchorY)
  const out = settle(life), tail = 10 * out
  return {
    age, life, size, radius, angle,
    x: anchorX + sx * out + tail * 0.921,
    y: anchorY + sy * out - tail * 0.391,
    opacity: 1,
  }
}

/** A cell caught on its way when lingering begins at `from`: its drift slows
 *  from the speed it had to a stop, it is thrown outward like the rest, and
 *  it shrinks no further than a dot. Its turning and rounding carry on. */
function heldCellState(cell: CollapseMarkCellData, time: number, from: number): CellState {
  const going = cellState(cell, time)
  const then = cellState(cell, from)
  const span = SHRINK_TIME + FLIGHT_TIME
  const speed = (driftReach(cell) * 2.2 * then.life ** 1.2) / span
  const hold = Math.max(0.001, Math.min(HOLD_TIME, COLLAPSE_MARK_GONE - from))
  const u = clamp((time - from) / hold)
  const distance = driftReach(cell) * then.life ** 2.2 + speed * hold * (u - (u * u) / 2)
  const rad = (going.angle * Math.PI) / 180
  const anchorX = CENTRE_X + cell.x * Math.cos(rad) - cell.y * Math.sin(rad)
  const anchorY = CENTRE_Y + cell.x * Math.sin(rad) + cell.y * Math.cos(rad)
  const [sx, sy] = scatter(cell, anchorX, anchorY)
  const out = settle(u)
  const rest = Math.min(then.size, LINGER_SIZE * COLLAPSE_MARK_PITCH)
  return {
    age: going.age, life: going.life, radius: going.radius, angle: going.angle,
    size: then.size + (rest - then.size) * (1 - (1 - u) ** 2),
    x: anchorX + sx * out + distance * 0.921,
    y: anchorY + sy * out - distance * 0.391,
    opacity: 1,
  }
}

/** A lingering pass's dot: which cell it is, and the phase from which it has
 *  all but stopped, and may be sent away. */
export interface CollapseMarkDot { piece: number; cell: number; rank: number; ready: number }

/** The dots a pass lingering from `lingerFrom` leaves, in the order they became dots. */
export function collapseMarkDots(lingerFrom: number | null): CollapseMarkDot[] {
  if (lingerFrom === null) return []
  const span = SHRINK_TIME + FLIGHT_TIME
  const hold = Math.max(0.001, Math.min(HOLD_TIME, COLLAPSE_MARK_GONE - lingerFrom))
  const dots: CollapseMarkDot[] = []
  COLLAPSE_MARK_PIECES.forEach((piece, p) => piece.cells.forEach((cell, c) => {
    let ready: number
    if (onset(cell) >= lingerFrom) ready = onset(cell) + 0.8 * span
    else if (cellState(cell, lingerFrom).life < HOLD_BEFORE) ready = lingerFrom + 0.8 * hold
    else return
    dots.push({ piece: p, cell: c, rank: cell.rank, ready: Math.min(ready, COLLAPSE_MARK_GONE) })
  }))
  return dots.sort((a, b) => a.rank - b.rank)
}

/** A cell's corners that face a neighbour already collapsing round off with it. */
function edgeRadii(cell: CollapseMarkCellData, time: number, siblings: readonly CollapseMarkCellData[]) {
  const at = (dr: number, dc: number) => siblings.find((c) => c.row === cell.row + dr && c.col === cell.col + dc)
  const exposed = (dr: number, dc: number) => {
    const neighbour = at(dr, dc)
    return neighbour ? smooth(0, SHRINK_TIME * 0.65, time - onset(neighbour)) : 1
  }
  const top = exposed(-1, 0), right = exposed(0, 1), bottom = exposed(1, 0), left = exposed(0, -1)
  const radius = COLLAPSE_MARK_PITCH * 0.42
  // Existing corners already belong to the original outline; only new boundaries retract.
  const active = (a: number, b: number, dr: number, dc: number, er: number, ec: number) =>
    at(dr, dc) || at(er, ec) ? radius * a * b : 0
  return [
    active(top, left, -1, 0, 0, -1),
    active(top, right, -1, 0, 0, 1),
    active(bottom, right, 1, 0, 0, 1),
    active(bottom, left, 1, 0, 0, -1),
  ]
}

/* ------------------------------------------------------------------------ */
/* Tracks                                                                    */
/* ------------------------------------------------------------------------ */

/** One animated value: the times it is keyed at and how to compute it there. */
export interface CollapseMarkTrack {
  keys: readonly number[]
  sample: (time: number) => Float64Array
}

const STANDARD_TIMES = Array.from({ length: 121 }, (_, i) => i / 120)
const keyTimes = (extra: number[]) =>
  [...new Set([...STANDARD_TIMES, COLLAPSE_START, TILT_LOCK, ...extra].filter((t) => t >= 0 && t <= 1).map(n))].sort((a, b) => a - b)
const track = (sample: (time: number) => Float64Array, extra: number[] = []): CollapseMarkTrack => ({ keys: keyTimes(extra), sample })

export interface CollapseMarkPieceTracks {
  /** 0 solid, 1 base, 2 light. */
  tone: 0 | 1 | 2
  opacity: CollapseMarkTrack
  translate: CollapseMarkTrack
  /** Every cell's outline in logo units: x, y pairs, `shape[i]` points for cell i. */
  material: CollapseMarkTrack
  shape: readonly number[]
}

export interface CollapseMarkScene {
  /** Rotation of the whole drawing about the body centre, in degrees. */
  tilt: CollapseMarkTrack
  pieces: readonly CollapseMarkPieceTracks[]
}

/** `lingerFrom` leaves the cells resting as dots from that phase on, instead
 *  of carrying them off; 0 lingers throughout. */
export function collapseMarkScene({ lingerFrom = null }: { lingerFrom?: number | null } = {}): CollapseMarkScene {
  const radians = (COLLAPSE_MARK_ANGLE * Math.PI) / 180
  const held = lingerFrom === null ? [] : [lingerFrom, lingerFrom + Math.min(HOLD_TIME, COLLAPSE_MARK_GONE - lingerFrom)]
  const events = (c: CollapseMarkCellData) => [onset(c), onset(c) + SHRINK_TIME * 0.35, onset(c) + SHRINK_TIME, onset(c) + SHRINK_TIME + FLIGHT_TIME, ...held]
  return {
    tilt: track((t) => Float64Array.of(n(collapseBodyAngle(t) - COLLAPSE_MARK_ANGLE)), [COLLAPSE_START, TILT_LOCK]),
    pieces: COLLAPSE_MARK_PIECES.map((piece, index) => {
      const begin = 0.01 + index * 0.012, end = 0.16 + index * 0.012
      const assembly = (t: number) => smooth(begin, end, t)
      const [ox, oy] = ORIGINS[index]
      const offset = [ox * Math.cos(radians) - oy * Math.sin(radians), ox * Math.sin(radians) + oy * Math.cos(radians)]
      const outlines = piece.cells.map((cell) => prepareOutline(cell.outline))
      // Each cell's outline, turned back from the body's current tilt into
      // the drawing's frame, which the tilt track then turns as a whole.
      const material = (time: number) => {
        const out: number[] = []
        const undoTilt = ((COLLAPSE_MARK_ANGLE - collapseBodyAngle(time)) * Math.PI) / 180
        piece.cells.forEach((cell, i) => {
          const s = cellState(cell, time, lingerFrom)
          const rotation = ((s.angle + COLLAPSE_MARK_ANGLE - collapseBodyAngle(time)) * Math.PI) / 180
          const dx = s.x - CENTRE_X, dy = s.y - CENTRE_Y
          const x = CENTRE_X + dx * Math.cos(undoTilt) - dy * Math.sin(undoTilt)
          const y = CENTRE_Y + dx * Math.sin(undoTilt) + dy * Math.cos(undoTilt)
          const contour = morphOutline(
            outlines[i], COLLAPSE_MARK_PITCH, (s.size / COLLAPSE_MARK_PITCH) * Math.sqrt(s.opacity), s.radius,
            smooth(0, 0.85, s.age), edgeRadii(cell, time, piece.cells),
          )
          for (const [px, py] of contour) {
            out.push(
              Math.round((x + px * Math.cos(rotation) - py * Math.sin(rotation)) * 1000) / 1000,
              Math.round((y + px * Math.sin(rotation) + py * Math.cos(rotation)) * 1000) / 1000,
            )
          }
        })
        return Float64Array.from(out)
      }
      return {
        tone: piece.tone,
        opacity: track((t) => Float64Array.of(n(assembly(t))), [begin, end]),
        translate: track((t) => Float64Array.of(n(offset[0] * (1 - assembly(t))), n(offset[1] * (1 - assembly(t)))), [begin, end]),
        material: track(material, piece.cells.flatMap(events)),
        shape: outlines.map((o) => o.points.length),
      }
    }),
  }
}

/* ------------------------------------------------------------------------ */
/* Player                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * One track, played. Keeps the samples it has computed for the keys either
 * side of the current instant, which covers every frame of normal playback;
 * a seek costs two more.
 */
class TrackPlayer {
  private cache = new Map<number, Float64Array>()
  constructor(private readonly track: CollapseMarkTrack) {}
  private key(index: number) {
    let value = this.cache.get(index)
    if (!value) {
      value = this.track.sample(this.track.keys[index])
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(index, value)
    }
    return value
  }
  /** Linear between key times, held at either end. */
  at(phase: number): Float64Array {
    const keys = this.track.keys
    if (phase <= keys[0]) return this.key(0)
    const last = keys.length - 1
    if (phase >= keys[last]) return this.key(last)
    let lo = 0, hi = last
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (keys[mid] <= phase) lo = mid
      else hi = mid
    }
    const from = this.key(lo), to = this.key(hi)
    const f = (phase - keys[lo]) / (keys[hi] - keys[lo])
    const out = new Float64Array(from.length)
    for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * f
    return out
  }
}

function pathOf(values: Float64Array, shape: readonly number[], skip?: ReadonlySet<number>) {
  const path = new Path2D()
  let i = 0
  shape.forEach((points, cell) => {
    if (skip?.has(cell)) {
      i += points * 2
      return
    }
    for (let p = 0; p < points; p++, i += 2) {
      if (p) path.lineTo(values[i], values[i + 1])
      else path.moveTo(values[i], values[i + 1])
    }
    path.closePath()
  })
  return path
}

/** The three piece inks, solid, base and light, as CSS colours. */
export type CollapseMarkInks = readonly [string, string, string]

/** Where the drawing's frame sits on the canvas: x, y, width, height, in device pixels. */
export type CollapseMarkBox = readonly [number, number, number, number]

/**
 * Lingering dots sent into a logo. They leave one at a time in the order they
 * became dots — each once it has all but stopped, and no sooner than
 * COLLAPSE_MARK_GATHER_STAGGER_MS after the one before — while the rest of the
 * collapse plays on. Each is drawn in on a gentle curve, slow to let go and
 * faster and faster as it nears, as if attracted, shrinking to the logo's
 * scale and then, once inside the logo's body, to nothing.
 */
export interface CollapseMarkGather {
  /** Which gathering this is; a new number begins a new one. */
  id: number
  /** When it began, and the time now, on the page's clock (ms). */
  since: number
  now: number
  /** The receiving logo's body centre, in the canvas's device pixels. */
  x: number
  y: number
  /** The receiving logo's size relative to this mark's. */
  scale: number
  /** Send the dots the previous pass left, all of them at rest, while the next pass plays. */
  previous?: boolean
}

/** What the player tells the page about a gathering: its first dot has left, or its last has arrived. */
export interface CollapseMarkGatherEvent { id: number; event: 'departed' | 'gathered' }

export interface CollapseMarkFrame {
  /** Where this pass began to linger, if it has (see collapseMarkScene). */
  lingerFrom?: number | null
  /** Lingering dots on their way somewhere, drawn over the frame. */
  gather?: CollapseMarkGather
}

export interface CollapseMarkPlayer {
  /** Draws the frame at `phase`, 0..1 of the sequence. */
  draw(phase: number, frame?: CollapseMarkFrame): void
  /**
   * Matches the backing store to the element's device-pixel size. `box` is
   * where the frame goes on it; by default the frame fills the canvas.
   */
  resize(width: number, height: number, box?: CollapseMarkBox): void
}

/** A dot in flight: its outline and centre, in device pixels, as it left. */
interface Flight { piece: number; points: Float64Array; x: number; y: number; leftAt: number }

export function createCollapseMarkPlayer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  inks: CollapseMarkInks,
  { box: initialBox, onGather }: { box?: CollapseMarkBox; onGather?: (event: CollapseMarkGatherEvent) => void } = {},
): CollapseMarkPlayer {
  const found = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  // No 2D context (a test DOM): nothing to draw on, and nothing else to do.
  if (!found) return { draw() {}, resize() {} }
  const context = found
  /** One way the sequence can play: carrying its cells off, or lingering from a moment on. */
  const play = (lingerFrom: number | null) => ({
    lingerFrom,
    pieces: collapseMarkScene({ lingerFrom }).pieces.map((piece) => ({
      fill: inks[piece.tone],
      shape: piece.shape,
      /** Where each cell's points begin in the piece's outline values. */
      starts: piece.shape.map((_, i) => piece.shape.slice(0, i).reduce((sum, points) => sum + points * 2, 0)),
      opacity: new TrackPlayer(piece.opacity),
      translate: new TrackPlayer(piece.translate),
      material: new TrackPlayer(piece.material),
    })),
  })
  type Played = ReturnType<typeof play>
  const tilt = new TrackPlayer(collapseMarkScene().tilt)
  let current = play(null)
  /** The way the pass before played, whose dots may still be on their way. */
  let previous: Played | null = null
  let box = initialBox
  let last: [number, CollapseMarkFrame | undefined] = [0, undefined]
  /** The gathering under way, or the last one, whose dots are gone from the frame. */
  let gathering: {
    id: number
    played: Played
    queue: { piece: number; cell: number; ready: number }[]
    flights: Flight[]
    gone: Set<number>[]
    lastLeft: number
    waiting: boolean
    told: boolean
  } | null = null

  /** The frame fitted to the box and centred, as an SVG viewBox would be, turned by the tilt. */
  function frame(phase: number) {
    const [bx, by, bw, bh] = box ?? [0, 0, canvas.width, canvas.height]
    const [fx, fy, fw, fh] = COLLAPSE_MARK_FRAME
    const scale = Math.min(bw / fw, bh / fh)
    return new DOMMatrix([scale, 0, 0, scale, bx + (bw - fw * scale) / 2 - fx * scale, by + (bh - fh * scale) / 2 - fy * scale])
      .translate(CENTRE_X, CENTRE_Y)
      .rotate(tilt.at(phase)[0])
      .translate(-CENTRE_X, -CENTRE_Y)
  }

  /** One cell as drawn at `phase`, in device pixels, with its centre and width. */
  function snapshot(played: Played, piece: number, cell: number, phase: number) {
    const track = played.pieces[piece]
    const [tx, ty] = track.translate.at(phase)
    const m = frame(phase).translate(tx, ty)
    const values = track.material.at(phase)
    const count = track.shape[cell], start = track.starts[cell]
    const points = new Float64Array(count * 2)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let p = 0; p < count; p++) {
      const x = values[start + p * 2], y = values[start + p * 2 + 1]
      const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f
      points[p * 2] = px
      points[p * 2 + 1] = py
      minX = Math.min(minX, px); maxX = Math.max(maxX, px)
      minY = Math.min(minY, py); maxY = Math.max(maxY, py)
    }
    return { points, x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX }
  }

  function begin(gather: CollapseMarkGather) {
    const played = gather.previous ? previous : current
    if (!played) return
    const queue = gather.previous
      // Drawn back home: every dot the last pass left, all at rest already.
      ? played.pieces.flatMap((piece, p) => piece.shape.map((_, c) => ({ piece: p, cell: c, ready: -Infinity })))
          .filter(({ piece, cell }) => snapshot(played, piece, cell, COLLAPSE_MARK_GONE).width > 0.5)
      : collapseMarkDots(played.lingerFrom)
    gathering = { id: gather.id, played, queue, flights: [], gone: played.pieces.map(() => new Set<number>()), lastLeft: -Infinity, waiting: false, told: false }
  }

  /** Sends every dot whose turn has come and which has all but stopped. */
  function depart(gather: CollapseMarkGather, phase: number) {
    const g = gathering!
    const at = g.played === current ? phase : COLLAPSE_MARK_GONE
    while (g.queue.length) {
      const next = g.queue[0]
      const due = Math.max(gather.since, g.lastLeft + COLLAPSE_MARK_GATHER_STAGGER_MS)
      if (gather.now < due) break
      if (at < next.ready) {
        g.waiting = true
        break
      }
      const leftAt = g.waiting ? gather.now : due
      g.waiting = false
      g.queue.shift()
      const dot = snapshot(g.played, next.piece, next.cell, at)
      g.gone[next.piece].add(next.cell)
      g.lastLeft = leftAt
      if (dot.width > 0.5) {
        if (!g.flights.length) onGather?.({ id: g.id, event: 'departed' })
        g.flights.push({ piece: next.piece, points: dot.points, x: dot.x, y: dot.y, leftAt })
      }
    }
  }

  function drawFlights({ now, x, y, scale }: CollapseMarkGather) {
    const g = gathering!
    // The body's centre: each path bends to one side of the line from it to
    // the target and closes in on that line as it goes, so the dots stream
    // in like a funnel rather than in parallel.
    const [, , boxWidth, boxHeight] = box ?? [0, 0, canvas.width, canvas.height]
    const centre = frame(COLLAPSE_MARK_GONE).transformPoint({ x: CENTRE_X, y: CENTRE_Y })
    // The receiving logo's body, as a radius in device pixels: the body is
    // about a fifth of the frame's width either side of its centre.
    const reach = 0.22 * scale * Math.min(boxWidth, (boxHeight * 4) / 3)
    const paths = g.played.pieces.map(() => new Path2D())
    let flying = false
    for (const dot of g.flights) {
      const t = clamp((now - dot.leftAt) / COLLAPSE_MARK_GATHER_FLIGHT_MS)
      if (t >= 1) continue
      flying = true
      // Attracted: slow to let go, fastest as it arrives.
      const pull = t ** 2.2
      const dx = x - dot.x, dy = y - dot.y, length = Math.hypot(dx, dy) || 1
      const nx = -dy / length, ny = dx / length
      const lateral = (dot.x - centre.x) * nx + (dot.y - centre.y) * ny
      const bend = length * 0.16 - lateral * 0.65
      const bx = dot.x + dx * 0.4 + nx * bend, by = dot.y + dy * 0.4 + ny * bend
      const u = 1 - pull
      const px = u * u * dot.x + 2 * u * pull * bx + pull * pull * x
      const py = u * u * dot.y + 2 * u * pull * by + pull * pull * y
      // It takes on the logo's scale on the way, and shrinks away only once it
      // is inside the logo's body, so it is seen to arrive there.
      const size = (1 + (scale - 1) * pull) * smooth(0, reach, Math.hypot(px - x, py - y))
      if (size <= 0) continue
      const path = paths[dot.piece]
      for (let p = 0; p < dot.points.length; p += 2) {
        const qx = px + (dot.points[p] - dot.x) * size, qy = py + (dot.points[p + 1] - dot.y) * size
        if (p) path.lineTo(qx, qy)
        else path.moveTo(qx, qy)
      }
      path.closePath()
    }
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.globalAlpha = 1
    g.played.pieces.forEach((piece, index) => {
      context.fillStyle = piece.fill
      context.fill(paths[index], 'nonzero')
    })
    if (!flying && !g.queue.length && !g.told) {
      g.told = true
      onGather?.({ id: g.id, event: 'gathered' })
    }
  }

  function draw(phase: number, options?: CollapseMarkFrame) {
    last = [phase, options]
    const lingerFrom = options?.lingerFrom ?? null
    if (lingerFrom !== current.lingerFrom) {
      previous = current
      current = play(lingerFrom)
    }
    const gather = options?.gather
    if (gather && gather.id !== gathering?.id) begin(gather)
    if (gather && gathering?.id === gather.id) depart(gather, phase)
    const { width, height } = canvas
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, width, height)
    const base = frame(phase)
    const gone = gathering?.played === current ? gathering.gone : null
    current.pieces.forEach((piece, index) => {
      const alpha = clamp(piece.opacity.at(phase)[0])
      if (alpha <= 0) return
      const [tx, ty] = piece.translate.at(phase)
      context.setTransform(base.translate(tx, ty))
      context.globalAlpha = alpha
      context.fillStyle = piece.fill
      context.fill(pathOf(piece.material.at(phase), piece.shape, gone?.[index]), 'nonzero')
    })
    context.globalAlpha = 1
    if (gather && gathering?.id === gather.id) drawFlights(gather)
  }

  return {
    draw,
    resize(width, height, next) {
      const moved = next?.join() !== box?.join()
      if (canvas.width === width && canvas.height === height && !moved) return
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      box = next
      draw(...last)
    },
  }
}

/** What the component posts to the worker that owns the canvas. */
export type CollapseMarkMessage =
  | { type: 'init'; canvas: OffscreenCanvas; inks: CollapseMarkInks; width: number; height: number; box?: CollapseMarkBox }
  | { type: 'resize'; width: number; height: number; box?: CollapseMarkBox }
  | { type: 'draw'; phase: number; frame?: CollapseMarkFrame }
