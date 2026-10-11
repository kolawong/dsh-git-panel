/**
 * The panel's icon set.
 *
 * One grid, one stroke, one colour rule: every icon is drawn on a 16×16 box
 * with a 1.4 round-capped stroke on `currentColor`, which is the same
 * convention as the sidebar's Git glyph. Colour therefore always comes from the
 * theme token of whatever the icon sits in — no icon carries a colour of its
 * own, and none of them is a font glyph or an emoji.
 *
 * Sizes stay at 11–13px in the toolbar and chips, matching the 10.5–12px text
 * they sit beside.
 */
import type { ReactNode } from 'react'

/** What every icon takes. */
export interface IconProps {
  /** Box size in px; 13 matches toolbar text. */
  size?: number
  /** Stroke width on the 16-unit grid; raise it to mark a state. */
  strokeWidth?: number
  /** Accessible name; omit for icons that only repeat adjacent text. */
  label?: string
}

/** The shared box: fixed viewBox so every icon aligns on the same grid. */
function Glyph({ size = 13, strokeWidth = 1.4, label, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      data-icon
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label === undefined ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': label })}
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      {children}
    </svg>
  )
}

/** A filled mark, for dots that read as a filled circle rather than a stroke. */
function Solid({ size = 13, label, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      data-icon
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      stroke="none"
      {...(label === undefined ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': label })}
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      {children}
    </svg>
  )
}

/** A four-point spark: the model writes the message, it never commits. */
export const IconSpark = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 2.2l1.4 4.4 4.4 1.4-4.4 1.4L8 13.8l-1.4-4.4L2.2 8l4.4-1.4z" />
  </Glyph>
)

/** A commit: the node on the branch's line. */
export const IconCommit = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <circle cx="8" cy="8" r="2.7" />
    <path d="M1.6 8h3.7M10.7 8h3.7" />
  </Glyph>
)

/** A branch. */
export const IconBranch = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <circle cx="4.4" cy="3.6" r="1.8" />
    <circle cx="4.4" cy="12.4" r="1.8" />
    <circle cx="11.6" cy="12.4" r="1.8" />
    <path d="M4.4 5.4v5.2" />
    <path d="M6.2 10.9h1.6a3.8 3.8 0 0 0 3.8-3.8V5.2" />
  </Glyph>
)

/** Past commits: a clock with a counter-clockwise arrow. */
export const IconHistory = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" />
    <path d="M2.6 3.4v3.4h3.4" />
    <path d="M8 5.6V8l2 1.5" />
  </Glyph>
)

/** Uncommitted changes: a file with changed lines. */
export const IconDiff = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M4.2 2.6h5l2.6 2.6v8.2H4.2z" />
    <path d="M9.2 2.6v2.6h2.6" />
    <path d="M6.2 7.4h1.4M9.4 7.4h1.4M6.2 10.2h1.4M9.4 10.2h1.4" />
  </Glyph>
)

/** Stage this. */
export const IconPlus = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </Glyph>
)

/** Take this out of the index. */
export const IconMinus = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M3.4 8h9.2" />
  </Glyph>
)

/** Throw this change away. */
export const IconUndo = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M3.2 6.6h5.2a3.7 3.7 0 0 1 0 7.4H5.6" />
    <path d="M5.8 4.2L3.2 6.6l2.6 2.4" />
  </Glyph>
)

/** Stash the work tree away. */
export const IconArchive = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M2.4 3.6h11.2v2.8H2.4z" />
    <path d="M3.6 6.4v5.4a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V6.4" />
    <path d="M6.4 9.2h3.2" />
  </Glyph>
)

/** Commit it. */
export const IconCheck = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M3.4 8.4l3 3 6.2-6.8" />
  </Glyph>
)

/** It failed. */
export const IconCross = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
  </Glyph>
)

/** A live marker: one filled dot. */
export const IconDot = (props: IconProps): ReactNode => (
  <Solid {...props}>
    <circle cx="8" cy="8" r="3" />
  </Solid>
)

/** More of this, collapsed. */
export const IconEllipsis = (props: IconProps): ReactNode => (
  <Solid {...props}>
    <circle cx="3.6" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.4" cy="8" r="1.2" />
  </Solid>
)

/** Read it again. */
export const IconRefresh = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9" />
    <path d="M13.4 2.8v3.4H10" />
  </Glyph>
)

/** Ahead of the upstream. */
export const IconArrowUp = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 12.8V3.6" />
    <path d="M4.4 7.2L8 3.6l3.6 3.6" />
  </Glyph>
)

/** Behind the upstream. */
export const IconArrowDown = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 3.2v9.2" />
    <path d="M4.4 8.8L8 12.4l3.6-3.6" />
  </Glyph>
)

/** Back to where you came from. */
export const IconArrowLeft = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M12.8 8H3.6" />
    <path d="M7.2 4.4L3.6 8l3.6 3.6" />
  </Glyph>
)

/** Bring the remote's refs down (fetch). */
export const IconCloudDown = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 3.2v5.8" />
    <path d="M5.5 6.5L8 9l2.5-2.5" />
    <path d="M3 12.4h10" />
  </Glyph>
)

/** Send local commits up (push). */
export const IconCloudUp = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 9.2V3.4" />
    <path d="M5.5 5.9L8 3.4l2.5 2.5" />
    <path d="M3 12.6h10" />
  </Glyph>
)

/** A workspace. */
export const IconFolder = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M2.4 4.4h4l1.3 1.8h5.9v5.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" />
  </Glyph>
)

/** Something needs attention. */
export const IconAlert = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M8 2.6l5.6 10.2H2.4z" />
    <path d="M8 6.6v2.6M8 11.2h.01" />
  </Glyph>
)

/** The log of what was run. */
export const IconTerminal = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M2.6 3.4h10.8v9.2H2.6z" />
    <path d="M5.2 6.8l1.8 1.7-1.8 1.7M8.8 10.4h2.4" />
  </Glyph>
)

/** Open this up. */
export const IconChevronDown = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M4.4 6.4L8 10l3.6-3.6" />
  </Glyph>
)

/** Go into this. */
export const IconChevronRight = (props: IconProps): ReactNode => (
  <Glyph {...props}>
    <path d="M6.4 4.4L10 8l-3.6 3.6" />
  </Glyph>
)
