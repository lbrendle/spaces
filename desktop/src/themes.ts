/**
 * IDE-inspired theme system.
 *
 * A theme is a small palette spec; every CSS custom property the app uses is
 * DERIVED from it in `cssVarsFor` so components never need per-theme rules —
 * they just consume tokens. Applying a theme sets those properties on <html>,
 * so switching is instant and has no flash.
 *
 * On top of the palette sits a second, orthogonal layer: user *appearance*
 * overrides (accent, density, radius, font scale, mono stack, motion, tint).
 * They are folded into the same derivation pass so there is exactly one place
 * that decides what a token ends up being.
 */

export type Appearance = "dark" | "light";
/** Spacing rhythm. Drives --space-1..6 and --row-h, not the type scale. */
export type Density = "compact" | "cozy" | "comfortable";
export type RadiusScale = "sharp" | "default" | "round";

export interface ThemeSpec {
  id: string;
  name: string;
  author: string;
  appearance: Appearance;
  /** editor background */
  bg: string;
  /** sidebar / panel background */
  bgRaised: string;
  /** popovers, modals, floating surfaces */
  bgOverlay: string;
  bgHover: string;
  /** selected row / active nav */
  bgActive: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  orange: string;
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    func: string;
    type: string;
    punct: string;
  };
  /** hashed per-identity colors (agents, avatars, teams) */
  avatars: string[];
  /** free-form family labels the picker groups and filters by */
  tags: string[];
}

/* ── color helpers ─────────────────────────────────────────── */

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Blend `a` toward `b` by t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

export function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** WCAG relative luminance — decides whether text on a color should be light or dark. */
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableOn(bg: string): string {
  return luminance(bg) > 0.5 ? "#0b0b0f" : "#ffffff";
}

/** WCAG contrast ratio, 1..21 — the settings UI shows this for custom accents. */
export function contrastRatio(a: string, b: string): number {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v.trim());
}

/** '#ABC' → '#aabbcc'. Returns '' for anything that is not a hex color. */
export function normalizeHex(v: unknown): string {
  return isHex(v) ? toHex(parseHex(v.trim())) : "";
}

/* ── themes ────────────────────────────────────────────────── */

