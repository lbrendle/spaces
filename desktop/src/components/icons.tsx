/**
 * The Spaces icon set.
 *
 * Hand-drawn, no dependency. Every icon is a 24×24 viewBox drawn on the same
 * geometry so the set reads as one family:
 *
 *   - live area 3–21, optical centre (12, 12)
 *   - one stroke weight for everything (ICON_STROKE), rounded caps and joins
 *   - corner radius language: 2–2.5 on full-width containers, 1.2–1.5 on the
 *     small ones, so a card and a chip look related rather than identical
 *   - circles are r=9 when the circle *is* the icon, r=8.5 when it is a status
 *     ring, r=1.6–1.8 for dots
 *   - currentColor throughout: theming, hover and disabled states are the
 *     caller's text colour, never a hardcoded fill
 *
 * These render at 13–16px almost everywhere, which drives two rules. Detail
 * that survives at 24px turns to mush at 13, so shapes stay coarse and open.
 * And nothing is filled unless filled *is* the meaning — a pinned pin, a
 * starred star, a presence dot — because a filled shape at 13px is a blob.
 *
 * Everything is aria-hidden: icons here are decoration paired with real text
 * or an aria-label on the control. If an icon is ever the only content of a
 * button, label the button, not the icon.
 */
import type { ReactElement, SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

/**
 * One weight for the whole set. Uniform stroke is what makes a hand-drawn set
 * read as a family instead of a pile — resist per-icon tuning, retune here.
 */
export const ICON_STROKE = 1.5;

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** A solid dot. Filled because a hairline ring this small is invisible. */
const Dot = ({ cx, cy, r = 1.7 }: { cx: number; cy: number; r?: number }) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

/* ── product mark ─────────────────────────────────────────────────────── */

/** The product mark: a protective architectural arch around a command node. */
export const IconLogo = ({ size = 20, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
    <path
      d="M4.3 20V10.8C4.3 6.25 7.7 2.5 12 2.5s7.7 3.75 7.7 8.3V20"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
    />
    <circle cx="12" cy="13" r="2.35" stroke="currentColor" strokeWidth={1.8} />
    <path
      d="M12 10.65V7.9M9.65 13H7.1M14.35 13h2.55M12 15.35v2.75"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      opacity={0.72}
    />
  </svg>
);

/** Solid by necessity — the GitHub mark is a filled logo, not a stroke icon. */
export const IconGitHub = (p: P) => (
  <Svg {...p} strokeWidth={0} fill="currentColor">
    <path d="M12 1.5a10.5 10.5 0 00-3.32 20.47c.53.1.72-.23.72-.5v-1.9c-2.92.63-3.54-1.25-3.54-1.25-.48-1.21-1.17-1.54-1.17-1.54-.96-.65.07-.64.07-.64 1.06.08 1.61 1.09 1.61 1.09.94 1.6 2.47 1.14 3.07.87.1-.68.37-1.14.67-1.4-2.33-.27-4.78-1.17-4.78-5.19 0-1.15.41-2.09 1.08-2.83-.11-.27-.47-1.34.1-2.79 0 0 .88-.28 2.88 1.08a9.96 9.96 0 015.24 0c2-1.36 2.88-1.08 2.88-1.08.57 1.45.21 2.52.1 2.79.67.74 1.08 1.68 1.08 2.83 0 4.03-2.45 4.92-4.79 5.18.38.33.71.97.71 1.96v2.9c0 .28.19.61.73.5A10.5 10.5 0 0012 1.5z" />
  </Svg>
);

/* ── navigation and objects ───────────────────────────────────────────── */

export const IconDashboard = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
);

/** Work you can finish: a checked list. The board gets its own icon. */
export const IconTasks = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 7.4l1.8 1.8L9 5.5" />
    <path d="M3.5 16.4l1.8 1.8L9 14.5" />
    <path d="M12.5 7h8M12.5 12h8M12.5 17h8" />
  </Svg>
);

