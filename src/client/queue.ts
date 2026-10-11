/**
 * Sequential job helper behind the overview's "fetch every repository" button.
 *
 * Pure and dependency-free, so the ordering, the progress sequence, and the
 * cleanup can be tested in Node without a DOM. Firing a dozen fetches at once
 * would be rude to the network and unreadable on screen; running them one at a
 * time is what makes the button's counter mean something.
 */

/** How far a bulk run has got. */
export interface RunProgress {
  /** Steps finished so far. */
  done: number
  /** Steps planned. */
  total: number
  /** The item now running, for the button's label. */
  label?: string
}

/**
 * Run one step per item, in order, reporting progress as each step starts.
 *
 * @param items - the work, in the order it must run.
 * @param step - one item's work; it may reject, which stops the run.
 * @param onProgress - called before every step and once with `null` at the end,
 *   even when a step throws, so a caller's spinner can never get stuck.
 * @param label - names an item for the progress report.
 */
export async function runSequentially<T>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<void>,
  onProgress: (progress: RunProgress | null) => void,
  label?: (item: T) => string,
): Promise<void> {
  try {
    for (const [index, item] of items.entries()) {
      onProgress({ done: index, total: items.length, ...(label === undefined ? {} : { label: label(item) }) })
      await step(item, index)
    }
  } finally {
    onProgress(null)
  }
}