export const THEMES: ThemeSpec[] = [
  /*
   * The product's own dark theme, and the one almost everyone will see.
   *
   * It was a cool blue-grey: every neutral sat on the blue side of the accent,
   * which made the whole app read as a screen rather than as a surface. The
   * greys are near-neutral now with a trace of warmth in them — a couple of
   * points of red and green over blue, which is not enough to read as brown
   * and is exactly enough to stop reading as cold. Nothing about the hierarchy
   * moved; every step is the same distance from its neighbour as before.
   */
  {
    id: "spaces-midnight",
    name: "Spaces Midnight",
    author: "Spaces",
    appearance: "dark",
    bg: "#16141b", bgRaised: "#110f16", bgOverlay: "#201d28",
    bgHover: "#232030", bgActive: "#302b3f", border: "#322d40",
    text: "#efecf5", textDim: "#a9a3b8", textFaint: "#746d85",
    accent: "#7c6cff",
    red: "#ff7a7a", green: "#5fd39a", yellow: "#f5c469",
    blue: "#8a92ff", purple: "#a78bfa", cyan: "#4fd6d6", orange: "#ff9d6b",
    syntax: {
      keyword: "#a78bfa", string: "#5fd39a", number: "#ff9d6b",
      comment: "#6c6678", func: "#7c6cff", type: "#4fd6d6", punct: "#a8a3b4",
    },
    avatars: ["#7c6cff", "#5fd39a", "#ff9d6b", "#e07be0", "#ff7a7a", "#4fd6d6", "#f5c469", "#6f9bff"],
    tags: ["warm", "vibrant", "high-contrast"],
  },
  /*
   * The product's own light theme, and the default one.
   *
   * The default used to be GitHub Light — a fine theme, and a borrowed one:
   * pure #ffffff paper with cool grey neutrals and a set of identity colours
   * chosen for text contrast, which as avatar fills came out as a row of muddy
   * browns. This is the same palette family as Midnight, inverted: warm paper,
   * near-neutral greys with a trace of red in them, and identity colours that
   * are meant to be *filled* rather than set as type.
   */
  {
    id: "spaces-daylight",
    name: "Spaces Daylight",
    author: "Spaces",
    appearance: "light",
    bg: "#fdfaf5", bgRaised: "#f3eee4", bgOverlay: "#fffefb",
    bgHover: "#efe9dd", bgActive: "#e3dbcb", border: "#ddd4c4",
    text: "#241f19", textDim: "#6b6155", textFaint: "#988d7d",
    accent: "#6c5ce7",
    red: "#e0524f", green: "#2f9e6e", yellow: "#c58a1e",
    /* Pulled toward the accent's hue. "To do" on the work bars is --blue, and
       a straight cobalt sitting a centimetre from a violet accent is a near
       miss — two colours close enough to look like one of them is wrong. */
    blue: "#5b63d6", purple: "#8257d9", cyan: "#1d9096", orange: "#d4703a",
    syntax: {
      keyword: "#8257d9", string: "#2f9e6e", number: "#d4703a",
      comment: "#8b8593", func: "#6c5ce7", type: "#1d9096", punct: "#5f5a68",
    },
    avatars: ["#6c5ce7", "#2f9e6e", "#d4703a", "#b04bb0", "#e0524f", "#1d9096", "#c58a1e", "#3d6fd4"],
    tags: ["warm", "soft", "minimal"],
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    author: "folke",
    appearance: "dark",
    bg: "#1a1b26", bgRaised: "#16161e", bgOverlay: "#1f2335",
    bgHover: "#232433", bgActive: "#292e42", border: "#2f334d",
    text: "#c0caf5", textDim: "#a9b1d6", textFaint: "#565f89",
    accent: "#7aa2f7",
    red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", purple: "#bb9af7", cyan: "#7dcfff", orange: "#ff9e64",
    syntax: {
      keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64",
      comment: "#565f89", func: "#7aa2f7", type: "#2ac3de", punct: "#89ddff",
    },
    avatars: ["#7aa2f7", "#9ece6a", "#ff9e64", "#bb9af7", "#f7768e", "#7dcfff", "#e0af68", "#2ac3de"],
    tags: ["cool", "muted"],
  },
  {
    id: "dracula",
    name: "Dracula",
    author: "Zeno Rocha",
    appearance: "dark",
    bg: "#282a36", bgRaised: "#21222c", bgOverlay: "#2f313f",
    bgHover: "#343746", bgActive: "#44475a", border: "#44475a",
    text: "#f8f8f2", textDim: "#bdc0d0", textFaint: "#6272a4",
    accent: "#bd93f9",
    red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#8be9fd", purple: "#bd93f9", cyan: "#8be9fd", orange: "#ffb86c",
    syntax: {
      keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9",
      comment: "#6272a4", func: "#50fa7b", type: "#8be9fd", punct: "#f8f8f2",
    },
    avatars: ["#bd93f9", "#50fa7b", "#ffb86c", "#ff79c6", "#ff5555", "#8be9fd", "#f1fa8c", "#a074c4"],
    tags: ["vibrant", "classic", "high-contrast"],
  },
  {
    id: "nord",
    name: "Nord",
    author: "Arctic Ice Studio",
    appearance: "dark",
    bg: "#2e3440", bgRaised: "#2b303b", bgOverlay: "#3b4252",
    bgHover: "#3b4252", bgActive: "#434c5e", border: "#434c5e",
    text: "#eceff4", textDim: "#d8dee9", textFaint: "#7b88a1",
    accent: "#88c0d0",
    red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", purple: "#b48ead", cyan: "#8fbcbb", orange: "#d08770",
    syntax: {
      keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead",
      comment: "#616e88", func: "#88c0d0", type: "#8fbcbb", punct: "#eceff4",
    },
    avatars: ["#88c0d0", "#a3be8c", "#d08770", "#b48ead", "#bf616a", "#8fbcbb", "#ebcb8b", "#81a1c1"],
    tags: ["cool", "muted", "classic"],
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    author: "Catppuccin",
    appearance: "dark",
    bg: "#1e1e2e", bgRaised: "#181825", bgOverlay: "#252537",
    bgHover: "#313244", bgActive: "#45475a", border: "#45475a",
    text: "#cdd6f4", textDim: "#a6adc8", textFaint: "#7f849c",
    accent: "#89b4fa",
    red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", purple: "#cba6f7", cyan: "#94e2d5", orange: "#fab387",
    syntax: {
      keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387",
      comment: "#6c7086", func: "#89b4fa", type: "#f9e2af", punct: "#94e2d5",
    },
    avatars: ["#89b4fa", "#a6e3a1", "#fab387", "#cba6f7", "#f38ba8", "#94e2d5", "#f9e2af", "#f5c2e7"],
    tags: ["cool", "pastel", "vibrant"],
  },
  {
    id: "one-dark",
    name: "One Dark Pro",
    author: "Atom",
    appearance: "dark",
    bg: "#282c34", bgRaised: "#21252b", bgOverlay: "#2c313a",
    bgHover: "#2c313a", bgActive: "#3e4451", border: "#3e4451",
    text: "#abb2bf", textDim: "#9199a6", textFaint: "#5c6370",
    accent: "#61afef",
    red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", purple: "#c678dd", cyan: "#56b6c2", orange: "#d19a66",
    syntax: {
      keyword: "#c678dd", string: "#98c379", number: "#d19a66",
      comment: "#5c6370", func: "#61afef", type: "#e5c07b", punct: "#abb2bf",
    },
    avatars: ["#61afef", "#98c379", "#d19a66", "#c678dd", "#e06c75", "#56b6c2", "#e5c07b", "#7f9fd4"],
    tags: ["neutral", "classic", "muted"],
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    author: "morhetz",
    appearance: "dark",
    bg: "#282828", bgRaised: "#1d2021", bgOverlay: "#32302f",
    bgHover: "#3c3836", bgActive: "#504945", border: "#504945",
    text: "#ebdbb2", textDim: "#bdae93", textFaint: "#928374",
    accent: "#83a598",
    red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f",
    blue: "#83a598", purple: "#d3869b", cyan: "#8ec07c", orange: "#fe8019",
    syntax: {
      keyword: "#fb4934", string: "#b8bb26", number: "#d3869b",
      comment: "#928374", func: "#8ec07c", type: "#fabd2f", punct: "#ebdbb2",
    },
    avatars: ["#83a598", "#b8bb26", "#fe8019", "#d3869b", "#fb4934", "#8ec07c", "#fabd2f", "#a89984"],
    tags: ["warm", "earthy", "classic", "vibrant"],
  },
  {
    id: "monokai-pro",
    name: "Monokai Pro",
    author: "Monokai",
    appearance: "dark",
    bg: "#2d2a2e", bgRaised: "#221f22", bgOverlay: "#363437",
    bgHover: "#403e41", bgActive: "#4a474b", border: "#4a474b",
    text: "#fcfcfa", textDim: "#c1c0c0", textFaint: "#939293",
    accent: "#78dce8",
    red: "#ff6188", green: "#a9dc76", yellow: "#ffd866",
    blue: "#78dce8", purple: "#ab9df2", cyan: "#78dce8", orange: "#fc9867",
    syntax: {
      keyword: "#ff6188", string: "#ffd866", number: "#ab9df2",
      comment: "#727072", func: "#a9dc76", type: "#78dce8", punct: "#fcfcfa",
    },
    avatars: ["#78dce8", "#a9dc76", "#fc9867", "#ab9df2", "#ff6188", "#ffd866", "#66d9ef", "#e07ba4"],
    tags: ["warm", "vibrant", "high-contrast"],
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    author: "Ethan Schoonover",
    appearance: "dark",
    bg: "#002b36", bgRaised: "#00252e", bgOverlay: "#073642",
    bgHover: "#073642", bgActive: "#0a4657", border: "#0f4b5c",
    text: "#e6e2d3", textDim: "#93a1a1", textFaint: "#587782",
    accent: "#268bd2",
    red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", purple: "#6c71c4", cyan: "#2aa198", orange: "#cb4b16",
    syntax: {
      keyword: "#859900", string: "#2aa198", number: "#d33682",
      comment: "#586e75", func: "#268bd2", type: "#b58900", punct: "#93a1a1",
    },
    avatars: ["#268bd2", "#859900", "#cb4b16", "#6c71c4", "#dc322f", "#2aa198", "#b58900", "#d33682"],
    tags: ["cool", "classic", "muted"],
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    author: "GitHub",
    appearance: "dark",
    bg: "#0d1117", bgRaised: "#010409", bgOverlay: "#161b22",
    bgHover: "#161b22", bgActive: "#21262d", border: "#30363d",
    text: "#e6edf3", textDim: "#8b949e", textFaint: "#6e7681",
    accent: "#58a6ff",
    red: "#f85149", green: "#3fb950", yellow: "#d29922",
    blue: "#58a6ff", purple: "#bc8cff", cyan: "#39c5cf", orange: "#ffa657",
    syntax: {
      keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff",
      comment: "#8b949e", func: "#d2a8ff", type: "#ffa657", punct: "#c9d1d9",
    },
    avatars: ["#58a6ff", "#3fb950", "#ffa657", "#bc8cff", "#f85149", "#39c5cf", "#d29922", "#db61a2"],
    tags: ["neutral", "high-contrast"],
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    author: "Rosé Pine",
    appearance: "dark",
    bg: "#191724", bgRaised: "#1f1d2e", bgOverlay: "#26233a",
    bgHover: "#26233a", bgActive: "#403d52", border: "#403d52",
    text: "#e0def4", textDim: "#908caa", textFaint: "#6e6a86",
    accent: "#c4a7e7",
    red: "#eb6f92", green: "#9ccfd8", yellow: "#f6c177",
    blue: "#31748f", purple: "#c4a7e7", cyan: "#9ccfd8", orange: "#ebbcba",
    syntax: {
      keyword: "#31748f", string: "#f6c177", number: "#ebbcba",
      comment: "#6e6a86", func: "#ebbcba", type: "#9ccfd8", punct: "#908caa",
    },
    avatars: ["#c4a7e7", "#9ccfd8", "#f6c177", "#eb6f92", "#31748f", "#ebbcba", "#908caa", "#b4637a"],
    tags: ["warm", "muted", "pastel"],
  },
  {
    id: "github-light",
    name: "GitHub Light",
    author: "GitHub",
    appearance: "light",
    bg: "#ffffff", bgRaised: "#f6f8fa", bgOverlay: "#ffffff",
    bgHover: "#eef1f4", bgActive: "#dfe4ea", border: "#d0d7de",
    text: "#1f2328", textDim: "#59636e", textFaint: "#818b98",
    accent: "#0969da",
    red: "#cf222e", green: "#1a7f37", yellow: "#9a6700",
    blue: "#0969da", purple: "#8250df", cyan: "#1b7c83", orange: "#bc4c00",
    syntax: {
      keyword: "#cf222e", string: "#0a3069", number: "#0550ae",
      comment: "#59636e", func: "#8250df", type: "#953800", punct: "#1f2328",
    },
    avatars: ["#0969da", "#1a7f37", "#bc4c00", "#8250df", "#cf222e", "#1b7c83", "#9a6700", "#bf3989"],
    tags: ["neutral", "high-contrast"],
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    author: "Catppuccin",
    appearance: "light",
    bg: "#eff1f5", bgRaised: "#e6e9ef", bgOverlay: "#ffffff",
    bgHover: "#dce0e8", bgActive: "#ccd0da", border: "#bcc0cc",
    text: "#4c4f69", textDim: "#6c6f85", textFaint: "#8c8fa1",
    accent: "#1e66f5",
    red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
    blue: "#1e66f5", purple: "#8839ef", cyan: "#179299", orange: "#fe640b",
    syntax: {
      keyword: "#8839ef", string: "#40a02b", number: "#fe640b",
      comment: "#9ca0b0", func: "#1e66f5", type: "#df8e1d", punct: "#179299",
    },
    avatars: ["#1e66f5", "#40a02b", "#fe640b", "#8839ef", "#d20f39", "#179299", "#df8e1d", "#ea76cb"],
    tags: ["cool", "vibrant", "pastel"],
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    author: "Ethan Schoonover",
    appearance: "light",
    bg: "#fdf6e3", bgRaised: "#f5eed8", bgOverlay: "#fffbf0",
    bgHover: "#eee8d5", bgActive: "#e3ddc8", border: "#ded8c4",
    text: "#073642", textDim: "#657b83", textFaint: "#93a1a1",
    accent: "#268bd2",
    red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", purple: "#6c71c4", cyan: "#2aa198", orange: "#cb4b16",
    syntax: {
      keyword: "#859900", string: "#2aa198", number: "#d33682",
      comment: "#93a1a1", func: "#268bd2", type: "#b58900", punct: "#657b83",
    },
    avatars: ["#268bd2", "#859900", "#cb4b16", "#6c71c4", "#dc322f", "#2aa198", "#b58900", "#d33682"],
    tags: ["warm", "classic", "muted"],
  },

  /* ── added palettes ──────────────────────────────────────────
     Ported from the upstream editor themes named in `author`. Two
     deliberate deviations from the originals, both for legibility at UI
     (not editor) scale: semantic colors used as *text* — red/green/yellow
     status labels — are deepened on light themes, and any `textFaint`
     that fell under a ~3:1 ratio against its own background was nudged
     until it cleared it. Hues are kept, values are not always literal. */

  {
    id: "ayu-dark",
    name: "Ayu Dark",
    author: "dempfi",
    appearance: "dark",
    bg: "#0b0e14", bgRaised: "#0d1017", bgOverlay: "#131721",
    bgHover: "#161b25", bgActive: "#1f2733", border: "#1f2430",
    text: "#bfbdb6", textDim: "#a3a49f", textFaint: "#7c848f",
    accent: "#e6b450",
    red: "#f07178", green: "#aad94c", yellow: "#e6b450",
    blue: "#59c2ff", purple: "#d2a6ff", cyan: "#95e6cb", orange: "#ff8f40",
    syntax: {
      keyword: "#ff8f40", string: "#aad94c", number: "#d2a6ff",
      comment: "#6c7079", func: "#ffb454", type: "#59c2ff", punct: "#bfbdb6",
    },
    avatars: ["#e6b450", "#aad94c", "#ff8f40", "#d2a6ff", "#f07178", "#59c2ff", "#95e6cb", "#ffb454"],
    tags: ["warm", "vibrant", "high-contrast"],
  },
  {
    id: "ayu-mirage",
    name: "Ayu Mirage",
    author: "dempfi",
    appearance: "dark",
    bg: "#1f2430", bgRaised: "#1c212b", bgOverlay: "#242b38",
    bgHover: "#2a3140", bgActive: "#33415e", border: "#2f3846",
    text: "#cccac2", textDim: "#adb3bf", textFaint: "#828b9b",
    accent: "#ffcc66",
    red: "#ff6666", green: "#d5ff80", yellow: "#ffcc66",
    blue: "#73d0ff", purple: "#dfbfff", cyan: "#95e6cb", orange: "#ffad66",
    syntax: {
      keyword: "#ffad66", string: "#d5ff80", number: "#dfbfff",
      comment: "#707a8c", func: "#ffd173", type: "#73d0ff", punct: "#cccac2",
    },
    avatars: ["#ffcc66", "#d5ff80", "#ffad66", "#dfbfff", "#f28779", "#73d0ff", "#95e6cb", "#5ccfe6"],
    tags: ["warm", "muted"],
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    author: "dempfi",
    appearance: "light",
    bg: "#fcfcfc", bgRaised: "#f3f4f5", bgOverlay: "#ffffff",
    bgHover: "#eef0f1", bgActive: "#dfe6ee", border: "#dcdfe3",
    text: "#4e5359", textDim: "#6e757b", textFaint: "#8a9199",
    accent: "#d97b0b",
    red: "#e02a2a", green: "#6d8c00", yellow: "#a37200",
    blue: "#2a7fbd", purple: "#8a5ec2", cyan: "#1f8f6d", orange: "#d9691f",
    syntax: {
      keyword: "#d9691f", string: "#6d8c00", number: "#8a5ec2",
      comment: "#8b939b", func: "#b57a00", type: "#2a7fbd", punct: "#4e5359",
    },
    avatars: ["#d97b0b", "#6d8c00", "#d9691f", "#8a5ec2", "#e02a2a", "#2a7fbd", "#1f8f6d", "#b57a00"],
    tags: ["warm", "soft", "minimal"],
  },
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    author: "sainnhe",
    appearance: "dark",
    bg: "#2d353b", bgRaised: "#232a2e", bgOverlay: "#343f44",
    bgHover: "#3d484d", bgActive: "#475258", border: "#414b50",
    text: "#d3c6aa", textDim: "#b0b8ab", textFaint: "#8b9488",
    accent: "#a7c080",
    red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f",
    blue: "#7fbbb3", purple: "#d699b6", cyan: "#83c092", orange: "#e69875",
    syntax: {
      keyword: "#e67e80", string: "#dbbc7f", number: "#d699b6",
      comment: "#859289", func: "#a7c080", type: "#83c092", punct: "#d3c6aa",
    },
    avatars: ["#a7c080", "#7fbbb3", "#e69875", "#d699b6", "#e67e80", "#83c092", "#dbbc7f", "#b0b8ab"],
    tags: ["warm", "muted", "earthy", "soft"],
  },
  {
    id: "everforest-light",
    name: "Everforest Light",
    author: "sainnhe",
    appearance: "light",
    bg: "#fdf6e3", bgRaised: "#f4f0d9", bgOverlay: "#fffbef",
    bgHover: "#efebd4", bgActive: "#e6e2cc", border: "#dcd7bb",
    text: "#4a5860", textDim: "#5f6e6a", textFaint: "#82917f",
    accent: "#788a00",
    red: "#d13b38", green: "#6f7f00", yellow: "#a67c00",
    blue: "#3a94c5", purple: "#c05a9c", cyan: "#2c8c68", orange: "#d16a1c",
    syntax: {
      keyword: "#d13b38", string: "#6f7f00", number: "#c05a9c",
      comment: "#818f7d", func: "#2c8c68", type: "#a67c00", punct: "#4a5860",
    },
    avatars: ["#788a00", "#3a94c5", "#d16a1c", "#c05a9c", "#d13b38", "#2c8c68", "#a67c00", "#6f7f00"],
    tags: ["warm", "muted", "earthy", "soft"],
  },
  {
    id: "kanagawa-wave",
    name: "Kanagawa Wave",
    author: "rebelot",
    appearance: "dark",
    bg: "#1f1f28", bgRaised: "#16161d", bgOverlay: "#2a2a37",
    bgHover: "#223249", bgActive: "#2d4f67", border: "#363646",
    text: "#dcd7ba", textDim: "#c8c093", textFaint: "#8a8878",
    accent: "#7e9cd8",
    red: "#e46876", green: "#98bb6c", yellow: "#e6c384",
    blue: "#7e9cd8", purple: "#957fb8", cyan: "#7aa89f", orange: "#ffa066",
    syntax: {
      keyword: "#957fb8", string: "#98bb6c", number: "#d27e99",
      comment: "#8a8878", func: "#7e9cd8", type: "#7aa89f", punct: "#c8c093",
    },
    avatars: ["#7e9cd8", "#98bb6c", "#ffa066", "#957fb8", "#e46876", "#7aa89f", "#e6c384", "#d27e99"],
    tags: ["cool", "muted", "soft"],
  },
  {
    id: "kanagawa-lotus",
    name: "Kanagawa Lotus",
    author: "rebelot",
    appearance: "light",
    bg: "#f2ecbc", bgRaised: "#ebe4b2", bgOverlay: "#f7f3d3",
    bgHover: "#e9e2ae", bgActive: "#dcd5ac", border: "#cfc79b",
    text: "#464657", textDim: "#6a6759", textFaint: "#807e70",
    accent: "#4d699b",
    red: "#c84053", green: "#6f894e", yellow: "#77713f",
    blue: "#4d699b", purple: "#624c83", cyan: "#597b75", orange: "#b35f00",
    syntax: {
      keyword: "#624c83", string: "#6f894e", number: "#b35b79",
      comment: "#807e70", func: "#4d699b", type: "#597b75", punct: "#6a6759",
    },
    avatars: ["#4d699b", "#6f894e", "#b35f00", "#624c83", "#c84053", "#597b75", "#77713f", "#b35b79"],
    tags: ["warm", "earthy", "classic"],
  },
  {
    id: "night-owl",
    name: "Night Owl",
    author: "Sarah Drasner",
    appearance: "dark",
    bg: "#011627", bgRaised: "#010e1a", bgOverlay: "#0b2942",
    bgHover: "#122d42", bgActive: "#1d3b53", border: "#10314b",
    text: "#d6deeb", textDim: "#9cabc2", textFaint: "#7288a0",
    accent: "#82aaff",
    red: "#ff5874", green: "#addb67", yellow: "#ffcb8b",
    blue: "#82aaff", purple: "#c792ea", cyan: "#7fdbca", orange: "#f78c6c",
    syntax: {
      keyword: "#c792ea", string: "#ecc48d", number: "#f78c6c",
      comment: "#7288a0", func: "#82aaff", type: "#7fdbca", punct: "#d6deeb",
    },
    avatars: ["#82aaff", "#addb67", "#f78c6c", "#c792ea", "#ff5874", "#7fdbca", "#ffcb8b", "#21c7a8"],
    tags: ["cool", "vibrant", "high-contrast"],
  },
  {
    id: "light-owl",
    name: "Light Owl",
    author: "Sarah Drasner",
    appearance: "light",
    bg: "#fbfbfb", bgRaised: "#f0f0f0", bgOverlay: "#ffffff",
    bgHover: "#eaeaea", bgActive: "#e0e0e0", border: "#d9d9d9",
    text: "#403f53", textDim: "#5f6b7d", textFaint: "#7b8894",
    accent: "#4876d6",
    red: "#d3423e", green: "#0c8a63", yellow: "#96690a",
    blue: "#4876d6", purple: "#994cc3", cyan: "#0c969b", orange: "#bd5b57",
    syntax: {
      keyword: "#994cc3", string: "#bd5b57", number: "#aa0982",
      comment: "#7b8894", func: "#4876d6", type: "#0c969b", punct: "#403f53",
    },
    avatars: ["#4876d6", "#0c8a63", "#bd5b57", "#994cc3", "#d3423e", "#0c969b", "#96690a", "#aa0982"],
    tags: ["cool", "soft", "minimal"],
  },
  {
    id: "synthwave-84",
    name: "SynthWave '84",
    author: "Robb Owen",
    appearance: "dark",
    bg: "#262335", bgRaised: "#241b2f", bgOverlay: "#2a2139",
    bgHover: "#34294f", bgActive: "#463465", border: "#453a63",
    text: "#f0eff1", textDim: "#b7b3c7", textFaint: "#8d94c4",
    accent: "#ff7edb",
    red: "#fe4450", green: "#72f1b8", yellow: "#fede5d",
    blue: "#03edf9", purple: "#b893ce", cyan: "#36f9f6", orange: "#ff8b39",
    syntax: {
      keyword: "#fede5d", string: "#ff8b39", number: "#f97e72",
      comment: "#8d94c4", func: "#36f9f6", type: "#fe4450", punct: "#f0eff1",
    },
    avatars: ["#ff7edb", "#72f1b8", "#ff8b39", "#b893ce", "#fe4450", "#36f9f6", "#fede5d", "#f97e72"],
    tags: ["vibrant", "retro", "high-contrast"],
  },
  {
    id: "material-deep-ocean",
    name: "Material Deep Ocean",
    author: "Mattia Astorino",
    appearance: "dark",
    bg: "#0f111a", bgRaised: "#090b10", bgOverlay: "#1a1c25",
    bgHover: "#1f2233", bgActive: "#2e3244", border: "#262a3d",
    text: "#a6accd", textDim: "#949bbd", textFaint: "#7681b8",
    accent: "#84ffff",
    red: "#f07178", green: "#c3e88d", yellow: "#ffcb6b",
    blue: "#82aaff", purple: "#c792ea", cyan: "#89ddff", orange: "#f78c6c",
    syntax: {
      keyword: "#c792ea", string: "#c3e88d", number: "#f78c6c",
      comment: "#7681b8", func: "#82aaff", type: "#ffcb6b", punct: "#89ddff",
    },
    avatars: ["#84ffff", "#c3e88d", "#f78c6c", "#c792ea", "#f07178", "#82aaff", "#ffcb6b", "#89ddff"],
    tags: ["cool", "vibrant", "high-contrast"],
  },
  {
    id: "vitesse-dark",
    name: "Vitesse Dark",
    author: "Anthony Fu",
    appearance: "dark",
    bg: "#121212", bgRaised: "#0e0e0e", bgOverlay: "#1c1c1c",
    bgHover: "#1e1e1e", bgActive: "#2a2a2a", border: "#2b2b2b",
    text: "#dbd7ca", textDim: "#a5a196", textFaint: "#7f8b7f",
    accent: "#4d9375",
    red: "#cb7676", green: "#4d9375", yellow: "#e6cc77",
    blue: "#6394bf", purple: "#bd8ec0", cyan: "#5eaab5", orange: "#d4976c",
    syntax: {
      keyword: "#4d9375", string: "#c98a7d", number: "#4c9a91",
      comment: "#7f8b7f", func: "#80a665", type: "#5da994", punct: "#9d9d9d",
    },
    avatars: ["#4d9375", "#80a665", "#d4976c", "#bd8ec0", "#cb7676", "#5eaab5", "#e6cc77", "#6394bf"],
    tags: ["muted", "earthy", "minimal"],
  },
  {
    id: "vitesse-light",
    name: "Vitesse Light",
    author: "Anthony Fu",
    appearance: "light",
    bg: "#ffffff", bgRaised: "#f7f7f7", bgOverlay: "#ffffff",
    bgHover: "#f0f0f0", bgActive: "#e7e7e7", border: "#dfdfdf",
    text: "#393a34", textDim: "#63655c", textFaint: "#87907f",
    accent: "#1c6b48",
    red: "#ab5959", green: "#1e754f", yellow: "#8a7420",
    blue: "#296aa3", purple: "#6f42c1", cyan: "#2e8f82", orange: "#a65e2b",
    syntax: {
      keyword: "#1e754f", string: "#b56959", number: "#2f8a89",
      comment: "#87907f", func: "#59873a", type: "#2e8f82", punct: "#8a8a8a",
    },
    avatars: ["#1c6b48", "#59873a", "#a65e2b", "#6f42c1", "#ab5959", "#296aa3", "#8a7420", "#2e8f82"],
    tags: ["muted", "minimal", "soft"],
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    author: "Rosé Pine",
    appearance: "light",
    bg: "#faf4ed", bgRaised: "#fffaf3", bgOverlay: "#ffffff",
    bgHover: "#f2e9e1", bgActive: "#dfdad9", border: "#dcd3ca",
    text: "#575279", textDim: "#6b6785", textFaint: "#8d879b",
    accent: "#907aa9",
    red: "#b4637a", green: "#56949f", yellow: "#b07d13",
    blue: "#286983", purple: "#907aa9", cyan: "#56949f", orange: "#c1615c",
    syntax: {
      keyword: "#286983", string: "#b07d13", number: "#c1615c",
      comment: "#8d879b", func: "#c1615c", type: "#56949f", punct: "#6b6785",
    },
    avatars: ["#907aa9", "#56949f", "#b07d13", "#b4637a", "#286983", "#c1615c", "#6b6785", "#8a4f68"],
    tags: ["warm", "muted", "pastel", "soft"],
  },
  {
    id: "tokyo-night-storm",
    name: "Tokyo Night Storm",
    author: "folke",
    appearance: "dark",
    bg: "#24283b", bgRaised: "#1f2335", bgOverlay: "#292e42",
    bgHover: "#2a2f45", bgActive: "#343a55", border: "#3b4261",
    text: "#c0caf5", textDim: "#a9b1d6", textFaint: "#7982b0",
    accent: "#7aa2f7",
    red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", purple: "#bb9af7", cyan: "#7dcfff", orange: "#ff9e64",
    syntax: {
      keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64",
      comment: "#7982b0", func: "#7aa2f7", type: "#2ac3de", punct: "#89ddff",
    },
    avatars: ["#7aa2f7", "#9ece6a", "#ff9e64", "#bb9af7", "#f7768e", "#7dcfff", "#e0af68", "#2ac3de"],
    tags: ["cool", "muted", "soft"],
  },
  {
    id: "tokyo-night-light",
    name: "Tokyo Night Light",
    author: "folke",
    appearance: "light",
    bg: "#e1e2e7", bgRaised: "#d9dbe3", bgOverlay: "#f2f3f7",
    bgHover: "#d4d6e0", bgActive: "#c4c8da", border: "#c2c5d2",
    text: "#28468a", textDim: "#4a5891", textFaint: "#737ca8",
    accent: "#2e7de9",
    red: "#c64343", green: "#587539", yellow: "#8c6c3e",
    blue: "#2e7de9", purple: "#8b4ae0", cyan: "#00697c", orange: "#a8560a",
    syntax: {
      keyword: "#8b4ae0", string: "#587539", number: "#a8560a",
      comment: "#737ca8", func: "#2e7de9", type: "#00697c", punct: "#4a5891",
    },
    avatars: ["#2e7de9", "#587539", "#a8560a", "#8b4ae0", "#c64343", "#00697c", "#8c6c3e", "#0f7d68"],
    tags: ["cool", "soft"],
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    author: "morhetz",
    appearance: "light",
    bg: "#fbf1c7", bgRaised: "#f2e5bc", bgOverlay: "#f9f5d7",
    bgHover: "#f0e4bd", bgActive: "#ebdbb2", border: "#d5c4a1",
    text: "#3c3836", textDim: "#665c54", textFaint: "#8a7c6c",
    accent: "#076678",
    red: "#9d0006", green: "#79740e", yellow: "#b57614",
    blue: "#076678", purple: "#8f3f71", cyan: "#427b58", orange: "#af3a03",
    syntax: {
      keyword: "#9d0006", string: "#79740e", number: "#8f3f71",
      comment: "#8a7c6c", func: "#427b58", type: "#b57614", punct: "#3c3836",
    },
    avatars: ["#076678", "#79740e", "#af3a03", "#8f3f71", "#9d0006", "#427b58", "#b57614", "#665c54"],
    tags: ["warm", "earthy", "classic", "high-contrast"],
  },
  {
    id: "nord-snow-storm",
    name: "Nord Snow Storm",
    author: "Arctic Ice Studio",
    appearance: "light",
    bg: "#eceff4", bgRaised: "#e5e9f0", bgOverlay: "#ffffff",
    bgHover: "#e0e5ee", bgActive: "#d8dee9", border: "#cbd3e0",
    text: "#2e3440", textDim: "#4c566a", textFaint: "#727e94",
    accent: "#5e81ac",
    red: "#a5474f", green: "#5c7a45", yellow: "#8e6c1f",
    blue: "#5e81ac", purple: "#8a5f82", cyan: "#457375", orange: "#ad5f3b",
    syntax: {
      keyword: "#5e81ac", string: "#5c7a45", number: "#8a5f82",
      comment: "#727e94", func: "#4c6f92", type: "#457375", punct: "#2e3440",
    },
    avatars: ["#5e81ac", "#5c7a45", "#ad5f3b", "#8a5f82", "#a5474f", "#457375", "#8e6c1f", "#4c6f92"],
    tags: ["cool", "muted", "soft"],
  },
  {
    id: "poimandres",
    name: "Poimandres",
    author: "pmndrs",
    appearance: "dark",
    bg: "#1b1e28", bgRaised: "#171922", bgOverlay: "#252b37",
    bgHover: "#232733", bgActive: "#303340", border: "#2c3040",
    text: "#a6accd", textDim: "#949ac0", textFaint: "#7d84a8",
    accent: "#5de4c7",
    red: "#ff757f", green: "#5de4c7", yellow: "#fffac2",
    blue: "#add7ff", purple: "#d0679d", cyan: "#89ddff", orange: "#f5a191",
    syntax: {
      keyword: "#91b4d5", string: "#5de4c7", number: "#fffac2",
      comment: "#7d84a8", func: "#add7ff", type: "#5fb3a1", punct: "#a6accd",
    },
    avatars: ["#5de4c7", "#add7ff", "#f5a191", "#d0679d", "#ff757f", "#89ddff", "#fffac2", "#91b4d5"],
    tags: ["cool", "muted", "vibrant"],
  },
  {
    id: "zenburn",
    name: "Zenburn",
    author: "Jani Nurminen",
    appearance: "dark",
    bg: "#3f3f3f", bgRaised: "#353535", bgOverlay: "#4a4a4a",
    bgHover: "#484848", bgActive: "#565650", border: "#585858",
    text: "#dcdccc", textDim: "#bdbdaa", textFaint: "#a0a094",
    accent: "#8cd0d3",
    red: "#dca3a3", green: "#afd8af", yellow: "#f0dfaf",
    blue: "#8cd0d3", purple: "#dc8cc3", cyan: "#93e0e3", orange: "#dfaf8f",
    syntax: {
      keyword: "#f0dfaf", string: "#cc9393", number: "#8cd0d3",
      comment: "#9fa88f", func: "#efef8f", type: "#dfdfbf", punct: "#dcdccc",
    },
    avatars: ["#8cd0d3", "#afd8af", "#dfaf8f", "#dc8cc3", "#dca3a3", "#93e0e3", "#f0dfaf", "#bca3a3"],
    tags: ["warm", "muted", "classic", "soft"],
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    author: "Catppuccin",
    appearance: "dark",
    bg: "#303446", bgRaised: "#292c3c", bgOverlay: "#414559",
    bgHover: "#414559", bgActive: "#51576d", border: "#51576d",
    text: "#c6d0f5", textDim: "#a5adce", textFaint: "#838ba7",
    accent: "#8caaee",
    red: "#e78284", green: "#a6d189", yellow: "#e5c890",
    blue: "#8caaee", purple: "#ca9ee6", cyan: "#81c8be", orange: "#ef9f76",
    syntax: {
      keyword: "#ca9ee6", string: "#a6d189", number: "#ef9f76",
      comment: "#838ba7", func: "#8caaee", type: "#e5c890", punct: "#81c8be",
    },
    avatars: ["#8caaee", "#a6d189", "#ef9f76", "#ca9ee6", "#e78284", "#81c8be", "#e5c890", "#f4b8e4"],
    tags: ["cool", "pastel", "soft"],
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    author: "Catppuccin",
    appearance: "dark",
    bg: "#24273a", bgRaised: "#1e2030", bgOverlay: "#363a4f",
    bgHover: "#363a4f", bgActive: "#494d64", border: "#494d64",
    text: "#cad3f5", textDim: "#a5adcb", textFaint: "#8087a2",
    accent: "#8aadf4",
    red: "#ed8796", green: "#a6da95", yellow: "#eed49f",
    blue: "#8aadf4", purple: "#c6a0f6", cyan: "#8bd5ca", orange: "#f5a97f",
    syntax: {
      keyword: "#c6a0f6", string: "#a6da95", number: "#f5a97f",
      comment: "#8087a2", func: "#8aadf4", type: "#eed49f", punct: "#8bd5ca",
    },
    avatars: ["#8aadf4", "#a6da95", "#f5a97f", "#c6a0f6", "#ed8796", "#8bd5ca", "#eed49f", "#f5bde6"],
    tags: ["cool", "pastel"],
  },
  {
    id: "monokai-classic",
    name: "Monokai Classic",
    author: "Wimer Hazenberg",
    appearance: "dark",
    bg: "#272822", bgRaised: "#1e1f1c", bgOverlay: "#33342c",
    bgHover: "#3e3d32", bgActive: "#49483e", border: "#4a493e",
    text: "#f8f8f2", textDim: "#cfcec4", textFaint: "#93917c",
    accent: "#a6e22e",
    red: "#f92672", green: "#a6e22e", yellow: "#e6db74",
    blue: "#66d9ef", purple: "#ae81ff", cyan: "#66d9ef", orange: "#fd971f",
    syntax: {
      keyword: "#f92672", string: "#e6db74", number: "#ae81ff",
      comment: "#93917c", func: "#a6e22e", type: "#66d9ef", punct: "#f8f8f2",
    },
    avatars: ["#a6e22e", "#66d9ef", "#fd971f", "#ae81ff", "#f92672", "#e6db74", "#8ac8d6", "#d94f8f"],
    tags: ["vibrant", "classic", "high-contrast"],
  },
  {
    id: "one-light",
    name: "One Light",
    author: "Atom",
    appearance: "light",
    bg: "#fafafa", bgRaised: "#f2f2f2", bgOverlay: "#ffffff",
    bgHover: "#ededed", bgActive: "#e5e5e6", border: "#d7d7d9",
    text: "#383a42", textDim: "#696c77", textFaint: "#8b8d94",
    accent: "#4078f2",
    red: "#d33d33", green: "#3f8b3e", yellow: "#986801",
    blue: "#4078f2", purple: "#a626a4", cyan: "#0184bc", orange: "#b45c00",
    syntax: {
      keyword: "#a626a4", string: "#3f8b3e", number: "#986801",
      comment: "#8b8d94", func: "#4078f2", type: "#0184bc", punct: "#383a42",
    },
    avatars: ["#4078f2", "#3f8b3e", "#b45c00", "#a626a4", "#d33d33", "#0184bc", "#986801", "#b3418f"],
    tags: ["neutral", "classic", "soft"],
  },
];