export const IconBoard = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="5.5" height="16" rx="1.5" />
    <rect x="10.5" y="4" width="5.5" height="10" rx="1.5" />
    <rect x="18" y="4" width="3" height="13" rx="1.5" />
  </Svg>
);

export const IconCalendar = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="16" rx="2" />
    <path d="M7 2.5v4M17 2.5v4M3 9h18" />
    <path d="M7 13h2M11 13h2M15 13h2M7 17h2M11 17h2" />
  </Svg>
);

export const IconMail = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M4 7l8 6 8-6" />
  </Svg>
);

export const IconMessage = (p: P) => (
  <Svg {...p}>
    <path d="M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-8l-5 4v-4H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
  </Svg>
);

export const IconDocument = (p: P) => (
  <Svg {...p}>
    <path d="M6 2.8h8l4 4V21H6z" />
    <path d="M14 2.8V7h4M9 11h6M9 14.5h6M9 18h4" />
  </Svg>
);

/** A sticky note — turned corner, no ruled lines, so it is not a Document. */
export const IconNote = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 5.5a1 1 0 011-1h13a1 1 0 011 1v8.5l-5.5 5.5H5.5a1 1 0 01-1-1z" />
    <path d="M19.5 14H14v5.5" />
  </Svg>
);

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3 18.5V6a1.5 1.5 0 011.5-1.5h4.2a1.5 1.5 0 011.2.6l1.3 1.7h8.3A1.5 1.5 0 0121 8.3v10.2a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" />
  </Svg>
);

export const IconMemory = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
    <path d="M18 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
  </Svg>
);

export const IconAgents = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 8V4.5" />
    <circle cx="12" cy="3.4" r="1.3" />
    <path d="M9 13v1.5M15 13v1.5" />
    <path d="M2.5 12.5v3M21.5 12.5v3" />
  </Svg>
);

export const IconTeams = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.3" />
    <path d="M3 19.8a6 6 0 0112 0" />
    <path d="M16.2 5.2a3.3 3.3 0 010 5.6" />
    <path d="M18 14.4a6 6 0 013 5.4" />
  </Svg>
);

export const IconPerson = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M5 20a7 7 0 0114 0" />
  </Svg>
);

/** A laptop — Spaces devices are machines that host agent runs, not phones. */
export const IconDevice = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4.5" width="16" height="11" rx="2" />
    <path d="M2.5 19h19" />
  </Svg>
);

export const IconMonitor = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M9 20.5h6M12 17v3.5" />
  </Svg>
);

/** A window with a rail: the shape of a workspace, not a folder of files. */
export const IconWorkspace = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);

export const IconBranch = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="5" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 7.2v9.6" />
    <path d="M18 11.2c0 3.2-2.4 4.4-5 4.8-2 .3-3.4.9-4.2 1.6" />
  </Svg>
);

export const IconGit = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </Svg>
);

export const IconPullRequest = (p: P) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2.4" />
    <circle cx="6.5" cy="18.5" r="2.4" />
    <circle cx="17.5" cy="18.5" r="2.4" />
    <path d="M6.5 7.9v8.2" />
    <path d="M17.5 16.1V10a3 3 0 00-3-3h-3.4" />
    <path d="M13.3 4.8L11.1 7l2.2 2.2" />
  </Svg>
);

/** Three nodes and the edges between them: the link graph, literally. */
export const IconGraph = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.6" />
    <circle cx="18" cy="10" r="2.6" />
    <circle cx="10" cy="18.5" r="2.6" />
    <path d="M8.5 6.8L15.5 9.2" />
    <path d="M16.2 11.9L11.8 16.6" />
    <path d="M6.8 8.5L9.2 16" />
  </Svg>
);

