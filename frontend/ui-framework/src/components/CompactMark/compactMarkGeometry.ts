/* ---------------------------------------------------------------------------
 * COMPACT MARK GEOMETRY
 *
 * The full logo is a 7x7 lattice tilted 22 degrees, split into four puzzle
 * pieces, with a tail of shrinking cells leaving its upper-right corner. None
 * of that survives 16px: seven cells a side leaves two pixels per cell, the
 * tilt smears every edge, and the tail becomes noise. This module redraws the
 * same four pieces on a coarser, upright lattice — the cells get bigger so the
 * gaps between pieces stay real gaps — and leaves the tail out, because in
 * the compact form the motion carries what the tail says in the static one.
 *
 * The partitions are drawn by hand, not resampled. Area-majority resampling of
 * the 7x7 map at 4x4 collapses into four near-quadrants, which loses the
 * interlock that makes the pieces read as puzzle pieces rather than as a
 * window. So each cut keeps the four features instead of the exact areas: an
 * L down the left and across the top, a band stepping down from the top
 * right, a lower-left piece that pushes a tongue up between the other two,
 * and a small stepped corner piece at the bottom right.
 *
 * The pieces are built the way the logo builds its own: the union of a
 * piece's cells, pulled in by half a gap wherever it faces another piece, with
 * every corner of the result rounded — convex corners cut, concave corners
 * filled. Each cell then carries exactly its share of that shape, so the
 * cells can move independently in the wave and still add up to the pieces
 * when they are all at rest.
 *
 * Everything here is in units of the mark's side (0..1); the component scales
 * it to pixels.
 * ------------------------------------------------------------------------- */

export type CompactMarkCut = 4 | 5
export type CompactMarkPiece = 'a' | 'b' | 'c' | 'd'

/**
 * Rows top to bottom. `a` is the logo's upper-left L, `b` its stepped band,
 * `c` the lower-left piece with the tongue, `d` the lower-right corner. The
 * 5x5 keeps the logo's proportions to within four points per piece; the 4x4
 * trades a little of `b`'s area for a staircase it could not otherwise keep.
 */
const PARTITIONS: Record<CompactMarkCut, readonly string[]> = {
  4: ['aaab', 'acbb', 'acbd', 'ccdd'],
  5: ['aaabb', 'aabbb', 'acbbb', 'accbd', 'cccdd'],
}

/**
 * Gap between pieces as a fraction of the cell pitch. The logo's own ratio is
 * about 0.32; slightly narrower here because the compact cells are fewer and
 * each gap is a larger share of the drawing. The component additionally
 * floors every gap at one CSS pixel, so it can never blur into a seam.
 */
const GAP_RATIO = 0.26

/** Outer corner radius of the whole square, as a fraction of the side — the
 *  logo's rounded envelope at its approved roundness. */
const OUTER_RADIUS = 0.19

/** Convex corners where a piece turns, as a fraction of the pitch. The logo
 *  at its approved roundness rounds these at about 0.4 of its pitch; a little
 *  less here, where a cell is a larger share of the whole. */
const PIECE_RADIUS = 0.32

/** How close a radius may come to half of the side it rounds. */
const RADIUS_CAP = 0.42

export type CompactMarkEdge = 'outer' | 'inset' | 'join'

/** Clockwise from the top left, the order CSS `border-radius` uses. */
export type CompactMarkCorners<T> = [T, T, T, T]

export interface CompactMarkCell {
  row: number
  col: number
  piece: CompactMarkPiece
  /**
   * What each side of the cell faces: the silhouette (`outer`), another piece
   * (`inset` — pulled back by half a gap), or the same piece (`join` — left
   * flush so neighbours fuse into one shape).
   */
  edges: { top: CompactMarkEdge; right: CompactMarkEdge; bottom: CompactMarkEdge; left: CompactMarkEdge }
  /** Convex corner radii at rest, in side units. */
  radii: CompactMarkCorners<number>
  /**
   * Corners where the piece turns inward: both neighbours flanking the corner
   * belong to this piece and the diagonal one does not. The piece's concave
   * corner sits there, and its fillet is a quarter circle of half a gap
   * centred on the lattice point — which lies wholly inside this cell, so no
   * other cell has to carry any of it.
   */
  scoops: CompactMarkCorners<boolean>
  /**
   * 0..1 position along the diagonal from the lower-left corner to the upper
   * right — the direction the logo's tail leaves in, and the direction the
   * wave travels.
   */
  phase: number
}

