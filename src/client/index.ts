/**
 * @dsh-external/dsh-git-panel — client half.
 *
 * Two registrations, one id: the left rail's Git entry (`sidebar.panellist`)
 * and the panel page it opens in the main column (`main`, keyed by the same
 * id — the sidebar dispatches that id through `ctx.layout.selectPanel`, so the
 * panellist id and the main key must stay equal).
 *
 * Deeper integration points that are deliberately absent: nothing here reads
 * slots the shipped UI owns, and the page reaches the host half only through
 * its own `/api/git-panel/*` routes.
 */
import { GitPanelIcon, GitPanelPage } from './panel'

/**
 * Re-exported for tests only: `scripts/diff-test.mjs` loads the built bundle
 * with a stubbed module loader and feeds the parser real `git diff` output,
 * which is the one piece of client logic worth asserting without a browser.
 */
export { diffInline, pairInlineRuns, parseUnifiedDiff } from './diff'
export { runSequentially } from './queue'
export { overlayChange, tokenizeLine } from './highlight'
export { buildGraph, graphWidth } from './graph'
export { formatCommitDate, historyDayLabel } from './panel'
export type { GraphCommit, GraphEdge, GraphRow } from './graph'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'git'

/** Client services the two registrations need. */
export const inject = ['slots']

/** A slot registration's metadata; every owner reads its own fields. */
interface SlotRegistration {
  name: string
  [key: string]: unknown
}

/** The slot surface this plugin uses. */
interface SlotsFace {
  /** Register the callback's registrations while the slot itself is live; returns the disposer. */
  inject(slot: string, callback: () => unknown): () => void
  register(options: SlotRegistration, component: unknown): void
}

/** The browser plugin context this plugin is applied with. */
interface ClientContext {
  slots: SlotsFace
  effect(callback: () => (() => void) | void, label?: string): unknown
}

/**
 * Contribute the Git entry and the page it opens.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, GitPanelPage)), 'dsh-git-panel: main panel')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 15,
    label: () => 'Git',
  }, GitPanelIcon)), 'dsh-git-panel: sidebar entry')
}