export const IconKnowledge = (p: P) => (
  <Svg {...p}>
    <path d="M12 6.5C10.6 5.2 8.7 4.5 6.5 4.5H4v13h2.5c2.2 0 4.1.7 5.5 2 1.4-1.3 3.3-2 5.5-2H20v-13h-2.5c-2.2 0-4.1.7-5.5 2z" />
    <path d="M12 6.5v13" />
  </Svg>
);

/**
 * A composition: one hero and two cards. Blocks rather than a ruled grid, so
 * it never reads as IconTable at 13px.
 */
export const IconContent = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="6.5" rx="1.8" />
    <rect x="3" y="13.5" width="8" height="6.5" rx="1.8" />
    <rect x="13" y="13.5" width="8" height="6.5" rx="1.8" />
  </Svg>
);

export const IconProject = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M8.5 7V5.8A1.8 1.8 0 0110.3 4h3.4A1.8 1.8 0 0115.5 5.8V7" />
    <path d="M3 12.5h18" />
  </Svg>
);

export const IconRepo = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 7.4L12 3l8.5 4.4v9.2L12 21l-8.5-4.4z" />
    <path d="M3.5 7.4L12 11.9l8.5-4.5M12 11.9V21" />
  </Svg>
);

export const IconIssue = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.6" />
  </Svg>
);

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="13" cy="17" r="2" />
  </Svg>
);

export const IconGear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 009 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 9a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
  </Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.8-3.8" />
  </Svg>
);

/** The ⌘ loop, for palette affordances that want a mark rather than a keycap. */
export const IconCommand = (p: P) => (
  <Svg {...p}>
    <path d="M17.5 3.5a2.8 2.8 0 00-2.8 2.8v11.4a2.8 2.8 0 102.8-2.8H6.5a2.8 2.8 0 102.8 2.8V6.3A2.8 2.8 0 106.5 9.1h11a2.8 2.8 0 000-5.6z" />
  </Svg>
);

export const IconHash = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 4L7.5 20M16.5 4l-2 16M4 9h16M3 15h16" />
  </Svg>
);

export const IconAt = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M15.6 8.4v5a2.7 2.7 0 005.4 0V12A9 9 0 1017.4 19" />
  </Svg>
);

export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M7 9l3 3-3 3M13 16h4" />
  </Svg>
);

export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
  </Svg>
);

export const IconMegaphone = (p: P) => (
  <Svg {...p}>
    <path d="M4 11v3a2 2 0 002 2h2l3.5 4h2l-1.5-4 7-3.5v-6L8 11z" />
    <path d="M19 8.5h2M18.5 4.5l1.4-1.4M18.5 16.5l1.4 1.4" />
  </Svg>
);

/* ── actions ──────────────────────────────────────────────────────────── */

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
/** Same mark, honest name: this is the dismiss affordance, not the letter X. */
export const IconClose = IconX;

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Svg>
);

export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M4 20l1-4L16.5 4.5l3 3L8 19z" />
    <path d="M14.5 6.5l3 3" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h16" />
    <path d="M9.5 6.5V4.8a1.3 1.3 0 011.3-1.3h2.4a1.3 1.3 0 011.3 1.3v1.7" />
    <path d="M6.5 6.5l.9 12.2a1.8 1.8 0 001.8 1.8h5.6a1.8 1.8 0 001.8-1.8l.9-12.2" />
    <path d="M10.5 10.5v6M13.5 10.5v6" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M5.5 15.5H5A1.5 1.5 0 013.5 14V5A1.5 1.5 0 015 3.5h9A1.5 1.5 0 0115.5 5v.5" />
  </Svg>
);

export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10 13.8a4 4 0 006 .5l2.4-2.4a4 4 0 00-5.7-5.7l-1.4 1.4" />
    <path d="M14 10.2a4 4 0 00-6-.5l-2.4 2.4a4 4 0 005.7 5.7l1.4-1.4" />
  </Svg>
);