export interface CompactMarkLayout {
  cut: CompactMarkCut
  /** Cell pitch in side units. */
  pitch: number
  /** Gap between pieces in side units, before the component's pixel floor. */
  gap: number
  cells: CompactMarkCell[]
}

/** The cut a size gets when the caller does not choose one. Four cells a side
 *  keeps every cell at three device pixels or more down to 12px; five only
 *  pays off once a cell has room for its own rounded corners. */
export function compactCutForSize(size: number): CompactMarkCut {
  return size <= 18 ? 4 : 5
}

export function compactMarkPartition(cut: CompactMarkCut): readonly string[] {
  return PARTITIONS[cut]
}

const cache = new Map<CompactMarkCut, CompactMarkLayout>()

export function layoutCompactMark(cut: CompactMarkCut): CompactMarkLayout {
  const cached = cache.get(cut)
  if (cached) return cached

  const rows = PARTITIONS[cut]
  const n = rows.length
  const last = n - 1
  const pitch = 1 / n
  const gap = pitch * GAP_RATIO
  const at = (r: number, c: number) =>
    r < 0 || c < 0 || r >= n || c >= n ? null : (rows[r][c] as CompactMarkPiece)

  const cells: CompactMarkCell[] = []
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const piece = at(row, col)!
      const side = (dr: number, dc: number): CompactMarkEdge => {
        const other = at(row + dr, col + dc)
        return other === null ? 'outer' : other === piece ? 'join' : 'inset'
      }
      const edges = { top: side(-1, 0), right: side(0, 1), bottom: side(1, 0), left: side(0, -1) }

      const width = pitch - (edges.left === 'inset' ? gap / 2 : 0) - (edges.right === 'inset' ? gap / 2 : 0)
      const height = pitch - (edges.top === 'inset' ? gap / 2 : 0) - (edges.bottom === 'inset' ? gap / 2 : 0)
      const convex = Math.min(pitch * PIECE_RADIUS, Math.min(width, height) * RADIUS_CAP)

      // Each corner is flanked by a vertical and a horizontal side and faces
      // one diagonal neighbour. Convex only where neither flanking side joins;
      // a scoop only where both do and the diagonal belongs elsewhere; square
      // otherwise, because the corner is inside the piece.
      const corner = (vertical: CompactMarkEdge, horizontal: CompactMarkEdge, dr: number, dc: number) => {
        const silhouette = at(row + dr, col) === null && at(row, col + dc) === null
        if (silhouette) return { radius: Math.min(OUTER_RADIUS, pitch * 0.9), scoop: false }
        if (vertical !== 'join' && horizontal !== 'join') return { radius: convex, scoop: false }
        const diagonal = at(row + dr, col + dc)
        return { radius: 0, scoop: vertical === 'join' && horizontal === 'join' && diagonal !== piece }
      }
      const corners = [
        corner(edges.top, edges.left, -1, -1),
        corner(edges.top, edges.right, -1, 1),
        corner(edges.bottom, edges.right, 1, 1),
        corner(edges.bottom, edges.left, 1, -1),
      ]

      cells.push({
        row,
        col,
        piece,
        edges,
        radii: corners.map((c) => c.radius) as CompactMarkCorners<number>,
        scoops: corners.map((c) => c.scoop) as CompactMarkCorners<boolean>,
        phase: (col + (last - row)) / (2 * last),
      })
    }
  }

  const layout = { cut, pitch, gap, cells }
  cache.set(cut, layout)
  return layout
}