/** Ids that ship with the app — imported themes may never shadow one. */
const BUILTIN_IDS = new Set(THEMES.map((t) => t.id));

export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export const THEME_BY_ID: Record<string, ThemeSpec> = Object.fromEntries(
  THEMES.map((t) => [t.id, t])
);

export const DEFAULT_DARK = "spaces-midnight";
export const DEFAULT_LIGHT = "spaces-daylight";

/** Canonical vocabulary, in the order a filter row should render it. */
export const THEME_TAGS: readonly string[] = [
  "warm", "cool", "neutral", "vibrant", "muted", "pastel",
  "high-contrast", "soft", "classic", "earthy", "retro", "minimal",
];

/**
 * Tags actually present, with counts, canonical order first and anything a
 * custom theme invented appended alphabetically. Empty tags are dropped.
 */
export function themeTags(themes: ThemeSpec[] = THEMES): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of themes) {
    for (const raw of t.tags ?? []) {
      const tag = String(raw).trim().toLowerCase();
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const order = (tag: string) => {
    const i = THEME_TAGS.indexOf(tag);
    return i < 0 ? THEME_TAGS.length : i;
  };
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => order(a.tag) - order(b.tag) || a.tag.localeCompare(b.tag));
}

/* ── appearance overrides ──────────────────────────────────── */