export const IconUnlink = (p: P) => (
  <Svg {...p}>
    <path d="M13.2 6.9l1.3-1.3a3.7 3.7 0 015.2 5.2l-1.3 1.3" />
    <path d="M10.8 17.1l-1.3 1.3a3.7 3.7 0 01-5.2-5.2l1.3-1.3" />
    <path d="M8.5 3.6v2.3M3.6 8.5h2.3M15.5 20.4v-2.3M20.4 15.5h-2.3" />
  </Svg>
);

export const IconShare = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v11.5" />
    <path d="M8 7.4L12 3.4l4 4" />
    <path d="M6.8 11.5H5.5a2 2 0 00-2 2v5a2 2 0 002 2h13a2 2 0 002-2v-5a2 2 0 00-2-2h-1.3" />
  </Svg>
);

export const IconFilter = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 5.5h17l-6.6 7.8v5.6l-3.8 2.1v-7.7z" />
  </Svg>
);

export const IconSort = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h10M4 12h7M4 17h4" />
    <path d="M17 5.5v13M14 15.5l3 3 3-3" />
  </Svg>
);

export const IconMoreHorizontal = (p: P) => (
  <Svg {...p}>
    <Dot cx={5.2} cy={12} />
    <Dot cx={12} cy={12} />
    <Dot cx={18.8} cy={12} />
  </Svg>
);

export const IconMoreVertical = (p: P) => (
  <Svg {...p}>
    <Dot cx={12} cy={5.2} />
    <Dot cx={12} cy={12} />
    <Dot cx={12} cy={18.8} />
  </Svg>
);

export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M20 7v5h-5M4 17v-5h5" />
    <path d="M6.1 8.2A7.5 7.5 0 0118.8 7L20 12M4 12l1.2 5A7.5 7.5 0 0017.9 15.8" />
  </Svg>
);

export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M21 3L10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3z" />
  </Svg>
);

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v11.5" />
    <path d="M7.5 10.6L12 15.1l4.5-4.5" />
    <path d="M4 17v2a1.5 1.5 0 001.5 1.5h13A1.5 1.5 0 0020 19v-2" />
  </Svg>
);

export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 15V3.5" />
    <path d="M7.5 8L12 3.5 16.5 8" />
    <path d="M4 17v2a1.5 1.5 0 001.5 1.5h13A1.5 1.5 0 0020 19v-2" />
  </Svg>
);

export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M14 3.5h6.5V10" />
    <path d="M20.5 3.5L11 13" />
    <path d="M18 14.5v4a2.5 2.5 0 01-2.5 2.5h-10A2.5 2.5 0 013 18.5v-10A2.5 2.5 0 015.5 6h4" />
  </Svg>
);

/** Four corners pushed out — go fullscreen / take the whole pane. */
export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 3H3v5.5M15.5 3H21v5.5M21 15.5V21h-5.5M8.5 21H3v-5.5" />
  </Svg>
);

export const IconCollapse = (p: P) => (
  <Svg {...p}>
    <path d="M9 3v6H3M15 3v6h6M21 15h-6v6M3 15h6v6" />
  </Svg>
);
/** Older name for IconCollapse; kept so existing call sites keep compiling. */
export const IconContract = IconCollapse;

export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M9 3.5h6l-.7 5.4 3.2 2.8v1.6H6.5v-1.6l3.2-2.8z" />
    <path d="M12 13.3V21" />
  </Svg>
);

/** Filled because "pinned" is a state you must read at a glance in a list. */
export const IconPinFilled = (p: P) => (
  <Svg {...p}>
    <path d="M9 3.5h6l-.7 5.4 3.2 2.8v1.6H6.5v-1.6l3.2-2.8z" fill="currentColor" />
    <path d="M12 13.3V21" />
  </Svg>
);

const STAR = "M12 3.3l2.3 5.85 6.27.37-4.85 3.99 1.58 6.07L12 16.2l-5.29 3.38 1.58-6.07-4.85-3.99 6.27-.37z";

export const IconStar = (p: P) => (
  <Svg {...p}>
    <path d={STAR} />
  </Svg>
);

