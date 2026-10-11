/**
 * The commit graph, as lanes.
 *
 * `git log` hands out commits children-first, which is the one order a lane
 * layout needs: when a commit is reached, every line waiting for it is already
 * open. This walks that list once, keeping a list of lanes where each lane is
 * the id of the commit the line is waiting for, so the result is a plain
 * description the renderer can draw — no git calls, no state, no React.
 *
 * What it deliberately does not do: reorder commits, invent commits that git
 * did not print, or assume the list is complete. A parent outside the page (the
 * next page, or a filter that hid it) simply leaves its line open at the bottom
 * of the last row, which is exactly what a paginated graph should show.
 */

/** One commit, as much of it as the graph needs. */
export interface GraphCommit {
  /** Abbreviated id; the key lanes wait on. */
  short: string
  /** Parent ids, first parent first; empty for the first commit. */
  parents: string[]
}

/** A line leaving one row for a parent. */
export interface GraphEdge {
  /** Lane the line starts in: the commit's own lane, or a lane collapsing into it. */
  from: number
  /** Lane it arrives in on the next row. */
  to: number
}

/** One commit's place in the graph. */
export interface GraphRow {
  /** The lane the commit's node sits in. */
  lane: number
  /** How many lanes are in play on this row: draw this many columns. */
  width: number
  /** Lanes that are occupied at the top of the row. */
  incoming: number[]
  /** Lanes that are occupied at the bottom of the row. */
  outgoing: number[]
  /** Lines from this row to a parent, or from a collapsed lane into this one. */
  edges: GraphEdge[]
  /** True when the commit has no parent in this repository. */
  root: boolean
}

/** Lanes below this index are drawn even when empty, so lines stay aligned. */
const MAX_LANES = 32

/**
 * Lay a page of commits out in lanes.
 *
 * @param commits - commits in `git log` order, children before parents.
 * @returns one row per commit, in the same order.
 */
export function buildGraph(commits: GraphCommit[]): GraphRow[] {
  /** Each entry is the commit id that lane is waiting for, or null when free. */
  let lanes: (string | null)[] = []
  /** Commits already placed, so a parent printed above its child is not awaited. */
  const placed = new Set<string>()
  const rows: GraphRow[] = []
  /**
   * Do two ids name the same commit?
   *
   * A page mixes abbreviations from one git invocation, so they are equal;
   * a prefix test keeps the layout sane if some caller ever passes a full
   * hash beside an abbreviated one, which is exactly the mismatch that once
   * opened one lane per commit.
   */
  const same = (left: string, right: string): boolean => left === right
    || left.startsWith(right) || right.startsWith(left)
  const findLane = (sha: string): number => lanes.findIndex(entry => entry !== null && same(entry, sha))
  const isPlaced = (sha: string): boolean => [...placed].some(entry => same(entry, sha))


  const takeFreeLane = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }
  /** The lanes occupied right now, capped so a pathological history stays sane. */
  const occupied = (): number[] => {
    const seen: number[] = []
    for (let lane = 0; lane < Math.min(lanes.length, MAX_LANES); lane += 1) {
      if (lanes[lane] !== null) seen.push(lane)
    }
    return seen
  }

  for (const commit of commits) {
    const incoming = occupied()
    // A commit nobody is waiting for is a tip: it starts its own line in the
    // leftmost free lane, which keeps the checked-out branch on the left.
    let lane = findLane(commit.short)
    if (lane === -1) lane = takeFreeLane()

    const edges: GraphEdge[] = []
    const first = commit.parents[0]
    if (first === undefined) {
      // No parent: the line ends at this commit's node.
      lanes[lane] = null
    } else if (isPlaced(first)) {
      // The parent is already above this row: the line does not continue, and
      // holding a lane open for a commit that will never come again is exactly
      // how a graph grows a hundred empty lanes.
      lanes[lane] = null
    } else {
      lanes[lane] = first
      // Another lane waiting for the same parent is the same line: collapse it
      // into this one rather than draw two lines that never meet.
      for (let other = 0; other < lanes.length; other += 1) {
        if (other !== lane && lanes[other] === first) {
          edges.push({ from: other, to: lane })
          lanes[other] = null
        }
      }
      // A merge brings in one line per extra parent.
      for (const parent of commit.parents.slice(1)) {
        const existing = findLane(parent)
        if (existing !== -1) {
          edges.push({ from: lane, to: existing })
          continue
        }
        // An already-placed parent needs no lane either.
        if (isPlaced(parent)) continue
        const opened = takeFreeLane()
        lanes[opened] = parent
        edges.push({ from: lane, to: opened })
      }
    }

    placed.add(commit.short)
    const outgoing = occupied()
    rows.push({
      lane,
      width: Math.max(1, ...incoming.map(index => index + 1), ...outgoing.map(index => index + 1), lane + 1),
      incoming,
      outgoing,
      edges,
      root: first === undefined,
    })
  }

  return rows
}

/** The widest lane column a page produced, for reserving space up front. */
export function graphWidth(rows: GraphRow[]): number {
  return rows.reduce((widest, row) => Math.max(widest, row.width), 1)
}