/** Every user-tunable knob that sits on top of a palette. */
export interface AppearanceOverrides {
  /** '' = the theme's own accent, else a hex that replaces it everywhere */
  accent?: string;
  density?: Density;
  radius?: RadiusScale;
  /** multiplies the whole --fs-* ladder */
  fontScale?: number;
  /** '' = default stack, a MONO_STACKS id, or a literal font-family list */
  mono?: string;
  reduceMotion?: boolean;
  /** 0..1 — how much accent bleeds into the canvas */
  bgTint?: number;
}

export interface MonoStack {
  id: string;
  label: string;
  stack: string;
}

const DEFAULT_MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

/**
 * Only system-installable families — the app ships no webfonts, so every
 * stack has to degrade to something the OS already has.
 */
export const MONO_STACKS: MonoStack[] = [
  { id: "", label: "Default", stack: DEFAULT_MONO },
  { id: "sf", label: "SF Mono", stack: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  { id: "fira", label: "Fira Code", stack: '"Fira Code", "Fira Mono", ui-monospace, Menlo, monospace' },
  { id: "ibm", label: "IBM Plex Mono", stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace' },
  { id: "source", label: "Source Code Pro", stack: '"Source Code Pro", ui-monospace, Menlo, monospace' },
  { id: "iosevka", label: "Iosevka", stack: 'Iosevka, "Iosevka Term", ui-monospace, Menlo, monospace' },
  { id: "menlo", label: "Menlo / Consolas", stack: 'Menlo, Consolas, "DejaVu Sans Mono", monospace' },
];

const MONO_BY_ID: Record<string, MonoStack> = Object.fromEntries(MONO_STACKS.map((m) => [m.id, m]));

/** id → stack; an unknown single family name is used as-is with fallbacks. */
export function monoStack(id: string | undefined): string {
  const v = (id ?? "").trim();
  if (!v) return DEFAULT_MONO;
  if (MONO_BY_ID[v]) return MONO_BY_ID[v].stack;
  if (v.includes(",")) return v; // caller passed a full font-family list
  const quoted = /\s/.test(v) && !v.startsWith('"') ? `"${v}"` : v;
  return `${quoted}, ui-monospace, Menlo, monospace`;
}

/** Base type ladder, in px — must mirror :root in App.css at fontScale 1. */
/**
 * Type.
 *
 * The whole ladder moved up about a point, and the gaps between the rungs
 * opened. 13.5px body with 12.5px secondary and 11.5px meta is three sizes
 * inside one point of each other — a scale that fine reads as one flat grey
 * size at a glance, which is a large part of why the app felt like a form.
 * 14.5 / 13 / 12 with a 16px card title and a 21px section heading gives each
 * rung somewhere to be.
 */
const FONT_SIZES: [string, number][] = [
  ["--fs-micro", 11], ["--fs-xs", 12], ["--fs-sm", 13],
  ["--fs", 14.5], ["--fs-md", 16], ["--fs-lg", 21],
  // Display. One size above the ladder, for the name of the surface you are
  // on — the only piece of type in the app allowed to be a headline.
  ["--fs-xl", 28],
];

/**
 * Shape.
 *
 * The default rung moved up hard — 6/9/12/16 to 10/15/22/30 — and it is the
 * single biggest lever on how the whole app feels, because nearly every box in
 * it resolves through one of these four. At 9px a card is a rectangle with the
 * corners taken off; at 15px it is an object. The app is a place you keep your
 * work in rather than a form you fill in, and the shape should say so before
 * any of the type does.
 *
 * `sharp` moved up with it rather than staying where it was: it is the option
 * for someone who wants less of this, not a different design language, and the
 * gap between 2px and 10px was large enough to be exactly that.
 */
const RADIUS_SCALES: Record<RadiusScale, [number, number, number, number]> = {
  sharp: [4, 6, 9, 12],
  default: [10, 15, 22, 30],
  round: [14, 22, 30, 999],
};

/**
 * Space, and the height of a one-line row.
 *
 * Every step went up. `cozy` — the default, and what most people will ever
 * see — went from a 30px row on a 3/6/9/13/18/26 ladder to a 36px row on
 * 4/8/12/17/24/34, which is what `comfortable` used to be. Density was tuned
 * for fitting thirty rows on a laptop screen, and that is a real thing to want,
 * but it is what `compact` is for. The default should be the one that feels
 * good, not the one that fits most.
 *
 * The knock-on is deliberate and large: --row-h is the app's hit-area floor,
 * so every button, nav row, chip and list row grows with it.
 */
const DENSITY_SCALES: Record<Density, { space: number[]; row: number }> = {
  compact: { space: [3, 5, 8, 12, 16, 24], row: 30 },
  cozy: { space: [4, 8, 12, 17, 24, 34], row: 36 },
  comfortable: { space: [5, 10, 15, 21, 30, 42], row: 42 },
};

export const DENSITIES: { id: Density; label: string; help: string }[] = [
  { id: "compact", label: "Compact", help: "More on screen, tighter rows" },
  { id: "cozy", label: "Cozy", help: "The default rhythm" },
  { id: "comfortable", label: "Comfortable", help: "Roomier padding and taller rows" },
];

export const RADIUS_SCALE_OPTIONS: { id: RadiusScale; label: string }[] = [
  { id: "sharp", label: "Sharp" },
  { id: "default", label: "Default" },
  { id: "round", label: "Round" },
];

export const FONT_SCALE_RANGE = { min: 0.9, max: 1.2, step: 0.05 } as const;

/** Background tokens the canvas tint is allowed to touch (all plain hex). */
const TINT_TARGETS = [
  "--bg", "--bg-raised", "--bg-overlay", "--surface-1", "--surface-2",
  "--bg-hover", "--bg-active", "--bg-input", "--bg-inset", "--code-bg",
];

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function px(n: number): string {
  return `${Math.round(n * 10) / 10}px`;
}

/* ── token derivation ──────────────────────────────────────── */

/**
 * Every CSS variable the app consumes, derived from the palette and the
 * user's appearance overrides. Components only ever reference these — never a
 * theme's raw fields. Shape/type/spacing tokens are emitted unconditionally
 * (at their App.css values when nothing is overridden) so one pass owns them.
 */
export function cssVarsFor(t: ThemeSpec, o?: AppearanceOverrides): Record<string, string> {
  const dark = t.appearance === "dark";

  /* Every shadow in the app is two lights, never one.
     A single blur is the tell of a generated interface: it puts the whole
     penumbra at one distance, so a card either floats with no contact or sits
     with no ambience. Real depth needs a tight, dark *contact* shadow directly
     under the element and a wide, faint *ambient* one spreading past it — and
     the ratio between them is what the eye reads as height, more than either
     layer's opacity. Authored here rather than per component so the three
     levels stay in proportion to each other. */
  const shadowColor = dark ? "0, 0, 0" : "16, 24, 40";
  const sh = (layers: [y: number, blur: number, a: number][]) =>
    layers
      .map(([y, blur, a]) => `0 ${y}px ${blur}px rgba(${shadowColor}, ${a})`)
      .join(", ");

  // A bad override must never take the app down with it.
  const accent = normalizeHex(o?.accent) || t.accent;
  const density = DENSITY_SCALES[o?.density as Density] ? (o!.density as Density) : "cozy";
  const radius = RADIUS_SCALES[o?.radius as RadiusScale] ? (o!.radius as RadiusScale) : "default";
  const fontScale = clamp(Number(o?.fontScale) || 1, FONT_SCALE_RANGE.min, FONT_SCALE_RANGE.max);
  const tint = clamp(Number(o?.bgTint) || 0, 0, 1);
  const motion = o?.reduceMotion ? 0 : 1;

  const vars: Record<string, string> = {
    /* ── Canvas and paper ────────────────────────────────────
       A dark theme lifts by getting lighter. A light theme lifts by getting
       *whiter* — which only works if the canvas has somewhere to lift from,
       and most light palettes leave it none: they are authored for an editor,
       where the canvas IS the paper and nothing sits above it, so bg is
       #ffffff and anything painted on it can only go darker.

       Drawn that way the whole app read as recessed. On GitHub Light the
       kanban columns, the cards inside them, the sidebar and the popovers all
       resolved to #f6f8fa on white, separated by one hairline and a shadow at
       6% that no display renders.

       So on light the ladder shifts down a rung. The canvas takes a measured
       amount of the theme's own border colour — its darkest neutral, so the
       tint stays in the palette's family and Solarized stays warm where Latte
       stays cool — and paper goes back to near-white. Nothing is recoloured;
       the same neutrals are re-assigned one step lower, and the elevation the
       app has always described in its comments finally has room to exist. */
    /* Level 0 — the window itself, behind everything.

       The shell floats the content pane as a panel with the rail sitting on
       the bare window beside it, so there has to be a rung BELOW the canvas
       for both of them to sit on. It is the deepest neutral either appearance
       has: on dark, the theme's background taken most of the way to black; on
       light, taken half way to the palette's own border colour, which keeps
       the tint in family the same way the canvas does. The traffic lights land
       here rather than on a surface, which is the point of the whole layout —
       macOS chrome should sit on the window, not on the page. */
    "--app-bg": dark ? mix(t.bg, "#000000", 0.5) : mix(t.bg, t.border, 0.6),
    /* The window is lit, not painted. A flat fill behind a floating panel is a
       colour; a very slight gradient is a room the panel is standing in — and
       it is what gives the translucent chrome inside the panel something worth
       sampling. Two stops, both derived: the lift carries a trace of the accent
       so the light has the theme's own colour temperature rather than a generic
       cool cast, and it is small enough (6–9%) to stay a light source rather
       than becoming a decorative wash. */
    "--app-bg-lift": dark
      ? mix(mix(t.bg, "#000000", 0.5), accent, 0.09)
      : mix(mix(t.bg, t.border, 0.6), accent, 0.06),
    "--bg": dark ? t.bg : mix(t.bg, t.border, 0.2),
    /* One step recessed from the canvas — and no longer the navigation rail,
       which gave this up when it became bare window. What it means now is "a
       column inside the panel that is not the panel": the documents and mail
       lists, the knowledge sources rail, the chat tool strip, the setup spine,
       a sticky footer. Every palette already authors it away from the editor
       background; on light it goes one step further so it cannot resolve to
       the same value as the canvas.

       Distinct from --bg-inset, which is a *well* — code, terminals, fields.
       A column is recessed; a well is cut into the surface. */
    "--bg-raised": dark ? t.bgRaised : mix(t.bgRaised, t.border, 0.3),
    "--bg-overlay": dark ? t.bgOverlay : mix(t.bgOverlay, "#ffffff", 0.5),

    /* Level 1 — paper resting on the canvas: dashboard card, kanban column.
       Level 2 — a fill *inside* level 1. On dark it steps further from the
       canvas; on light it steps back toward it, because on paper a nested
       panel reads as recessed rather than raised and going whiter than white
       is not available. Both are one visible step, in the direction that
       reads as "inside this". */
    "--surface-1": dark ? mix(t.bg, "#ffffff", 0.05) : mix(t.bg, "#ffffff", 0.62),
    "--surface-2": dark ? mix(t.bg, "#ffffff", 0.09) : mix(t.bg, t.border, 0.1),
    "--edge-highlight": dark ? "rgba(255, 255, 255, 0.055)" : "rgba(255, 255, 255, 0.8)",
    "--bg-hover": t.bgHover,
    "--bg-active": t.bgActive,
    "--bg-input": dark ? mix(t.bg, "#000000", 0.22) : mix(t.bg, "#ffffff", 0.75),
    "--bg-inset": dark ? mix(t.bg, "#000000", 0.35) : mix(t.bgRaised, t.border, 0.3),
    "--border": t.border,
    /* Softened toward the canvas rather than toward the palette's bg: on light
       those are now different values, and a hairline drawn on paper has to be
       mixed against what it is actually sitting on or it disappears. */
    "--border-soft": mix(t.border, dark ? t.bg : mix(t.bg, t.border, 0.2), dark ? 0.55 : 0.4),
    "--border-strong": mix(t.border, t.text, 0.25),

    "--text": t.text,
    "--text-dim": t.textDim,
    "--text-faint": t.textFaint,

    "--accent": accent,
    "--accent-fg": readableOn(accent),
    /* The primary button's hover used to be `filter: brightness(1.08)`, which
       is only ever right on one appearance: a light theme's accent is dark and
       saturated, so brightening it washes the fill out toward its own tint
       instead of deepening it. Hover moves *toward the light source* on dark
       and *away from it* on light; active goes one step further either way, so
       a press always reads as pressed rather than as a second hover. */
    "--accent-hover": dark ? mix(accent, "#ffffff", 0.14) : mix(accent, "#000000", 0.12),
    "--accent-active": dark ? mix(accent, "#ffffff", 0.04) : mix(accent, "#000000", 0.22),
    "--accent-soft": alpha(accent, dark ? 0.16 : 0.12),
    "--accent-soft-strong": alpha(accent, dark ? 0.28 : 0.2),
    "--accent-border": alpha(accent, 0.45),
    "--accent-glow": alpha(accent, dark ? 0.35 : 0.25),
    /* The halo behind the keyboard ring. Weak enough to stay a hint of the
       accent rather than a second ring, and the only reason the focus
       treatment survives being drawn on top of an accent fill. */
    "--focus-halo": alpha(accent, dark ? 0.24 : 0.18),

    "--red": t.red,
    "--green": t.green,
    "--yellow": t.yellow,
    "--blue": t.blue,
    "--purple": t.purple,
    "--cyan": t.cyan,
    "--orange": t.orange,
    "--red-soft": alpha(t.red, dark ? 0.14 : 0.1),
    "--green-soft": alpha(t.green, dark ? 0.14 : 0.1),
    "--yellow-soft": alpha(t.yellow, dark ? 0.14 : 0.1),
    "--red-border": alpha(t.red, 0.4),
    "--green-border": alpha(t.green, 0.4),
    "--yellow-border": alpha(t.yellow, 0.4),

    "--syn-keyword": t.syntax.keyword,
    "--syn-string": t.syntax.string,
    "--syn-number": t.syntax.number,
    "--syn-comment": t.syntax.comment,
    "--syn-func": t.syntax.func,
    "--syn-type": t.syntax.type,
    "--syn-punct": t.syntax.punct,

    "--code-bg": dark ? mix(t.bg, "#000000", 0.3) : mix(t.bgRaised, t.border, 0.18),
    "--code-border": mix(t.border, t.bg, 0.4),
    "--inline-code-bg": dark ? alpha(t.text, 0.08) : alpha(t.text, 0.06),

    "--diff-add-bg": alpha(t.green, dark ? 0.13 : 0.16),
    "--diff-del-bg": alpha(t.red, dark ? 0.13 : 0.14),
    "--diff-add-fg": t.green,
    "--diff-del-fg": t.red,

    /* Glass is NOT derived here. components/glass.css owns the whole material
       — tint, blur, the contrast/brightness band and the light-theme inversion
       of it — and derives all of it from the tokens above with color-mix.
       There used to be a second, older set of glass variables in this object,
       and because applyTheme writes these as INLINE style on <html> they beat
       every :root rule in that file: the light-appearance tuning and the
       non-retina blur reduction were both silently dead. One owner, and the
       one that can respond to a media query. */

    "--backdrop": dark ? "rgba(0, 0, 0, 0.62)" : "rgba(16, 24, 40, 0.35)",
    /* A scrollbar is chrome for a surface, not an element of it: quiet at rest
       so a long list is a list rather than a list with a bar down the side,
       and unmistakable the moment the pointer is near it. */
    "--scrollbar": alpha(t.textFaint, dark ? 0.28 : 0.32),
    "--scrollbar-hover": alpha(t.textFaint, dark ? 0.62 : 0.66),

    /* Contact layer + ambient layer at each level. The contact stays tight and
       relatively opaque; the ambient widens and softens roughly 3x per step,
       which is what separates "resting on the page" from "held above it". */
    "--shadow-sm": sh(dark
      ? [[1, 2, 0.24], [2, 6, 0.2]]
      : [[1, 1.5, 0.05], [2, 6, 0.06]]),
    "--shadow-md": sh(dark
      ? [[2, 4, 0.26], [10, 28, 0.36]]
      : [[2, 4, 0.05], [10, 28, 0.1]]),
    "--shadow-lg": sh(dark
      ? [[4, 8, 0.3], [28, 68, 0.5]]
      : [[6, 12, 0.07], [28, 68, 0.16]]),

    // Avatar colors are pastel on dark themes and saturated on light ones, so
    // the theme background is the readable foreground in both cases.
    "--avatar-fg": t.bg,
    "--avatar-0": t.avatars[0], "--avatar-1": t.avatars[1],
    "--avatar-2": t.avatars[2], "--avatar-3": t.avatars[3],
    "--avatar-4": t.avatars[4], "--avatar-5": t.avatars[5],
    "--avatar-6": t.avatars[6], "--avatar-7": t.avatars[7],
  };

  // Shape.
  const [rSm, r, rMd, rLg] = RADIUS_SCALES[radius];
  vars["--radius-sm"] = px(rSm);
  vars["--radius"] = px(r);
  vars["--radius-md"] = px(rMd);
  vars["--radius-lg"] = px(rLg);

  // Motion. Zeroing the durations is enough: every transition in the app is
  // authored as `... var(--dur) var(--ease)`.
  vars["--dur-fast"] = `${120 * motion}ms`;
  vars["--dur"] = `${200 * motion}ms`;

  // Type.
  for (const [name, size] of FONT_SIZES) vars[name] = px(size * fontScale);
  vars["--mono"] = monoStack(o?.mono);
  // Nav labels have to survive a 1.2x body size, so the rail grows with it —
  // but at a fraction of the rate, or the sidebar eats the content pane.
  vars["--sidebar-w"] = px(252 * (1 + (fontScale - 1) * 0.55));

  // Spacing.
  const d = DENSITY_SCALES[density];
  d.space.forEach((v, i) => { vars[`--space-${i + 1}`] = px(v); });
  vars["--row-h"] = px(d.row * (1 + (fontScale - 1) * 0.7));

  // Canvas tint, applied last so it catches every derived background. Capped
  // low: this is a wash, not a recolor, and --text was contrast-checked
  // against the untinted canvas.
  if (tint > 0) {
    const amount = tint * (dark ? 0.1 : 0.075);
    for (const key of TINT_TARGETS) {
      const v = vars[key];
      if (v && v.startsWith("#")) vars[key] = mix(v, accent, amount);
    }
  }

  return vars;
}

/* ── persistence + application ─────────────────────────────── */

export interface ThemePrefs {
  darkTheme: string;
  lightTheme: string;
  followSystem: boolean;
  /** used when followSystem is false */
  appearance: Appearance;
  /** '' = use the theme's accent */
  accent: string;
  density: Density;
  radius: RadiusScale;
  /** 0.9 .. 1.2 */
  fontScale: number;
  /** '' = default mono stack, or a MONO_STACKS id */
  mono: string;
  reduceMotion: boolean;
  /** 0..1 */
  bgTint: number;
}

export const DEFAULT_PREFS: ThemePrefs = {
  darkTheme: DEFAULT_DARK,
  lightTheme: DEFAULT_LIGHT,
  followSystem: false,
  appearance: "dark",
  accent: "",
  density: "cozy",
  radius: "default",
  fontScale: 1,
  mono: "",
  reduceMotion: false,
  bgTint: 0,
};

/** The subset `resetAppearance` restores — theme choices are left alone. */
export const APPEARANCE_DEFAULTS: Required<AppearanceOverrides> = {
  accent: "", density: "cozy", radius: "default",
  fontScale: 1, mono: "", reduceMotion: false, bgTint: 0,
};

const STORAGE_KEY = "spaces.theme";
const CUSTOM_KEY = "spaces.theme.custom";

/**
 * Coerce anything at all into usable prefs. Older stored shapes are missing
 * most of these keys, and a hand-edited localStorage entry can hold garbage;
 * both must land on the defaults rather than throw.
 */
export function normalizePrefs(raw: unknown): ThemePrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

  const darkId = str(r.darkTheme, DEFAULT_DARK);
  const lightId = str(r.lightTheme, DEFAULT_LIGHT);
  const dark = THEME_BY_ID[darkId];
  const light = THEME_BY_ID[lightId];

  return {
    darkTheme: dark && dark.appearance === "dark" ? darkId : DEFAULT_DARK,
    lightTheme: light && light.appearance === "light" ? lightId : DEFAULT_LIGHT,
    followSystem: r.followSystem === true,
    appearance: r.appearance === "light" ? "light" : "dark",
    accent: normalizeHex(r.accent),
    density: DENSITY_SCALES[r.density as Density] ? (r.density as Density) : "cozy",
    radius: RADIUS_SCALES[r.radius as RadiusScale] ? (r.radius as RadiusScale) : "default",
    fontScale: Number.isFinite(r.fontScale)
      ? clamp(r.fontScale as number, FONT_SCALE_RANGE.min, FONT_SCALE_RANGE.max)
      : 1,
    mono: str(r.mono, ""),
    reduceMotion: r.reduceMotion === true,
    bgTint: Number.isFinite(r.bgTint) ? clamp(r.bgTint as number, 0, 1) : 0,
  };
}

export function loadPrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: ThemePrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // private mode / quota — theme just won't persist
  }
}