export const IconStarFilled = (p: P) => (
  <Svg {...p}>
    <path d={STAR} fill="currentColor" />
  </Svg>
);

export const IconArchive = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
    <path d="M4.8 8.5v10a2 2 0 002 2h10.4a2 2 0 002-2v-10" />
    <path d="M10 12.5h4" />
  </Svg>
);

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 4.8l12 7.2-12 7.2z" />
  </Svg>
);

export const IconPause = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="4.5" width="3.5" height="15" rx="1.2" />
    <rect x="13.5" y="4.5" width="3.5" height="15" rx="1.2" />
  </Svg>
);

export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="5" width="14" height="14" rx="2.5" />
  </Svg>
);

export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M4 8.5h9.5a5.5 5.5 0 010 11H7" />
    <path d="M8 4.5L4 8.5l4 4" />
  </Svg>
);

export const IconRedo = (p: P) => (
  <Svg {...p}>
    <path d="M20 8.5h-9.5a5.5 5.5 0 000 11H17" />
    <path d="M16 4.5l4 4-4 4" />
  </Svg>
);

export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Svg>
);

export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h16M4 12h16M4 17.5h16" />
  </Svg>
);

/* ── state ────────────────────────────────────────────────────────────── */

export const IconWarning = (p: P) => (
  <Svg {...p}>
    <path d="M10.6 4.6L3.3 17.4a1.6 1.6 0 001.4 2.4h14.6a1.6 1.6 0 001.4-2.4L13.4 4.6a1.6 1.6 0 00-2.8 0z" />
    <path d="M12 10v3.6M12 16.7v.2" />
  </Svg>
);

export const IconError = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Svg>
);

export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.8v.2" />
  </Svg>
);

export const IconSuccess = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.3l2.8 2.8L16.2 9.6" />
  </Svg>
);

export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 6.8V12l3.6 2.2" />
  </Svg>
);

/**
 * A three-quarter ring. Deliberately un-animated: motion belongs in CSS so it
 * can go still under prefers-reduced-motion. Spin the element, not the icon.
 */
export const IconSpinner = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" opacity={0.25} />
    <path d="M12 3a9 9 0 11-9 9" />
  </Svg>
);

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.6a4 4 0 018 0v2.9" />
    <path d="M12 14.3v2.4" />
  </Svg>
);

export const IconUnlock = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.6a4 4 0 017.5-1.9" />
    <path d="M12 14.3v2.4" />
  </Svg>
);

export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3.2" />
  </Svg>
);

export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M9.9 5.8A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17.2 17.2 0 01-3.4 4.2" />
    <path d="M6.4 7.7A17.4 17.4 0 002.5 12s3.5 6.5 9.5 6.5a9.5 9.5 0 004.2-1" />
    <path d="M9.8 9.9a3.2 3.2 0 004.4 4.4" />
    <path d="M3.5 3.5l17 17" />
  </Svg>
);

/** A live dot inside a ring — present, reachable, running. */
export const IconOnline = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <Dot cx={12} cy={12} r={3.4} />
  </Svg>
);

export const IconOffline = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M6.4 6.4l11.2 11.2" />
  </Svg>
);

/** Blocked / cancelled: a bar, not a slash, so it never reads as "offline". */
export const IconBlocked = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M7.2 12h9.6" />
  </Svg>
);

export const IconDot = (p: P) => (
  <Svg {...p}>
    <Dot cx={12} cy={12} r={4} />
  </Svg>
);

export const IconCircle = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
  </Svg>
);

export const IconCircleFilled = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" fill="currentColor" />
  </Svg>
);

/** Half filled is the meaning: partially shared, partially complete. */
export const IconCircleHalf = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Not started — an outline that has not been drawn yet. */
export const IconCircleDashed = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" strokeDasharray="2.6 3.4" />
  </Svg>
);

export const IconBolt = (p: P) => (
  <Svg {...p}>
    <path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z" />
  </Svg>
);

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
  </Svg>
);

