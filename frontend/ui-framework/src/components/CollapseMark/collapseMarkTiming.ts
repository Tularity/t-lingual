/* The collapse's landmarks, as phases of one sequence (0 → 1). Shared by the
 * drawing, which the worker runs, and by anything on the main thread that
 * paces or reacts to it — kept apart from the geometry so the latter never
 * travels with the page that merely reads a phase. */

/** The pieces are assembled and upright, at rest, just before the collapse. */
export const COLLAPSE_MARK_ASSEMBLED = 0.2
/** The collapse begins at the upper-right corner, and with it the tilt. */
export const COLLAPSE_MARK_COLLAPSE_START = 0.22
/** The last drifting cell has gone; the rest of the sequence is empty. */
export const COLLAPSE_MARK_GONE = 0.97

/** Two thirds of the body have begun to collapse by this phase, a third
 *  still standing: the earliest a lingering pass may start sending its dots
 *  away while the rest of it is still coming apart. */
export const COLLAPSE_MARK_GATHER_FROM = 0.54
/**
 * A lingering mark's dots, sent to a logo elsewhere on the page, leave one at
 * a time in the order they became dots, each once it has all but stopped, and
 * no sooner than this long after the one before…
 */
export const COLLAPSE_MARK_GATHER_STAGGER_MS = 20
/** …and each flies for this long. */
export const COLLAPSE_MARK_GATHER_FLIGHT_MS = 700