export function systemAppearance(): Appearance {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** True when the OS itself asks for reduced motion — CSS already honours it. */
export function systemReduceMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function activeTheme(p: ThemePrefs): ThemeSpec {
  const appearance = p.followSystem ? systemAppearance() : p.appearance;
  return THEME_BY_ID[appearance === "light" ? p.lightTheme : p.darkTheme] ?? THEMES[0];
}

export function applyTheme(t: ThemeSpec, p?: AppearanceOverrides) {
  const root = document.documentElement;
  const vars = cssVarsFor(t, p);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.setAttribute("data-theme", t.id);
  root.setAttribute("data-appearance", t.appearance);
  // Spacing that CSS can key off directly, e.g. `[data-density="compact"] .x`.
  root.setAttribute("data-density", (p?.density ?? "cozy") as string);
  root.setAttribute("data-radius", (p?.radius ?? "default") as string);
  if (p?.reduceMotion) root.setAttribute("data-reduce-motion", "");
  else root.removeAttribute("data-reduce-motion");
  // native form controls, scrollbars and the window chrome follow this
  root.style.colorScheme = t.appearance;
}

/* ── custom themes: import / export / registry ─────────────── */

function slugId(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** Stable key order so a re-export of an unchanged theme diffs cleanly. */
export function exportTheme(t: ThemeSpec): string {
  return JSON.stringify(
    {
      id: t.id, name: t.name, author: t.author, appearance: t.appearance,
      bg: t.bg, bgRaised: t.bgRaised, bgOverlay: t.bgOverlay,
      bgHover: t.bgHover, bgActive: t.bgActive, border: t.border,
      text: t.text, textDim: t.textDim, textFaint: t.textFaint,
      accent: t.accent,
      red: t.red, green: t.green, yellow: t.yellow,
      blue: t.blue, purple: t.purple, cyan: t.cyan, orange: t.orange,
      syntax: { ...t.syntax },
      avatars: [...t.avatars],
      tags: [...(t.tags ?? [])],
    },
    null,
    2
  );
}

/**
 * Parse a theme from JSON (or a plain object). `name`, `bg`, `text` and
 * `accent` are the only hard requirements — everything else is derived from
 * them or borrowed from the default theme of the matching appearance, so a
 * four-line hand-written theme still imports. Returns null on bad input.
 */
export function importTheme(json: unknown): ThemeSpec | null {
  let raw: unknown = json;
  if (typeof raw === "string") {
    if (raw.length > 200_000) return null;
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;

  const name = typeof r.name === "string" ? r.name.trim().slice(0, 60) : "";
  const bg = normalizeHex(r.bg);
  const text = normalizeHex(r.text);
  const accent = normalizeHex(r.accent);
  if (!name || !bg || !text || !accent) return null;

  const appearance: Appearance =
    r.appearance === "dark" || r.appearance === "light"
      ? r.appearance
      : luminance(bg) < 0.4 ? "dark" : "light";
  const dark = appearance === "dark";
  const base = THEME_BY_ID[dark ? DEFAULT_DARK : DEFAULT_LIGHT] ?? THEMES[0];

  const hex = (v: unknown, fallback: string) => normalizeHex(v) || fallback;
  const syn = (r.syntax && typeof r.syntax === "object" ? r.syntax : {}) as Record<string, unknown>;

  const avatars: string[] = Array.isArray(r.avatars)
    ? r.avatars.map(normalizeHex).filter(Boolean)
    : [];
  // The token set is fixed at 8 slots; cycle what we were given, then borrow.
  const ramp = Array.from({ length: 8 }, (_, i) =>
    avatars.length ? avatars[i % avatars.length] : base.avatars[i]
  );

  const tags = Array.isArray(r.tags)
    ? [...new Set(
        r.tags
          .filter((x: unknown) => typeof x === "string")
          .map((x: string) => x.trim().toLowerCase())
          .filter(Boolean)
      )].slice(0, 8)
    : [];

  const id = slugId(typeof r.id === "string" && r.id.trim() ? r.id : name) || "custom-theme";

  return {
    id,
    name,
    author: typeof r.author === "string" && r.author.trim() ? r.author.trim().slice(0, 60) : "Custom",
    appearance,
    bg,
    bgRaised: hex(r.bgRaised, mix(bg, "#000000", dark ? 0.35 : 0.03)),
    bgOverlay: hex(r.bgOverlay, dark ? mix(bg, "#ffffff", 0.06) : "#ffffff"),
    bgHover: hex(r.bgHover, mix(bg, text, 0.07)),
    bgActive: hex(r.bgActive, mix(bg, text, 0.14)),
    border: hex(r.border, mix(bg, text, 0.2)),
    text,
    textDim: hex(r.textDim, mix(text, bg, 0.3)),
    textFaint: hex(r.textFaint, mix(text, bg, 0.5)),
    accent,
    red: hex(r.red, base.red),
    green: hex(r.green, base.green),
    yellow: hex(r.yellow, base.yellow),
    blue: hex(r.blue, base.blue),
    purple: hex(r.purple, base.purple),
    cyan: hex(r.cyan, base.cyan),
    orange: hex(r.orange, base.orange),
    syntax: {
      keyword: hex(syn.keyword, base.syntax.keyword),
      string: hex(syn.string, base.syntax.string),
      number: hex(syn.number, base.syntax.number),
      comment: hex(syn.comment, mix(text, bg, 0.45)),
      func: hex(syn.func, accent),
      type: hex(syn.type, base.syntax.type),
      punct: hex(syn.punct, mix(text, bg, 0.15)),
    },
    avatars: ramp,
    tags,
  };
}

/**
 * Make a theme selectable app-wide. Built-in ids are never overwritten — a
 * collision gets suffixed instead — so an import can't silently redefine
 * "dracula" for everyone.
 */
export function registerTheme(spec: ThemeSpec): ThemeSpec | null {
  const t = importTheme(spec);
  if (!t) return null;
  if (BUILTIN_IDS.has(t.id)) t.id = `${t.id}-custom`;
  const i = THEMES.findIndex((x) => x.id === t.id);
  if (i >= 0) THEMES[i] = t;
  else THEMES.push(t);
  THEME_BY_ID[t.id] = t;
  return t;
}

export function unregisterTheme(id: string): void {
  if (BUILTIN_IDS.has(id)) return;
  const i = THEMES.findIndex((x) => x.id === id);
  if (i >= 0) THEMES.splice(i, 1);
  delete THEME_BY_ID[id];
}

export function saveCustomTheme(t: ThemeSpec | null): void {
  try {
    if (t) localStorage.setItem(CUSTOM_KEY, exportTheme(t));
    else localStorage.removeItem(CUSTOM_KEY);
  } catch {
    // private mode / quota — the theme just won't survive a restart
  }
}

/**
 * Restore the saved custom theme AND register it. Callers must run this
 * before `loadPrefs`, or a saved selection pointing at the custom theme gets
 * reset to the default as an unknown id.
 */
export function loadCustomTheme(): ThemeSpec | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return null;
    const spec = importTheme(raw);
    return spec ? registerTheme(spec) : null;
  } catch {
    return null;
  }
}

/** Avatar/identity color for a stable id, from the active theme's palette. */
export function avatarColor(id: string, t: ThemeSpec): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return t.avatars[h % t.avatars.length];
}