export const IconTarget = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4.5" />
    <Dot cx={12} cy={12} r={1.4} />
  </Svg>
);

export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />
  </Svg>
);

export const IconDiamond = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.2l8.8 8.8L12 20.8 3.2 12z" />
  </Svg>
);

/** A settled decision: balanced, done, not to be relitigated. */
export const IconScale = (p: P) => (
  <Svg {...p}>
    <path d="M12 6.2V20M8 20h8" />
    <path d="M4.5 8.4h15" />
    <circle cx="12" cy="4.8" r="1.4" />
    <path d="M4.5 8.4L1.8 14.2a2.7 2.7 0 005.4 0z" />
    <path d="M19.5 8.4l-2.7 5.8a2.7 2.7 0 005.4 0z" />
  </Svg>
);

/** How things are around here — standing context, orientation. */
export const IconCompass = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" />
  </Svg>
);

/** Parent / child structure — the shape a hierarchy actually has. */
export const IconHierarchy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="5" rx="1.5" />
    <rect x="3" y="16" width="6" height="5" rx="1.5" />
    <rect x="15" y="16" width="6" height="5" rx="1.5" />
    <path d="M12 8v4M6 16v-4h12v4" />
  </Svg>
);

export const IconEmoji = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.4 14a4.3 4.3 0 007.2 0" />
    <Dot cx={9.2} cy={9.6} r={1.1} />
    <Dot cx={14.8} cy={9.6} r={1.1} />
  </Svg>
);

/* ── arrows ───────────────────────────────────────────────────────────── */

export const IconArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);

export const IconArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M18 13l-6 6-6-6" />
  </Svg>
);

export const IconArrowLeft = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const IconArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const IconArrowUpRight = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 17.5L17.5 6.5M8.5 6.5h9v9" />
  </Svg>
);

/** ↵ — "this key runs it", where a keycap would be too heavy. */
export const IconArrowReturn = (p: P) => (
  <Svg {...p}>
    <path d="M20 5v6.5a2.5 2.5 0 01-2.5 2.5H5" />
    <path d="M9 10l-4 4 4 4" />
  </Svg>
);

/** ⇄ — two directions at once: sync, swap, a two-way relation. */
export const IconArrowSwap = (p: P) => (
  <Svg {...p}>
    <path d="M4 9h14M14.5 5.5L18 9l-3.5 3.5" />
    <path d="M20 15H6M9.5 11.5L6 15l3.5 3.5" />
  </Svg>
);

/** ↔ — one line, both ends: a symmetric relation. */
export const IconArrowsHorizontal = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 12h17M7.5 8L3.5 12l4 4M16.5 8l4 4-4 4" />
  </Svg>
);

export const IconChevronUp = (p: P) => (
  <Svg {...p}>
    <path d="M6 14.5l6-6 6 6" />
  </Svg>
);

export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Svg>
);

export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 6l-6 6 6 6" />
  </Svg>
);

export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 6l6 6-6 6" />
  </Svg>
);

/* ── editor ───────────────────────────────────────────────────────────── */

export const IconBold = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 4.5h5.5a3.75 3.75 0 010 7.5H7.5z" />
    <path d="M7.5 12h6.5a3.75 3.75 0 010 7.5H7.5z" />
  </Svg>
);

export const IconItalic = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 4.5h-6M14.5 19.5h-6M14 4.5l-4 15" />
  </Svg>
);

export const IconCode = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 7.5L3.5 12l5 4.5M15.5 7.5l5 4.5-5 4.5" />
    <path d="M13.5 4.5l-3 15" />
  </Svg>
);

