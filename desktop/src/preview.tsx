/**
 * Design harness — NOT part of the shipped app.
 *
 * Renders the real stylesheets against markup that mirrors the components'
 * DOM, with no Tauri/SQLite dependency, so the visual design can be reviewed
 * and iterated on in a plain browser across every theme.
 *
 * Served at /preview.html by `npm run dev`.
 */
import ReactDOM from "react-dom/client";
import { useState } from "react";
import { THEMES, applyTheme, cssVarsFor, type ThemeSpec } from "./themes";
import {
  IconDashboard, IconTasks, IconBranch, IconMemory, IconAgents, IconSettings,
  IconHash, IconPlus, IconLogo, IconMoon, IconBolt, IconGear,
} from "./components/icons";
import "./App.css";
import "./components/chat.css";
import "./components/board.css";
import "./components/workspaces.css";
import "./components/palette.css";

const CODE = [
  { t: "async function ", c: "tk-kw" },
  { t: "resolveTargets", c: "tk-fn" },
  { t: "(", c: "tk-pn" },
  { t: "channelId", c: "" },
  { t: ": ", c: "tk-pn" },
  { t: "string", c: "tk-ty" },
  { t: ") {\n  ", c: "tk-pn" },
  { t: "// only channel members can be mentioned\n  ", c: "tk-com" },
  { t: "const", c: "tk-kw" },
  { t: " members = ", c: "" },
  { t: "await", c: "tk-kw" },
  { t: " load(", c: "tk-pn" },
  { t: '"agents"', c: "tk-str" },
  { t: ", ", c: "tk-pn" },
  { t: "25", c: "tk-num" },
  { t: ");\n}", c: "tk-pn" },
];

function Bar({ theme, onPick }: { theme: ThemeSpec; onPick: (t: ThemeSpec) => void }) {
  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 500,
      display: "flex", gap: 6, padding: "8px 12px", overflowX: "auto",
      background: "var(--bg-overlay)", borderTop: "1px solid var(--border)",
    }}>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => onPick(t)}
          className={"chip select-chip" + (t.id === theme.id ? " active" : "")}
          style={{ flexShrink: 0 }}
        >{t.name}</button>
      ))}
    </div>
  );
}

/* Preview-only styles, namespaced so they cannot collide with settings.css. */
const PV_CSS = `
.pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.pv-mini {
  display: flex; height: 96px; border-radius: var(--radius); overflow: hidden;
  border: 1px solid var(--border); background: var(--bg);
}
.pv-side { width: 26%; background: var(--bg-raised); border-right: 1px solid var(--border-soft); }
.pv-main { flex: 1; padding: 7px 8px; display: flex; flex-direction: column; gap: 4px; }
.pv-bar { height: 5px; width: 46%; border-radius: 3px; background: var(--text-faint); }
.pv-code { font-family: var(--mono); font-size: 8.5px; line-height: 1.3; }
.pv-btn { margin-top: auto; height: 9px; width: 34%; border-radius: 3px; background: var(--accent); }
.pv-name { font-size: 11.5px; color: var(--text-dim); margin-top: 5px; }
`;

