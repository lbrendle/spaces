import { create } from "zustand";
import {
  applyTheme, activeTheme, loadPrefs, savePrefs, systemAppearance,
  loadCustomTheme, saveCustomTheme, registerTheme, unregisterTheme, importTheme,
  normalizeHex, isBuiltinTheme,
  APPEARANCE_DEFAULTS, DEFAULT_DARK, DEFAULT_LIGHT, FONT_SCALE_RANGE,
  THEME_BY_ID, avatarColor,
  type Appearance, type Density, type RadiusScale,
  type ThemePrefs, type ThemeSpec,
} from "./themes";

interface ThemeState {
  prefs: ThemePrefs;
  theme: ThemeSpec;
  /** The one imported theme a user may keep alongside the built-ins. */
  customTheme: ThemeSpec | null;

  /** Pick a theme; also becomes the remembered choice for its appearance. */
  setTheme(id: string): void;
  setFollowSystem(on: boolean): void;
  setAppearance(a: Appearance): void;
  /** Flip dark <-> light using each side's remembered theme. */
  toggleAppearance(): void;

  /** '' clears the override and falls back to the theme's own accent. */
  setAccent(hex: string): void;
  setDensity(d: Density): void;
  setRadius(r: RadiusScale): void;
  setFontScale(n: number): void;
  /** A MONO_STACKS id, a literal font-family list, or '' for the default. */
  setMono(id: string): void;
  setReduceMotion(on: boolean): void;
  setBgTint(n: number): void;
  /** Restore every override; the chosen themes are kept. */
  resetAppearance(): void;

  /** Parse + register + select. Returns null (and changes nothing) on bad JSON. */
  importCustomTheme(json: string): ThemeSpec | null;
  /** Register a spec built in the UI; null removes the custom slot. */
  setCustomTheme(spec: ThemeSpec | null): ThemeSpec | null;
  clearCustomTheme(): void;

  init(): void;
}

function commit(prefs: ThemePrefs, customTheme?: ThemeSpec | null) {
  savePrefs(prefs);
  const theme = activeTheme(prefs);
  applyTheme(theme, prefs);
  return customTheme === undefined ? { prefs, theme } : { prefs, theme, customTheme };
}

// The custom theme has to be registered before prefs load, or a saved
// selection pointing at it looks like a dangling id and gets reset.
const initialCustom = loadCustomTheme();
const initialPrefs = loadPrefs();

export const useTheme = create<ThemeState>((set, get) => ({
  prefs: initialPrefs,
  theme: activeTheme(initialPrefs),
  customTheme: initialCustom,

  setTheme(id) {
    const t = THEME_BY_ID[id];
    if (!t) return;
    const prefs: ThemePrefs = {
      ...get().prefs,
      [t.appearance === "light" ? "lightTheme" : "darkTheme"]: id,
      // choosing a theme explicitly means you want to see it now
      followSystem: false,
      appearance: t.appearance,
    };
    set(commit(prefs));
  },

  setFollowSystem(on) {
    set(commit({ ...get().prefs, followSystem: on, appearance: on ? systemAppearance() : get().prefs.appearance }));
  },

  setAppearance(a) {
    set(commit({ ...get().prefs, followSystem: false, appearance: a }));
  },

  toggleAppearance() {
    get().setAppearance(get().theme.appearance === "dark" ? "light" : "dark");
  },

  setAccent(hex) {
    set(commit({ ...get().prefs, accent: normalizeHex(hex) }));
  },

  setDensity(density) {
    set(commit({ ...get().prefs, density }));
  },

  setRadius(radius) {
    set(commit({ ...get().prefs, radius }));
  },

  setFontScale(n) {
    const fontScale = Math.min(FONT_SCALE_RANGE.max, Math.max(FONT_SCALE_RANGE.min, Number(n) || 1));
    set(commit({ ...get().prefs, fontScale }));
  },

  setMono(mono) {
    set(commit({ ...get().prefs, mono: typeof mono === "string" ? mono : "" }));
  },

  setReduceMotion(reduceMotion) {
    set(commit({ ...get().prefs, reduceMotion }));
  },

  setBgTint(n) {
    const bgTint = Math.min(1, Math.max(0, Number(n) || 0));
    set(commit({ ...get().prefs, bgTint }));
  },

  resetAppearance() {
    set(commit({ ...get().prefs, ...APPEARANCE_DEFAULTS }));
  },

  importCustomTheme(json) {
    const parsed = importTheme(json);
    if (!parsed) return null;
    return get().setCustomTheme(parsed);
  },

  setCustomTheme(spec) {
    if (!spec) {
      get().clearCustomTheme();
      return null;
    }
    const previous = get().customTheme;
    const t = registerTheme(spec);
    if (!t) return null;
    saveCustomTheme(t);

    // One slot only: a second import replaces the first unless it reused the
    // id, and the replaced id must not stay behind in the other slot.
    let base = get().prefs;
    if (previous && previous.id !== t.id) {
      unregisterTheme(previous.id);
      base = {
        ...base,
        darkTheme: base.darkTheme === previous.id ? DEFAULT_DARK : base.darkTheme,
        lightTheme: base.lightTheme === previous.id ? DEFAULT_LIGHT : base.lightTheme,
      };
    }

    const prefs: ThemePrefs = {
      ...base,
      [t.appearance === "light" ? "lightTheme" : "darkTheme"]: t.id,
      followSystem: false,
      appearance: t.appearance,
    };
    set(commit(prefs, t));
    return t;
  },

  clearCustomTheme() {
    const { customTheme, prefs } = get();
    if (!customTheme) return;
    unregisterTheme(customTheme.id);
    saveCustomTheme(null);
    // Anything still pointing at the removed theme falls back to a built-in.
    const next: ThemePrefs = {
      ...prefs,
      darkTheme: isBuiltinTheme(prefs.darkTheme) ? prefs.darkTheme : DEFAULT_DARK,
      lightTheme: isBuiltinTheme(prefs.lightTheme) ? prefs.lightTheme : DEFAULT_LIGHT,
    };
    set(commit(next, null));
  },

  init() {
    applyTheme(get().theme, get().prefs);
    if (typeof matchMedia === "function") {
      matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        const { prefs } = get();
        if (prefs.followSystem) set(commit({ ...prefs, appearance: systemAppearance() }));
      });
    }
  },
}));

/** Theme-aware identity color — re-renders when the theme changes. */
export function useAvatarColor(id: string): string {
  const theme = useTheme((s) => s.theme);
  return avatarColor(id, theme);
}

// Apply immediately at module load so there is no unstyled flash.
applyTheme(activeTheme(initialPrefs), initialPrefs);