export const IconListBulleted = (p: P) => (
  <Svg {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <Dot cx={4.5} cy={6.5} r={1.5} />
    <Dot cx={4.5} cy={12} r={1.5} />
    <Dot cx={4.5} cy={17.5} r={1.5} />
  </Svg>
);

/**
 * Numerals sit beside the first two rows and the third is left bare — drawing
 * a "3" at 13px is unreadable, and two is enough to say "ordered".
 */
export const IconListNumbered = (p: P) => (
  <Svg {...p}>
    <path d="M10 6.5h10M10 12h10M10 17.5h10" />
    <path d="M4.1 4.8h1.1v3.5M3.4 8.3h2.9" />
    <path d="M3.4 10a1.45 1.45 0 012.5 1c0 1.2-2.5 1.9-2.5 3.3h2.9" />
  </Svg>
);

/**
 * Checkboxes, not check marks: this is markdown's `- [ ]`, and the boxes keep
 * it from colliding with IconTasks, which is a check-mark list.
 */
export const IconChecklist = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="6.5" height="6.5" rx="1.6" />
    <path d="M4.7 7.8l1.4 1.4 2.6-3" />
    <rect x="3" y="13" width="6.5" height="6.5" rx="1.6" />
    <path d="M12.5 7.75h8.5M12.5 16.25h8.5" />
  </Svg>
);

/** Markdown's blockquote: a rule in the gutter, not a curly typographic mark. */
export const IconQuote = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 5.5v13" />
    <path d="M9 8h11M9 12h11M9 16h8" />
  </Svg>
);

export const IconHeading = (p: P) => (
  <Svg {...p}>
    <path d="M6 5v14M18 5v14M6 12h12" />
  </Svg>
);

/** A rule between blocks. Dashed so it never reads as a minus. */
export const IconDivider = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 12h4.5M9.8 12h4.4M16 12h4.5" />
  </Svg>
);

export const IconTable = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M3 9.5h18M3 14.5h18M9.5 4.5v15" />
  </Svg>
);

export const IconImage = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.8" cy="9.9" r="1.8" />
    <path d="M3.3 17.4l4.9-4.4a2 2 0 012.7 0l4.4 4" />
    <path d="M13.6 15.2l1.9-1.7a2 2 0 012.7 0l2.5 2.2" />
  </Svg>
);

/* ── name-keyed lookup ────────────────────────────────────────────────── */

/**
 * Data-driven icons. A registry row, a link kind, a harness name — anything
 * that already carries a string can name its icon instead of carrying a glyph
 * or forcing a switch statement at every render site.
 *
 * Aliases are deliberate: `close` and `x` are the same mark, and call sites
 * should be free to use whichever word matches the thing they are describing.
 */