function MiniPreview({ t }: { t: ThemeSpec }) {
  return (
    <div>
      <div className="pv-mini" style={cssVarsFor(t) as React.CSSProperties}>
        <div className="pv-side" />
        <div className="pv-main">
          <div className="pv-bar" />
          <div className="pv-code">
            <span style={{ color: "var(--syn-keyword)" }}>const</span>{" "}
            <span style={{ color: "var(--syn-func)" }}>run</span>
            <span style={{ color: "var(--syn-punct)" }}>()</span>
          </div>
          <div className="pv-code" style={{ color: "var(--syn-string)" }}>"ship it"</div>
          <div className="pv-code" style={{ color: "var(--syn-comment)" }}>// hq</div>
          <div className="pv-btn" />
        </div>
      </div>
      <div className="pv-name">{t.name}</div>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<ThemeSpec>(THEMES[0]);
  const pick = (t: ThemeSpec) => { applyTheme(t); setTheme(t); };
  if (!document.documentElement.dataset.theme) applyTheme(theme);

  return (
    <div className="app" style={{ paddingBottom: 46 }}>
      <style>{PV_CSS}</style>
      {/* ── sidebar ─────────────────────────────────────────── */}
      <div className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark"><IconLogo size={19} /></span> Spaces
          <span className="brand-hint">⌘K</span>
          <button className="icon-btn appearance-toggle"><IconMoon /></button>
        </div>
        <div className="nav-section">
          <div className="nav-item"><span className="nav-icon"><IconDashboard /></span> Dashboard</div>
          <div className="nav-item active"><span className="nav-icon"><IconTasks /></span> Tasks</div>
          <div className="nav-item"><span className="nav-icon"><IconBranch /></span> Workspaces</div>
          <div className="nav-item"><span className="nav-icon"><IconMemory /></span> Memory</div>
          <div className="nav-item"><span className="nav-icon"><IconAgents /></span> Agents &amp; Teams</div>
          <div className="nav-item"><span className="nav-icon"><IconSettings /></span> Settings</div>
        </div>
        <div className="nav-section grow">
          <div className="nav-heading">Projects <button className="icon-btn"><IconPlus size={13} /></button></div>
          <div className="project-group">
            <div className="project-name"><span>Sample project</span><button className="icon-btn"><IconPlus size={13} /></button></div>
            <div className="nav-item channel active"><IconHash size={13} className="hash" /> general<span className="agent-count"><IconAgents size={12} />3</span></div>
            <div className="nav-item channel has-unread"><IconHash size={13} className="hash" /> frontend<span className="unread-badge">4</span></div>
            <div className="nav-item channel"><IconHash size={13} className="hash" /> infra<span className="run-pulse" /></div>
          </div>
          <div className="project-group">
            <div className="project-name"><span>Spaces</span><button className="icon-btn"><IconPlus size={13} /></button></div>
            <div className="nav-item channel"><IconHash size={13} className="hash" /> general<span className="agent-count"><IconAgents size={12} />2</span></div>
          </div>
        </div>
      </div>

      {/* ── chat ────────────────────────────────────────────── */}
      <div className="main-pane chat" style={{ maxWidth: 720 }}>
        <div className="pane-header">
          <div>
            <div className="pane-title"><span className="hash">#</span>frontend</div>
            <div className="pane-sub">
              <button className="chip project-chip">Sample project</button>
              <span className="chip repo-chip">⌥ spaces-ai/spaces-main</span>
              <span className="topic">UI work &amp; design system</span>
            </div>
          </div>
          <div className="row">
            <button className="btn">⚉ 3 agents</button>
            <button className="btn"><IconGear /></button>
          </div>
        </div>

        <div className="chat-body">
          <div className="chat-main">
            <div className="messages">
              <div className="day-divider"><span>Today</span></div>

              <div className="msg">
                <div className="msg-head">
                  <div className="avatar" style={{ background: "var(--avatar-2)" }}>L</div>
                  <span className="msg-author">Rowan</span>
                  <span className="msg-time">09:24</span>
                </div>
                <div className="msg-body">
                  <div className="md">
                    <div>
                      <span className="mention">@scout</span> can you audit the mention
                      resolver? Something's off with <code>@all</code> in threads.
                    </div>
                  </div>
                </div>
              </div>

              <div className="msg">
                <div className="msg-head">
                  <div className="avatar" style={{ background: "var(--avatar-0)" }}>S</div>
                  <span className="msg-author" style={{ color: "var(--avatar-0)" }}>Scout</span>
                  <span className="bot-tag">AGENT</span>
                  <span className="msg-time">09:24</span>
                </div>
                <div className="msg-body">
                  <div className="md">
                    <div>Found it — <code>resolveTargets</code> excluded the chain author before
                      expanding <code>@all</code>, so thread replies dropped everyone:</div>
                    <div className="md-gap" />
                    <pre className="codeblock">
                      <div className="codelang">typescript</div>
                      <code>{CODE.map((s, i) => <span key={i} className={s.c}>{s.t}</span>)}</code>
                    </pre>
                    <div className="md-gap" />
                    <div>Fixed in <code>src/agents.ts:361</code>. Want me to open a PR?</div>
                  </div>
                  <div className="msg-meta">4 turns · $0.031 · 12s</div>
                </div>
              </div>

              <div className="msg">
                <div className="msg-head">
                  <div className="avatar" style={{ background: "var(--avatar-5)" }}>N</div>
                  <span className="msg-author" style={{ color: "var(--avatar-5)" }}>Nova</span>
                  <span className="bot-tag">AGENT</span>
                  <span className="msg-time">09:25</span>
                </div>
                <div className="msg-body">
                  <div className="running-note"><span className="spinner" /> ⚙︎ using Edit…</div>
                </div>
              </div>
            </div>

            <div className="composer-wrap">
              <div className="composer">
                <textarea rows={1} placeholder="Message #frontend — @mention an agent or @all" />
                <button className="btn primary">Send</button>
              </div>
              <div className="composer-hint">Messages here go to <span className="mention">@scout</span> automatically.</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── board + cards ───────────────────────────────────── */}
      <div className="main-pane scroll-pane" style={{ borderLeft: "1px solid var(--border-soft)" }}>
        <div className="pane-header">
          <div>
            <div className="pane-title">Tasks</div>
            <div className="pane-sub">
              <button className="chip select-chip active">Sample project</button>
              <button className="chip select-chip">Spaces</button>
              <span className="board-summary">7 open · 12 done</span>
            </div>
          </div>
          <button className="btn">⊞ Group by assignee</button>
        </div>

        <div className="kanban" style={{ flex: "none" }}>
          <div className="kanban-col">
            <div className="kanban-head"><span className="col-dot" />To do <span className="count">2</span></div>
            <div className="kanban-cards">
              <div className="task-card">
                <div className="task-title">Tokenize component stylesheets</div>
                <div className="task-desc">Replace every hardcoded color so light themes work.</div>
                <div className="task-foot">
                  <span className="task-assignee">
                    <span className="avatar" style={{ background: "var(--avatar-0)" }}>S</span>Scout
                  </span>
                  <span className="chip tiny-chip">2026-07-26</span>
                </div>
              </div>
              <div className="task-card">
                <div className="task-title">Ship the theme picker</div>
                <div className="task-foot">
                  <span className="chip tiny-chip overdue">2026-07-22</span>
                </div>
              </div>
            </div>
            <input className="quick-add" placeholder="＋ Add task" />
          </div>

          <div className="kanban-col">
            <div className="kanban-head"><span className="col-dot hot" />In progress <span className="count">1</span></div>
            <div className="kanban-cards">
              <div className="task-card">
                <div className="task-title">Syntax highlighting in messages</div>
                <div className="task-desc">Dependency-free tokenizer, themed via --syn-* tokens.</div>
                <div className="task-foot">
                  <span className="task-assignee">
                    <span className="avatar" style={{ background: "var(--avatar-5)" }}>N</span>Nova
                  </span>
                </div>
                <div className="run-strip"><span className="spinner" /> agent working…</div>
              </div>
            </div>
            <input className="quick-add" placeholder="＋ Add task" />
          </div>
        </div>

        <div className="dash-body">
          <div className="dash-card">
            <h3><IconBolt size={15} /> Active agent runs</h3>
            <div className="list-row"><span className="run-pulse" />
              <span className="list-title">Nova working in #frontend</span>
              <span className="list-sub">2m ago</span>
            </div>
            <div className="list-row"><span className="pr-dot">⬤</span>
              <span className="list-title">v2 hardening: fix review findings</span>
              <span className="list-sub">spaces-ai/spaces-main #182 · 1h ago</span>
            </div>
          </div>

          <div className="dash-card">
            <h3>Themes</h3>
            <div className="pv-grid">
              {THEMES.slice(0, 6).map((t) => <MiniPreview key={t.id} t={t} />)}
            </div>
          </div>

          <div className="dash-card">
            <h3>Controls</h3>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn primary">Primary</button>
              <button className="btn">Secondary</button>
              <button className="btn danger">Danger</button>
              <button className="btn" disabled>Disabled</button>
              <span className="chip">chip</span>
              <span className="chip tiny-chip">tiny</span>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <span className="field-label">Text field</span>
              <input placeholder="owner/name" />
            </div>
            <div className="banner info">Project memory is injected into every agent run.</div>
            <div className="banner warn" style={{ marginTop: 8 }}>Merge in progress — resolve or abort.</div>
          </div>
        </div>
      </div>

      <Bar theme={theme} onPick={pick} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
