/**
 * The panel's design system: one stylesheet for everything inline styles
 * cannot do — hover and focus states, transitions, and the shared row and
 * control language the DSH first-level pages use.
 *
 * Only tokens that exist in this theme at runtime are referenced (measured
 * inside the app tree with getComputedStyle, not assumed): the alias set
 * bg-base/layer-1/layer-2/overlay, border-l1/l2/l3, label-primary/secondary/
 * tertiary, brand-primary, interactive-bg-hover/active, state-success/warn/
 * error/idle-primary, radius-md/lg/xl, and sidebar-fill.
 *
 * The measurements follow the official pages: a 28px chip row (the Plugins
 * filter tabs), 32px capsule buttons, 13px labels on a 1.6 body, and rows
 * that light up with interactive-bg-hover.
 */

/** The stylesheet is injected once per document, under the panel's root. */
const STYLE_ID = 'dsh-git-panel-styles'

/** Install the stylesheet. Idempotent; safe to call on every mount. */
export function ensurePanelStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

/** Remove the stylesheet (plugin unload). */
export function removePanelStyles(): void {
  document.getElementById(STYLE_ID)?.remove()
}

const PANEL_CSS = `
/* ==== the panel frame ==== */
[data-git-panel] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  line-height: 1.6;
}
[data-git-panel] * {
  box-sizing: border-box;
}
[data-git-panel] ::selection {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
}

/* ==== controls ==== */
/* One button shape everywhere: the official 28px chip / 32px capsule family. */
.gp-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  user-select: none;
}
.gp-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.gp-btn:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
}
.gp-btn:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.gp-btn:focus-visible,
.gp-tab:focus-visible,
.gp-row:focus-visible,
.gp-commit-row:focus-visible,
.gp-chip-btn:focus-visible,
.gp-input:focus-visible,
.gp-select:focus-visible,
.gp-textarea:focus-visible,
[data-git-panel] [role="checkbox"]:focus-visible,
[data-git-panel] input[type="checkbox"]:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
  outline-offset: 1px;
}
/* A button that carries weight: the commit button and other primary acts. */
.gp-btn-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}
.gp-btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, var(--dsw-alias-bg-base));
}
.gp-btn-primary:disabled {
  background: transparent;
  border-color: var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
}
/* A button on the edge of destructive: hover warns. */
.gp-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
/* An armed two-step button reads as a real warning. */
.gp-btn-armed-wrap .gp-btn, .gp-btn-armed {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

/* ==== chips and badges ==== */
.gp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}

/* ==== the repo page header ==== */
.gp-header {
  padding: 10px 16px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.gp-header-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  flex-wrap: wrap;
}
.gp-repo-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  letter-spacing: -0.01em;
}
.gp-branch-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* ==== the segmented view switch ==== */
.gp-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.gp-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.gp-tab:hover {
  color: var(--dsw-alias-label-primary);
}
.gp-tab[aria-selected="true"] {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}

/* ==== rows: files, branches, stash entries ==== */
.gp-row {
  /* A raw <button> paints the UA buttonface otherwise — the gray block the
     rows showed before this line existed. */
  background: transparent;
  transition: background 0.1s ease;
}
.gp-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.gp-row[aria-current="true"] {
  background: var(--dsw-alias-interactive-bg-active);
}
.gp-group-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsw-alias-bg-layer-1);
  backdrop-filter: blur(8px);
}

/* ==== the overview cards ==== */
.gp-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.gp-card:hover {
  border-color: var(--dsw-alias-border-l2);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  transform: translateY(-1px);
}
.gp-card:focus-within {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
}

/* ==== the commit box ==== */
.gp-commit {
  /* Flat on the list column: the commit box is part of the same surface as
     the files below it, not a floating card of its own. */
  flex: none;
  border: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  transition: border-color 0.15s ease;
}
.gp-commit:focus-within {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
}
.gp-textarea {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.55;
  resize: none;
  outline: none;
}
.gp-input, .gp-select {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  transition: border-color 0.12s ease;
}
.gp-input:hover, .gp-select:hover {
  border-color: var(--dsw-alias-border-l2);
}

/* ==== history graph rows ==== */
.gp-commit-row {
  background: transparent;
  transition: background 0.1s ease;
}
.gp-commit-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.gp-commit-row[aria-current="true"] {
  background: var(--dsw-alias-interactive-bg-active);
}

/* Small clickable chips inside the diff (fold markers, gap chips): same hover
   language as the rows, at chip size. */
.gp-mini-btn {
  transition: background 0.1s ease, border-color 0.1s ease;
  cursor: pointer;
}
.gp-mini-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
  border-color: var(--dsw-alias-border-l2) !important;
}

/* ==== the operation banner ==== */
.gp-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 10px 12px 0;
  padding: 9px 12px;
  border-radius: var(--dsw-radius-md);
  border: 1px solid var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  font-size: 12px;
}
.gp-banner[data-resolved="true"] {
  border-color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent);
}

/* ==== the split handle between the list and the detail ==== */
.gp-split-handle {
  flex: none;
  width: 7px;
  align-self: stretch;
  cursor: col-resize;
  position: relative;
  background: transparent;
}
.gp-split-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: var(--dsw-alias-border-l2);
  transition: background 0.12s ease, width 0.12s ease;
}

/* The list side of a split reads as the navigation surface — the same fill
   the shell's own sidebar uses. */
.gp-split-list {
  background: var(--dsw-specific-sidebar-fill);
}
.gp-split-handle:hover::after, .gp-split-handle[data-dragging="true"]::after {
  left: 2px;
  width: 3px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
}
.gp-split-handle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
  outline-offset: 1px;
}

/* ==== loading skeletons ==== */
.gp-skeleton {
  height: 14px;
  border-radius: 7px;
  background: linear-gradient(
    90deg,
    var(--dsw-alias-interactive-bg-hover) 25%,
    var(--dsw-alias-interactive-bg-active) 50%,
    var(--dsw-alias-interactive-bg-hover) 75%
  );
  background-size: 200% 100%;
  animation: gp-shimmer 1.4s ease infinite;
}
@keyframes gp-shimmer {
  from { background-position: 180% 0; }
  to { background-position: -20% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .gp-skeleton { animation: none; }
}

/* ==== the log ==== */
.gp-log-row {
  transition: background 0.1s ease;
}
.gp-log-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* ==== motion is optional ==== */
@media (prefers-reduced-motion: reduce) {
  [data-git-panel] * {
    transition: none !important;
  }
}
`