export const ICONS = {
  // objects
  dashboard: IconDashboard,
  tasks: IconTasks,
  task: IconTasks,
  board: IconBoard,
  calendar: IconCalendar,
  event: IconClock,
  mail: IconMail,
  message: IconMessage,
  chat: IconMessage,
  document: IconDocument,
  note: IconNote,
  folder: IconFolder,
  memory: IconMemory,
  agents: IconAgents,
  agent: IconSparkle,
  teams: IconTeams,
  team: IconTeams,
  person: IconPerson,
  member: IconPerson,
  device: IconDevice,
  monitor: IconMonitor,
  workspace: IconWorkspace,
  branch: IconBranch,
  git: IconGit,
  "pull-request": IconPullRequest,
  graph: IconGraph,
  connections: IconGraph,
  knowledge: IconKnowledge,
  content: IconContent,
  project: IconProject,
  repo: IconRepo,
  issue: IconIssue,
  channel: IconHash,
  hash: IconHash,
  at: IconAt,
  mention: IconAt,
  terminal: IconTerminal,
  globe: IconGlobe,
  megaphone: IconMegaphone,
  github: IconGitHub,
  settings: IconSettings,
  gear: IconGear,
  search: IconSearch,
  command: IconCommand,
  // IconLogo is deliberately absent: it is a product mark drawn at its own
  // weight, and letting data pick it would put a heavier glyph in a row of
  // icons that are supposed to match.

  // actions
  plus: IconPlus,
  add: IconPlus,
  minus: IconMinus,
  close: IconX,
  x: IconX,
  check: IconCheck,
  edit: IconEdit,
  trash: IconTrash,
  delete: IconTrash,
  copy: IconCopy,
  duplicate: IconCopy,
  link: IconLink,
  unlink: IconUnlink,
  share: IconShare,
  filter: IconFilter,
  sort: IconSort,
  more: IconMoreHorizontal,
  "more-horizontal": IconMoreHorizontal,
  "more-vertical": IconMoreVertical,
  refresh: IconRefresh,
  send: IconSend,
  download: IconDownload,
  upload: IconUpload,
  external: IconExternal,
  expand: IconExpand,
  collapse: IconCollapse,
  pin: IconPin,
  pinned: IconPinFilled,
  star: IconStar,
  starred: IconStarFilled,
  archive: IconArchive,
  play: IconPlay,
  run: IconPlay,
  pause: IconPause,
  stop: IconStop,
  undo: IconUndo,
  redo: IconRedo,
  grid: IconGrid,
  list: IconList,

  // state
  warning: IconWarning,
  error: IconError,
  info: IconInfo,
  success: IconSuccess,
  clock: IconClock,
  spinner: IconSpinner,
  lock: IconLock,
  private: IconLock,
  unlock: IconUnlock,
  eye: IconEye,
  "eye-off": IconEyeOff,
  online: IconOnline,
  offline: IconOffline,
  blocked: IconBlocked,
  cancelled: IconBlocked,
  dot: IconDot,
  circle: IconCircle,
  "circle-filled": IconCircleFilled,
  "circle-half": IconCircleHalf,
  "circle-dashed": IconCircleDashed,
  bolt: IconBolt,
  sun: IconSun,
  light: IconSun,
  moon: IconMoon,
  dark: IconMoon,
  system: IconMonitor,
  target: IconTarget,
  sparkle: IconSparkle,
  diamond: IconDiamond,
  scale: IconScale,
  decision: IconScale,
  compass: IconCompass,
  context: IconCompass,
  hierarchy: IconHierarchy,
  parent: IconHierarchy,
  emoji: IconEmoji,

  // arrows
  "arrow-up": IconArrowUp,
  "arrow-down": IconArrowDown,
  "arrow-left": IconArrowLeft,
  "arrow-right": IconArrowRight,
  "arrow-up-right": IconArrowUpRight,
  "arrow-return": IconArrowReturn,
  "arrow-swap": IconArrowSwap,
  "arrows-horizontal": IconArrowsHorizontal,
  relates: IconArrowsHorizontal,
  references: IconArrowRight,
  depends: IconArrowRight,
  "chevron-up": IconChevronUp,
  "chevron-down": IconChevronDown,
  "chevron-left": IconChevronLeft,
  "chevron-right": IconChevronRight,

  // editor
  bold: IconBold,
  italic: IconItalic,
  code: IconCode,
  "list-bulleted": IconListBulleted,
  "list-numbered": IconListNumbered,
  checklist: IconChecklist,
  quote: IconQuote,
  heading: IconHeading,
  divider: IconDivider,
  table: IconTable,
  image: IconImage,
} as const;

export type IconName = keyof typeof ICONS;

/** Every registered name, for a gallery or a design harness. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export const hasIcon = (name: string): name is IconName => name in ICONS;

/**
 * `<Icon name={row.icon} />` — the lookup form.
 *
 * An unknown name renders nothing rather than throwing or drawing a fallback
 * box: icons are decorative here, and a missing one should cost a bit of
 * whitespace, never a blank screen or a mystery glyph in a shipped list.
 */
export function Icon({ name, ...rest }: P & { name: IconName | (string & {}) }) {
  const Cmp = (ICONS as Record<string, ((props: P) => ReactElement) | undefined>)[name];
  return Cmp ? <Cmp {...rest} /> : null;
}
