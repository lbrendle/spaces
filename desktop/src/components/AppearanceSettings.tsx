/**
 * The appearance panel: mode, the theme gallery, and the override knobs that
 * sit on top of whichever palette is chosen.
 *
 * Two things here are load-bearing and non-obvious:
 *  1. A card's miniature is painted by spreading `cssVarsFor(spec)` as inline
 *     style, so the preview runs the *real* derivation pass. A hand-picked
 *     swatch row would drift from what the app actually renders the moment
 *     themes.ts changes how a token is derived.
 *  2. Hovering or focusing a card applies that theme to <html> for real and
 *     reverts on the way out. Choosing between forty palettes by squinting at
 *     200px cards is hopeless; seeing the whole app wearing one is instant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useTheme } from "../themeStore";
import {
  THEMES, THEME_BY_ID, cssVarsFor, applyTheme, exportTheme, themeTags,
  contrastRatio, isHex, isBuiltinTheme, systemReduceMotion,
  DENSITIES, RADIUS_SCALE_OPTIONS, FONT_SCALE_RANGE, MONO_STACKS, APPEARANCE_DEFAULTS,
  type Appearance, type AppearanceOverrides, type Density, type RadiusScale, type ThemeSpec,
} from "../themes";
import { confirmAction, errorText, toast } from "../toast";
import "./appearance.css";

type Mode = Appearance | "system";

const MODES: { id: Mode; label: string; icon: string; help: string }[] = [
  { id: "dark", label: "Dark", icon: "◑", help: "Always use your dark theme" },
  { id: "light", label: "Light", icon: "○", help: "Always use your light theme" },
  { id: "system", label: "System", icon: "◫", help: "Follow the OS appearance" },
];

/** The knobs `resetAppearance` restores, in the order the panel presents them. */
const OVERRIDE_KEYS = [
  "accent", "density", "radius", "fontScale", "mono", "reduceMotion", "bgTint",
] as const;

const OVERRIDE_LABEL: Record<(typeof OVERRIDE_KEYS)[number], string> = {
  accent: "accent", density: "density", radius: "corners", fontScale: "text size",
  mono: "font", reduceMotion: "motion", bgTint: "tint",
};

const TINT_ON = 0.5;

/** Tags read out in a card's accessible name before it turns into a mouthful. */
const LABEL_TAGS = 4;

function matches(t: ThemeSpec, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = `${t.name} ${t.author} ${t.id} ${(t.tags ?? []).join(" ")}`.toLowerCase();
  return tokens.every((tok) => hay.includes(tok));
}

/**
 * Why `importTheme` would reject this text. It only ever answers null, and
 * "that didn't work" is a useless thing to tell someone holding a 60-line
 * JSON blob, so the same contract is re-checked here for the message.
 */
function importProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return "Paste a theme JSON object first.";
  if (text.length > 200_000) return "Too large to be a theme — the limit is 200 KB.";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `Not valid JSON — ${errorText(e)}`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return 'Expected a JSON object, like { "name": "My theme", "bg": "#12141c", … }.';
  }

  const r = parsed as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof r.name !== "string" || !r.name.trim()) missing.push("name");
  for (const key of ["bg", "text", "accent"] as const) {
    if (r[key] === undefined || r[key] === "") missing.push(key);
    else if (!isHex(r[key])) {
      return `"${key}" must be a hex color such as "#1e1e2e" — got ${JSON.stringify(r[key])}.`;
    }
  }
  if (missing.length) {
    return `Missing required ${missing.length > 1 ? "fields" : "field"}: ${missing.join(", ")}. ` +
      "Everything else is optional and gets derived.";
  }
  return "";
}

export function AppearanceSettings() {
  const {
    prefs, theme, customTheme,
    setTheme, setFollowSystem, setAppearance,
    setAccent, setDensity, setRadius, setFontScale, setMono,
    setReduceMotion, setBgTint, resetAppearance,
    importCustomTheme, clearCustomTheme,
  } = useTheme();

  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [peekId, setPeekId] = useState("");
  const [cursorId, setCursorId] = useState("");
  const [draft, setDraft] = useState("");
  const [importError, setImportError] = useState("");
  // The OS switch is authoritative for CSS either way; knowing about it just
  // lets the toggle explain why motion is already flat.
  const [osReduced] = useState(systemReduceMotion);

  const mode: Mode = prefs.followSystem ? "system" : prefs.appearance;
  const peekSpec = peekId ? THEME_BY_ID[peekId] ?? null : null;

  /* ── live whole-app preview ───────────────────────────────── */

  useEffect(() => {
    applyTheme(peekSpec ?? theme, prefs);
  }, [peekSpec, theme, prefs]);

  // Navigating away with the pointer still over a card would otherwise strand
  // the app in the peeked theme — nothing else writes those vars back.
  useEffect(() => () => {
    const s = useTheme.getState();
    applyTheme(s.theme, s.prefs);
  }, []);

  // Guarded so the card the pointer just *left* cannot cancel the peek the
  // card it just entered has already started. '' forces a clear.
  const peekOn = useCallback((id: string) => setPeekId(id), []);
  const peekOff = useCallback((id: string) => setPeekId((cur) => (!id || cur === id ? "" : cur)), []);

  /* ── gallery filtering ────────────────────────────────────── */

  // THEMES is mutated in place by registerTheme, so memos need a signal that
  // the array itself moved.
  const themeSig = `${THEMES.length}:${customTheme?.id ?? ""}`;
  const tokens = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  );

  const searched = useMemo(
    () => THEMES.filter((t) => matches(t, tokens)),
    [tokens, themeSig]
  );

  const results = useMemo(
    () => searched.filter((t) => tags.every((tag) => (t.tags ?? []).includes(tag))),
    [searched, tags]
  );

  // Facet counts answer "what would happen if I clicked this", so a chip that
  // leads to an empty gallery can be shown as the dead end it is.
  const facets = useMemo(() => {
    return themeTags(THEMES).map(({ tag }) => {
      const others = tags.filter((x) => x !== tag);
      const count = searched.filter(
        (t) => (t.tags ?? []).includes(tag) && others.every((x) => (t.tags ?? []).includes(x))
      ).length;
      return { tag, count, on: tags.includes(tag) };
    });
  }, [searched, tags, themeSig]);

  const groups = useMemo(() => {
    const order: Appearance[] = theme.appearance === "light" ? ["light", "dark"] : ["dark", "light"];
    return order
      .map((appearance) => ({
        appearance,
        label: appearance === "dark" ? "Dark" : "Light",
        items: results.filter((t) => t.appearance === appearance),
      }))
      .filter((g) => g.items.length > 0);
  }, [results, theme.appearance]);

  /* ── overrides ────────────────────────────────────────────── */

  // Density and font scale are deliberately absent: the miniature is drawn at
  // fixed px so neither changes it, and leaving them out keeps every card's
  // vars memo alive while the type slider is being dragged.
  const cardOverrides = useMemo<AppearanceOverrides>(
    () => ({ accent: prefs.accent, radius: prefs.radius, bgTint: prefs.bgTint }),
    [prefs.accent, prefs.radius, prefs.bgTint]
  );

  const accent = prefs.accent || theme.accent;
  const swatches = useMemo(() => {
    const seen = new Set<string>();
    const out: { hex: string; label: string }[] = [];
    const push = (hex: string, label: string) => {
      const h = hex.toLowerCase();
      if (isHex(h) && !seen.has(h)) {
        seen.add(h);
        out.push({ hex: h, label });
      }
    };
    push(theme.accent, `${theme.name} default`);
    push(theme.blue, "Blue");
    push(theme.purple, "Purple");
    push(theme.cyan, "Cyan");
    push(theme.green, "Green");
    push(theme.yellow, "Yellow");
    push(theme.orange, "Orange");
    push(theme.red, "Red");
    theme.avatars.forEach((hex, i) => push(hex, `Palette ${i + 1}`));
    return out.slice(0, 10);
  }, [theme]);

  const ratio = contrastRatio(accent, theme.bg);
  const changed = OVERRIDE_KEYS.filter((k) => prefs[k] !== APPEARANCE_DEFAULTS[k]);

  /* ── actions ──────────────────────────────────────────────── */

  const copyTheme = async () => {
    const json = exportTheme(theme);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard access in this window");
      await navigator.clipboard.writeText(json);
      toast.success(`Copied “${theme.name}”`, "The theme JSON is on your clipboard.");
    } catch (e) {
      setDraft(json);
      setImportError("");
      toast.warn("Could not reach the clipboard", `${errorText(e)} — the JSON is in the box below instead.`);
    }
  };

  const runImport = () => {
    const problem = importProblem(draft);
    if (problem) {
      setImportError(problem);
      return;
    }
    const spec = importCustomTheme(draft);
    if (!spec) {
      setImportError("Spaces could not build a theme from that — check the color values.");
      return;
    }
    setImportError("");
    setDraft("");
    setQuery("");
    setTags([]);
    toast.success(`Imported “${spec.name}”`, "It is selected now and lives in the gallery.");
  };

  const removeCustom = async () => {
    if (!customTheme) return;
    const ok = await confirmAction({
      title: `Remove “${customTheme.name}”?`,
      body: "The imported theme is deleted from Spaces. Re-import the JSON to get it back.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setPeekId("");
    clearCustomTheme();
    toast.success("Custom theme removed");
  };

  const reset = async () => {
    const ok = await confirmAction({
      title: "Reset appearance?",
      body: "Accent, density, radius, text size, font, motion and tint all go back to their defaults. Your dark and light theme picks are kept.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    resetAppearance();
    toast.success("Appearance reset");
  };

  const clearFilters = () => {
    setQuery("");
    setTags([]);
  };

  return (
    <>
      <section className="dash-card ap-card">
        <h3>Appearance</h3>
        <div className="ap-row">
          <div className="ap-copy">
            <div className="ap-label">Mode</div>
            <div className="ap-hint">
              Dark and light each remember their own theme, so flipping between
              them keeps the look you picked for each.
            </div>
          </div>
          <Segmented
            label="Appearance mode"
            value={mode}
            options={MODES}
            onPick={(m) => (m === "system" ? setFollowSystem(true) : setAppearance(m))}
          />
        </div>
      </section>

      <section className="dash-card ap-card">
        <h3>
          Theme
          <span className="ap-count">
            {results.length === THEMES.length ? THEMES.length : `${results.length} of ${THEMES.length}`}
          </span>
          <span className={"ap-now" + (peekSpec ? " peeking" : "")} aria-hidden="true">
            {peekSpec ? `Previewing ${peekSpec.name} — click to keep` : theme.name}
          </span>
        </h3>

        <div className="ap-hint ap-gallery-hint">
          Hover a theme to wear it for a moment; the app snaps back when you leave.
        </div>

        <div className="ap-filters">
          <div className="ap-search">
            <span className="ap-search-icon" aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              placeholder="Search name or author…"
              aria-label="Search themes"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
            />
            {query && (
              <button type="button" className="ap-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                ✕
              </button>
            )}
          </div>

          <div className="ap-tags" role="group" aria-label="Filter themes by tag">
            {facets.map(({ tag, count, on }) => (
              <button
                key={tag}
                type="button"
                className={"ap-tag" + (on ? " on" : "")}
                aria-pressed={on}
                disabled={!on && count === 0}
                onClick={() => setTags((cur) => (on ? cur.filter((x) => x !== tag) : [...cur, tag]))}
              >
                {tag}
                <span className="ap-tag-count">{count}</span>
              </button>
            ))}
            {(tags.length > 0 || query) && (
              <button type="button" className="ap-tag ap-tag-clear" onClick={clearFilters}>
                Clear
              </button>
            )}
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="ap-empty">
            <div className="ap-empty-title">No theme matches those filters</div>
            <button type="button" className="btn" onClick={clearFilters}>Clear filters</button>
          </div>
        ) : (
          groups.map((g) => (
            <ThemeGroup
              key={g.appearance}
              title={g.label}
              themes={g.items}
              activeId={theme.id}
              cursorId={cursorId}
              customId={customTheme?.id ?? ""}
              overrides={cardOverrides}
              onCursor={setCursorId}
              onPick={setTheme}
              onPeekOn={peekOn}
              onPeekOff={peekOff}
            />
          ))
        )}
      </section>

      <section className="dash-card ap-card">
        <h3>
          Fine tuning
          {changed.length > 0 && <span className="ap-count">{changed.length} changed</span>}
        </h3>

        <div className="ap-tune">
          <div className="ap-tune-controls">
            <div className="ap-row">
              <div className="ap-copy">
                <div className="ap-label">Accent</div>
                <div className="ap-hint">
                  Buttons, links, selection and focus rings. Pick from this theme’s
                  own palette or bring your own.
                </div>
              </div>
              <div className="ap-accent">
                <div className="ap-swatches" role="radiogroup" aria-label="Accent color">
                  {swatches.map((s) => {
                    const on = accent.toLowerCase() === s.hex;
                    return (
                      <button
                        key={s.hex}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={`${s.label} (${s.hex})`}
                        title={`${s.label} · ${s.hex}`}
                        className={"ap-swatch" + (on ? " on" : "")}
                        style={{ "--sw": s.hex } as CSSProperties}
                        // Picking the theme's own accent clears the override
                        // rather than pinning it — otherwise the next theme
                        // would inherit this one's blue.
                        onClick={() => setAccent(s.hex === theme.accent.toLowerCase() ? "" : s.hex)}
                      />
                    );
                  })}
                  <label className="ap-swatch ap-swatch-custom" title="Custom accent">
                    <span aria-hidden="true">+</span>
                    <input
                      type="color"
                      value={accent}
                      aria-label="Custom accent color"
                      onChange={(e) => setAccent(e.target.value)}
                    />
                  </label>
                </div>
                <div className="ap-accent-foot">
                  <code className="ap-mono-chip">{accent}</code>
                  <span className={"ap-ratio" + (ratio < 3 ? " weak" : "")}>
                    {ratio.toFixed(1)}:1 on the canvas
                  </span>
                  <button
                    type="button"
                    className="btn tiny"
                    disabled={!prefs.accent}
                    onClick={() => setAccent("")}
                  >
                    Use theme default
                  </button>
                </div>
              </div>
            </div>

            <div className="ap-row">
              <div className="ap-copy">
                <div className="ap-label">Density</div>
                <div className="ap-hint">
                  {DENSITIES.find((d) => d.id === prefs.density)?.help}
                </div>
              </div>
              <Segmented
                label="Density"
                value={prefs.density}
                options={DENSITIES.map((d) => ({ id: d.id, label: d.label, help: d.help }))}
                onPick={(d: Density) => setDensity(d)}
              />
            </div>

            <div className="ap-row">
              <div className="ap-copy">
                <div className="ap-label">Corners</div>
                <div className="ap-hint">How rounded cards, inputs and buttons are.</div>
              </div>
              <Segmented
                label="Corner radius"
                value={prefs.radius}
                options={RADIUS_SCALE_OPTIONS}
                onPick={(r: RadiusScale) => setRadius(r)}
              />
            </div>

            <div className="ap-row">
              <div className="ap-copy">
                <div className="ap-label">Text size</div>
                <div className="ap-hint">Scales the whole type ladder, and the sidebar with it.</div>
              </div>
              <div className="ap-slider">
                <span className="ap-slider-end" aria-hidden="true">A</span>
                <input
                  type="range"
                  min={FONT_SCALE_RANGE.min}
                  max={FONT_SCALE_RANGE.max}
                  step={FONT_SCALE_RANGE.step}
                  value={prefs.fontScale}
                  aria-label="Text size"
                  aria-valuetext={`${Math.round(prefs.fontScale * 100)} percent`}
                  onChange={(e) => setFontScale(Number(e.target.value))}
                />
                <span className="ap-slider-end big" aria-hidden="true">A</span>
                <output className="ap-slider-value">{Math.round(prefs.fontScale * 100)}%</output>
              </div>
            </div>

            <div className="ap-row">
              <div className="ap-copy">
                <div className="ap-label">Monospace font</div>
                <div className="ap-hint">
                  Code blocks, diffs and terminal output. Anything not installed
                  falls back to the system default.
                </div>
              </div>
              <select
                className="ap-select"
                value={prefs.mono}
                aria-label="Monospace font"
                onChange={(e) => setMono(e.target.value)}
              >
                {MONO_STACKS.map((m) => (
                  <option key={m.id || "default"} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div className="ap-toggles">
              <Toggle
                checked={prefs.reduceMotion}
                onChange={setReduceMotion}
                title="Reduce motion"
                hint={osReduced
                  ? "Your system already asks for this; Spaces honours it either way."
                  : "Removes transitions and animated thumbs across the app."}
              />
              <Toggle
                checked={prefs.bgTint > 0}
                onChange={(on) => setBgTint(on ? TINT_ON : 0)}
                title="Tint the background"
                hint="Washes a little accent into every surface."
              >
                {prefs.bgTint > 0 && (
                  <input
                    type="range"
                    className="ap-tint-range"
                    min={0.15}
                    max={1}
                    step={0.05}
                    value={prefs.bgTint}
                    aria-label="Background tint strength"
                    aria-valuetext={`${Math.round(prefs.bgTint * 100)} percent`}
                    onChange={(e) => setBgTint(Number(e.target.value))}
                  />
                )}
              </Toggle>
            </div>
          </div>

          <div className="ap-sample" aria-hidden="true">
            <div className="ap-sample-head">Live sample</div>
            <div className="ap-sample-row on">
              <span className="ap-sample-hash">#</span>
              <span className="ap-sample-name">general</span>
              <span className="ap-sample-badge">3</span>
            </div>
            <div className="ap-sample-row">
              <span className="ap-sample-hash">#</span>
              <span className="ap-sample-name">releases</span>
            </div>
            <div className="ap-sample-card">
              <div className="ap-sample-title">Ship the appearance panel</div>
              <div className="ap-sample-text">
                Density sets the rhythm, corners set the shape, text size sets the ladder.
              </div>
              <div className="ap-sample-foot">
                <span className="ap-sample-chip">in review</span>
                <span className="ap-sample-btn">Run</span>
              </div>
            </div>
            <code className="ap-sample-code">
              <span className="tk-kw">await</span>{" "}
              <span className="tk-ty">agent</span>
              <span className="tk-pn">.</span>
              <span className="tk-fn">run</span>
              <span className="tk-pn">(</span>
              <span className="tk-str">"hq"</span>
              <span className="tk-pn">)</span>
            </code>
          </div>
        </div>

        <div className="ap-actions">
          <button type="button" className="btn danger" disabled={changed.length === 0} onClick={reset}>
            Reset appearance
          </button>
          <span className="ap-hint">
            {changed.length === 0
              ? "Everything here is at its default."
              : `${changed.length} override${changed.length > 1 ? "s" : ""}: ${changed.map((k) => OVERRIDE_LABEL[k]).join(", ")}.`}
          </span>
        </div>
      </section>

      <section className="dash-card ap-card">
        <h3>Share a theme</h3>
        <div className="ap-hint">
          A theme is plain JSON. Only <code className="ap-mono-chip">name</code>,{" "}
          <code className="ap-mono-chip">bg</code>, <code className="ap-mono-chip">text</code> and{" "}
          <code className="ap-mono-chip">accent</code> are required — the rest is derived from them.
        </div>

        <div className="ap-io">
          <div className="ap-io-side">
            <button type="button" className="btn" onClick={copyTheme}>
              Export “{theme.name}”
            </button>
            <div className="ap-hint">
              Copies the active theme{isBuiltinTheme(theme.id) ? " (a built-in)" : ""} to your clipboard.
            </div>
            {customTheme && (
              <div className="ap-custom">
                <span className="ap-custom-dot" aria-hidden="true" />
                <span className="ap-custom-name">{customTheme.name}</span>
                <span className="ap-custom-tag">imported</span>
                <button type="button" className="btn tiny danger" onClick={removeCustom}>Remove</button>
              </div>
            )}
          </div>

          <div className="ap-io-side grow">
            <label className="ap-label" htmlFor="ap-import">Import theme</label>
            <textarea
              id="ap-import"
              className={"ap-import" + (importError ? " bad" : "")}
              rows={5}
              spellCheck={false}
              value={draft}
              placeholder={'{ "name": "Midnight Fig", "bg": "#141019", "text": "#efe7f5", "accent": "#c98bff" }'}
              aria-describedby={importError ? "ap-import-error" : undefined}
              aria-invalid={!!importError}
              onChange={(e) => {
                setDraft(e.target.value);
                if (importError) setImportError("");
              }}
            />
            {importError && (
              <div className="ap-error" id="ap-import-error" role="alert">{importError}</div>
            )}
            <div className="ap-io-actions">
              <button type="button" className="btn primary" disabled={!draft.trim()} onClick={runImport}>
                Import
              </button>
              <button
                type="button"
                className="btn"
                disabled={!draft}
                onClick={() => { setDraft(""); setImportError(""); }}
              >
                Clear
              </button>
              <span className="ap-hint">Spaces keeps one imported theme at a time.</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ── theme gallery ───────────────────────────────────────────── */

function ThemeGroup({
  title, themes, activeId, cursorId, customId, overrides,
  onCursor, onPick, onPeekOn, onPeekOff,
}: {
  title: string;
  themes: ThemeSpec[];
  activeId: string;
  cursorId: string;
  customId: string;
  overrides: AppearanceOverrides;
  onCursor: (id: string) => void;
  onPick: (id: string) => void;
  onPeekOn: (id: string) => void;
  onPeekOff: (id: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  // Roving tabindex: the group takes one Tab stop, arrows move inside it. The
  // cursor lives one level up so it survives a theme moving between groups.
  const tabbableId =
    themes.some((t) => t.id === cursorId) ? cursorId
      : themes.some((t) => t.id === activeId) ? activeId
        : themes[0]?.id ?? "";

  const focusAt = (index: number) => {
    const next = themes[index];
    const el = gridRef.current?.children[index];
    if (!next || !(el instanceof HTMLElement)) return;
    onCursor(next.id);
    el.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    // The grid is auto-fill, so only the layout knows how wide a row is.
    const cols = gridRef.current
      ? Math.max(1, getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").filter(Boolean).length)
      : 1;
    const last = themes.length - 1;
    let next = index;

    switch (e.key) {
      case "ArrowRight": next = Math.min(last, index + 1); break;
      case "ArrowLeft": next = Math.max(0, index - 1); break;
      case "ArrowDown": next = Math.min(last, index + cols); break;
      case "ArrowUp": next = Math.max(0, index - cols); break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      case "Enter":
      case " ":
        e.preventDefault();
        onPick(themes[index].id);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next !== index) focusAt(next);
  };

  return (
    <div className="ap-group">
      <div className="ap-group-head">
        <span className="ap-group-title">{title}</span>
        <span className="ap-group-count">{themes.length}</span>
        <span className="ap-group-rule" />
      </div>
      <div
        className="ap-grid"
        role="radiogroup"
        aria-label={`${title} themes`}
        ref={gridRef}
        onMouseLeave={() => onPeekOff("")}
      >
        {themes.map((spec, i) => (
          <ThemeCard
            key={spec.id}
            spec={spec}
            overrides={overrides}
            active={spec.id === activeId}
            tabbable={spec.id === tabbableId}
            custom={spec.id === customId}
            onPick={() => onPick(spec.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onPeekOn={() => onPeekOn(spec.id)}
            onPeekOff={() => onPeekOff(spec.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ThemeCard({
  spec, overrides, active, tabbable, custom,
  onPick, onKeyDown, onPeekOn, onPeekOff,
}: {
  spec: ThemeSpec;
  overrides: AppearanceOverrides;
  active: boolean;
  tabbable: boolean;
  custom: boolean;
  onPick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPeekOn: () => void;
  onPeekOff: () => void;
}) {
  // The whole miniature resolves its tokens against these, not the app's — the
  // same derivation the real UI gets, including the user's own overrides so
  // the card predicts what picking it actually looks like.
  const vars = useMemo(() => cssVarsFor(spec, overrides) as CSSProperties, [spec, overrides]);
  const shown = (spec.tags ?? []).slice(0, LABEL_TAGS);

  return (
    <div
      className={"ap-theme" + (active ? " active" : "")}
      role="radio"
      aria-checked={active}
      aria-label={`${spec.name} by ${spec.author}${shown.length ? `, ${shown.join(", ")}` : ""}`}
      tabIndex={tabbable ? 0 : -1}
      onClick={onPick}
      onKeyDown={onKeyDown}
      onMouseEnter={onPeekOn}
      onMouseLeave={onPeekOff}
      onFocus={onPeekOn}
      onBlur={onPeekOff}
    >
      <div className="ap-mini" style={vars} aria-hidden="true">
        <div className="ap-mini-rail">
          <span className="ap-mini-logo" />
          <span className="ap-mini-nav on"><i /><b /></span>
          <span className="ap-mini-nav"><i /><b /></span>
          <span className="ap-mini-nav"><i /><b /></span>
        </div>

        <div className="ap-mini-body">
          <div className="ap-mini-top">
            <span className="ap-mini-crumb">#general</span>
            <span className="ap-mini-chip">2 running</span>
          </div>

          <div className="ap-mini-msg">
            <span className="ap-mini-av">A</span>
            <div className="ap-mini-bubble">
              <span className="ap-mini-who">atlas</span>
              <span className="ap-mini-said">pushed the diff, tests are green</span>
            </div>
          </div>

          <div className="ap-mini-code">
            <span className="ap-mini-c">{"// " + spec.name}</span>
            <span className="ap-mini-src">
              <span className="ap-mini-k">const </span>
              <span className="ap-mini-f">ship</span>
              <span className="ap-mini-p"> = </span>
              <span className="ap-mini-s">"hq"</span>
              <span className="ap-mini-caret" />
            </span>
          </div>

          <div className="ap-mini-foot">
            <span className="ap-mini-btn">Run</span>
            <span className="ap-mini-tag">review</span>
            <span className="ap-mini-dots">
              <i style={{ background: "var(--red)" }} />
              <i style={{ background: "var(--yellow)" }} />
              <i style={{ background: "var(--green)" }} />
            </span>
          </div>
        </div>
      </div>

      <div className="ap-theme-meta">
        <div className="ap-theme-id">
          <div className="ap-theme-name">
            {spec.name}
            {custom && <span className="ap-theme-badge">imported</span>}
          </div>
          <div className="ap-theme-author">{spec.author}</div>
        </div>
        <span className="ap-theme-check" aria-hidden="true">✓</span>
      </div>
    </div>
  );
}

/* ── small controls ──────────────────────────────────────────── */

function Segmented<T extends string>({
  label, value, options, onPick,
}: {
  label: string;
  value: T;
  // `help` is for the caller's own hint copy — never a title attribute here,
  // which would shadow the visible label as the button's accessible name.
  options: { id: T; label: string; icon?: string; help?: string }[];
  onPick: (id: T) => void;
}) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onPick(options[next].id);
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[next]?.focus();
  };

  return (
    <div
      className="ap-seg"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ "--seg": index, "--seg-n": options.length } as CSSProperties}
    >
      <span className="ap-seg-thumb" aria-hidden="true" />
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={"ap-seg-btn" + (on ? " active" : "")}
            onClick={() => onPick(o.id)}
          >
            {o.icon && <span className="ap-seg-icon" aria-hidden="true">{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  checked, onChange, title, hint, children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className={"ap-toggle" + (checked ? " on" : "")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className="ap-toggle-btn"
        onClick={() => onChange(!checked)}
      >
        <span className="ap-track" aria-hidden="true"><span className="ap-knob" /></span>
        <span className="ap-toggle-copy">
          <span className="ap-label">{title}</span>
          <span className="ap-hint">{hint}</span>
        </span>
      </button>
      {children}
    </div>
  );
}
