use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// run_id -> process-group id (children are spawned in their own group).
struct RunningAgents(Mutex<HashMap<String, u32>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    run_id: String,
    kind: String, // "line" | "stderr" | "done" | "error"
    data: String,
    exit_code: Option<i32>,
}

/// PATH from a login shell — a bundled .app gets a minimal launchd PATH, which
/// breaks both finding CLIs and the node/git tooling they spawn.
fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let fallback = std::env::var("PATH").unwrap_or_default();
        let out = Command::new("/bin/zsh")
            .args(["-lc", "echo -n \"$PATH\""])
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if p.len() > fallback.len() {
                    p
                } else {
                    fallback
                }
            }
            _ => fallback,
        }
    })
}

/// Resolve a CLI binary that may not be on the GUI app's PATH.
fn resolve_bin(name: &str) -> String {
    for dir in login_path().split(':') {
        if dir.is_empty() {
            continue;
        }
        let p = format!("{dir}/{name}");
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.local/bin/{name}"),
        format!("{home}/.claude/local/{name}"),
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("{home}/.cargo/bin/{name}"),
    ];
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    name.to_string()
}

fn blocking_output(mut cmd: Command) -> Result<std::process::Output, String> {
    cmd.env("PATH", login_path());
    cmd.output().map_err(|e| format!("failed to launch: {e}"))
}

fn platform_label(os: &str, arch: &str) -> String {
    match (os, arch) {
        ("macos", "aarch64") => "macOS · Apple silicon".to_string(),
        ("macos", "x86_64") => "macOS · Intel".to_string(),
        ("windows", "aarch64") => "Windows · ARM".to_string(),
        ("windows", "x86_64") => "Windows · x64".to_string(),
        ("linux", "aarch64") => "Linux · ARM64".to_string(),
        ("linux", "x86_64") => "Linux · x64".to_string(),
        _ => format!("{os} · {arch}"),
    }
}

/// The webview's `navigator.platform` reports `MacIntel` even on Apple
/// silicon. The native binary knows the architecture it is actually running.
#[tauri::command]
fn current_platform() -> String {
    platform_label(std::env::consts::OS, std::env::consts::ARCH)
}

#[tauri::command]
fn agent_control_root(app: AppHandle, project_id: String) -> Result<String, String> {
    if project_id.is_empty()
        || !project_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid project id for the agent control directory".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))?
        .join("agent-control")
        .join(project_id);
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("could not create {}: {error}", root.display()))?;
    std::fs::canonicalize(&root)
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("could not resolve {}: {error}", root.display()))
}

async fn run_tool(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = &cwd {
            if !std::path::Path::new(dir).is_dir() {
                return Err(format!("directory does not exist: {dir}"));
            }
        }
        let mut cmd = Command::new(resolve_bin(&program));
        cmd.args(&args);
        if let Some(dir) = &cwd {
            cmd.current_dir(dir);
        }
        let out = blocking_output(cmd)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            let so = String::from_utf8_lossy(&out.stdout).to_string();
            Err(if err.trim().is_empty() { so } else { err })
        }
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Run the `gh` CLI and return stdout. Used for all GitHub data.
#[tauri::command]
async fn run_gh(args: Vec<String>) -> Result<String, String> {
    run_tool("gh".into(), args, None).await
}

/// Run `gh` in a directory (pr create needs repo context).
#[tauri::command]
async fn run_gh_in(args: Vec<String>, cwd: String) -> Result<String, String> {
    run_tool("gh".into(), args, Some(cwd)).await
}

/// Run `git` in a directory. Used for workspace (worktree) management and diffs.
#[tauri::command]
async fn run_git(args: Vec<String>, cwd: String) -> Result<String, String> {
    run_tool("git".into(), args, Some(cwd)).await
}

/// Run `git` with extra environment and optional stdin.
///
/// The workspace-git layer needs two things plain `run_git` cannot do:
/// `GIT_INDEX_FILE`, so a tree can be built without disturbing the index the
/// user is working in, and stdin, for plumbing like `mktree` and
/// `hash-object --stdin`. Kept separate from `run_git` rather than widening it,
/// so the common call sites stay honest about not needing either.
///
/// `env` is additive over the inherited environment; PATH is still forced to
/// the login PATH by `blocking_output`, so a caller cannot smuggle a different
/// git in through it.
#[tauri::command]
async fn run_git_ex(
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    stdin: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !std::path::Path::new(&cwd).is_dir() {
            return Err(format!("directory does not exist: {cwd}"));
        }
        let mut cmd = Command::new(resolve_bin("git"));
        cmd.args(&args).current_dir(&cwd);
        for (k, v) in &env {
            // PATH is set from the login shell after this and must win.
            if k != "PATH" {
                cmd.env(k, v);
            }
        }
        let Some(input) = stdin else {
            let out = blocking_output(cmd)?;
            return if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).to_string())
            } else {
                let err = String::from_utf8_lossy(&out.stderr).to_string();
                Err(if err.trim().is_empty() {
                    String::from_utf8_lossy(&out.stdout).to_string()
                } else {
                    err
                })
            };
        };

        cmd.env("PATH", login_path());
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("failed to launch: {e}"))?;
        {
            use std::io::Write;
            let mut sink = child.stdin.take().ok_or("no stdin pipe")?;
            sink.write_all(input.as_bytes())
                .map_err(|e| format!("write to git failed: {e}"))?;
            // Dropping closes the pipe; git blocks forever otherwise.
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("git did not finish: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            Err(if err.trim().is_empty() {
                String::from_utf8_lossy(&out.stdout).to_string()
            } else {
                err
            })
        }
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Which agent/GitHub CLIs are available on this machine.
#[tauri::command]
async fn check_tools() -> HashMap<String, bool> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut m = HashMap::new();
        for name in ["claude", "codex", "gh", "node"] {
            let found = std::path::Path::new(&resolve_bin(name)).is_absolute();
            m.insert(name.to_string(), found);
        }
        m
    })
    .await
    .unwrap_or_default()
}

/// Read a bounded Calendar.app snapshot through macOS's own automation
/// permission boundary. The frontend cannot inject script: it supplies only
/// numeric range arguments to this fixed JXA program.
#[tauri::command]
async fn apple_calendar_snapshot(start_at: f64, end_at: f64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"
function run(argv) {
  const calendarApp = Application("Calendar");
  const startAt = Number(argv[0]);
  const endAt = Number(argv[1]);
  const result = [];
  for (const calendar of calendarApp.calendars()) {
    const calendarName = calendar.name();
    for (const event of calendar.events()) {
      try {
        const start = event.startDate();
        const end = event.endDate();
        const startMs = start.getTime();
        const endMs = end.getTime();
        if (endMs < startAt || startMs > endAt) continue;
        let allDay = false;
        try {
          allDay = Boolean(event.alldayEvent());
        } catch (_) {
          try {
            allDay = Boolean(event.allDayEvent());
          } catch (_) {}
        }

        result.push({
          id: String(event.uid() || ""),
          calendar: String(calendarName || ""),
          title: String(event.summary() || "Untitled event"),
          startAt: startMs,
          endAt: endMs,
          allDay,
          location: String(event.location() || ""),
          notes: String(event.description() || "")
        });
      } catch (_) {}
    }
  }
  return JSON.stringify(result);
}
"#;
        let mut cmd = Command::new("/usr/bin/osascript");
        cmd.args([
            "-l",
            "JavaScript",
            "-e",
            script,
            &start_at.to_string(),
            &end_at.to_string(),
        ]);
        let out = blocking_output(cmd)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let error = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if error.is_empty() {
                "Calendar access was not granted.".into()
            } else {
                error
            })
        }
    })
    .await
    .map_err(|e| format!("calendar task failed: {e}"))?
}

/// Create one event in Calendar.app. Calendar selection and all content arrive
/// as argv values, never interpolated into the fixed automation program.
#[tauri::command]
async fn apple_calendar_create(
    title: String,
    start_at: f64,
    end_at: f64,
    calendar_name: String,
    location: String,
    notes: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"
function run(argv) {
  const app = Application("Calendar");
  const title = argv[0];
  const startAt = Number(argv[1]);
  const endAt = Number(argv[2]);
  const requestedCalendar = argv[3];
  const location = argv[4];
  const notes = argv[5];
  const calendars = app.calendars();
  if (!calendars.length) throw new Error("Calendar.app has no writable calendars.");
  let calendar = requestedCalendar
    ? calendars.find(item => item.name() === requestedCalendar)
    : calendars[0];
  if (!calendar) {
    const available = calendars.map(item => String(item.name() || "")).filter(Boolean);
    throw new Error('Calendar "' + requestedCalendar + '" was not found. Available: ' + available.join(", "));
  }
  const event = app.Event({
    summary: title,
    startDate: new Date(startAt),
    endDate: new Date(Math.max(startAt, endAt)),
    location: location,
    description: notes
  });
  calendar.events.push(event);
  return JSON.stringify({
    id: String(event.uid() || ""),
    calendar: String(calendar.name() || ""),
    title: title,
    startAt: startAt,
    endAt: Math.max(startAt, endAt),
    allDay: false,
    location: location,
    notes: notes
  });
}
"#;
        let mut cmd = Command::new("/usr/bin/osascript");
        cmd.args([
            "-l",
            "JavaScript",
            "-e",
            script,
            &title,
            &start_at.to_string(),
            &end_at.to_string(),
            &calendar_name,
            &location,
            &notes,
        ]);
        let out = blocking_output(cmd)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let error = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if error.is_empty() {
                "Could not create the Apple Calendar event.".into()
            } else {
                error
            })
        }
    })
    .await
    .map_err(|e| format!("calendar task failed: {e}"))?
}

/// Distinct temp-file suffix — two concurrent writes must not fight over one.
fn temp_suffix() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{n}", std::process::id())
}

/// Resolve `relative` inside `root`, refusing anything that escapes it, and
/// return (canonical root, resolved target).
///
/// This is a security boundary, not a convenience: the frontend passes the
/// project directory as `root`, and no combination of an absolute path, "..",
/// or a symlinked directory may be made to read or write outside it.
fn contained_path(root: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    if relative.trim().is_empty() {
        return Err("relative path is empty".into());
    }
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(format!("path must be relative: {relative}"));
    }
    // Components normalises away interior "." but never ".." — anything that
    // isn't a plain name is a traversal attempt.
    for comp in rel.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("path escapes the root: {relative}")),
        }
    }
    if !matches!(rel.components().next_back(), Some(Component::Normal(_))) {
        return Err(format!("path does not name a file: {relative}"));
    }

    let root_abs =
        std::fs::canonicalize(root).map_err(|e| format!("root is unusable ({root}): {e}"))?;
    if !root_abs.is_dir() {
        return Err(format!("root is not a directory: {root}"));
    }
    let target = root_abs.join(rel);

    // A symlink anywhere along the path could point out of the root, so
    // canonicalise the deepest part that already exists and re-check. Doing
    // this *before* creating anything stops create_dir_all from following a
    // planted symlink out of the project.
    let mut probe = target.clone();
    let anchor = loop {
        if probe.symlink_metadata().is_ok() {
            break probe;
        }
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => return Err(format!("path escapes the root: {relative}")),
        }
    };
    let anchor_abs = std::fs::canonicalize(&anchor)
        .map_err(|e| format!("could not resolve {}: {e}", anchor.display()))?;
    if !anchor_abs.starts_with(&root_abs) {
        return Err(format!(
            "refusing to touch {} outside {}",
            anchor_abs.display(),
            root_abs.display()
        ));
    }
    Ok((root_abs, target))
}

/// Write a UTF-8 file at `root`/`relative_path`, creating parent directories.
/// The write is atomic (temp file + rename) so an agent reading the shared
/// blackboard never sees a half-written file. Confined to `root`.
#[tauri::command]
async fn write_text_file(
    root: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root_abs, target) = contained_path(&root, &relative_path)?;
        let parent = target
            .parent()
            .ok_or_else(|| format!("no parent directory for {relative_path}"))?
            .to_path_buf();
        std::fs::create_dir_all(&parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        let parent_abs = std::fs::canonicalize(&parent)
            .map_err(|e| format!("could not resolve {}: {e}", parent.display()))?;
        if !parent_abs.starts_with(&root_abs) {
            return Err(format!("refusing to write outside {}", root_abs.display()));
        }
        let name = target
            .file_name()
            .ok_or_else(|| format!("no file name in {relative_path}"))?
            .to_os_string();
        let dest = parent_abs.join(&name);
        if dest.is_dir() {
            return Err(format!("{} is a directory", dest.display()));
        }
        let tmp = parent_abs.join(format!(
            ".{}.hq-{}.tmp",
            name.to_string_lossy(),
            temp_suffix()
        ));
        let written = (|| -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(contents.as_bytes())?;
            f.sync_all()
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("could not write {}: {e}", target.display()));
        }
        // rename replaces the destination atomically — and replaces a symlink
        // rather than writing through it.
        std::fs::rename(&tmp, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("could not replace {}: {e}", target.display())
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Read a UTF-8 file at `root`/`relative_path`. Confined to `root`.
#[tauri::command]
async fn read_text_file(root: String, relative_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root_abs, target) = contained_path(&root, &relative_path)?;
        let real = std::fs::canonicalize(&target)
            .map_err(|e| format!("could not read {relative_path}: {e}"))?;
        if !real.starts_with(&root_abs) {
            return Err(format!("refusing to read outside {}", root_abs.display()));
        }
        std::fs::read_to_string(&real).map_err(|e| format!("could not read {relative_path}: {e}"))
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// One entry from `walk_directory`. `rel_path` is relative to the canonical
/// root and always uses forward slashes, so it survives being stored as a key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryInfo {
    rel_path: String,
    size: u64,
    /// Milliseconds since the epoch, so it compares directly against Date.now().
    modified_at: f64,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirWalk {
    /// The canonical root actually walked, which may differ from what was
    /// asked for if the caller passed a symlink or a relative path.
    root: String,
    entries: Vec<DirEntryInfo>,
    /// A cap stopped the walk early: this is a prefix of the tree, not the
    /// tree. The caller has to be able to say so rather than quietly claiming
    /// a 200,000-file home directory has 20,000 files in it.
    truncated: bool,
}

/// Defaults sized for a large notes vault; the maximums are the point past
/// which "mirror a folder" has become "index the disk" and should be refused.
const WALK_DEPTH_DEFAULT: u32 = 12;
const WALK_DEPTH_MAX: u32 = 40;
const WALK_ENTRIES_DEFAULT: u32 = 20_000;
const WALK_ENTRIES_MAX: u32 = 200_000;

/// Shell-style wildcard match, `*` for any run and `?` for one character.
///
/// Deliberately tiny: exclude patterns are things like `.git`, `node_modules`
/// and `*.png`, not a query language, and pulling in a glob crate for that
/// would be a dependency to maintain forever. Iterative with a backtrack point
/// so a pattern like `*a*a*a*` cannot blow up.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            pi += 1;
            resume = ti;
        } else if star != usize::MAX {
            resume += 1;
            pi = star + 1;
            ti = resume;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Walk `root` and list what is inside it, for mirroring a folder read-only —
/// an Obsidian vault, a docs directory.
///
/// Three properties make this safe to point at a folder the app does not own:
///
///   containment  every path is canonicalised and must still start with the
///                canonical root. A symlink that leaves the vault is skipped,
///                never followed, so the mirror cannot be tricked into
///                enumerating `~/.ssh` by planting a link inside the notes.
///   bounds       a depth cap, a total-entry cap and a set of already-visited
///                directories. A symlink cycle terminates, and a wrong folder
///                choice returns quickly with `truncated` set instead of
///                hanging the app.
///   tolerance    an unreadable entry is skipped rather than fatal. One
///                permission-denied subfolder must not cost the other 5,000
///                notes.
#[tauri::command]
async fn walk_directory(
    root: String,
    exclude: Vec<String>,
    max_depth: Option<u32>,
    max_entries: Option<u32>,
) -> Result<DirWalk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_abs =
            std::fs::canonicalize(&root).map_err(|e| format!("root is unusable ({root}): {e}"))?;
        if !root_abs.is_dir() {
            return Err(format!("root is not a directory: {root}"));
        }
        let depth_cap = max_depth.unwrap_or(WALK_DEPTH_DEFAULT).min(WALK_DEPTH_MAX);
        let entry_cap = max_entries
            .unwrap_or(WALK_ENTRIES_DEFAULT)
            .min(WALK_ENTRIES_MAX) as usize;
        let patterns: Vec<String> = exclude
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();

        let mut entries: Vec<DirEntryInfo> = Vec::new();
        let mut truncated = false;
        // Canonical directories already queued. This is what makes a symlink
        // cycle finite rather than merely capped.
        let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        seen.insert(root_abs.clone());
        // Depth-first with an explicit stack: recursing over a stranger's
        // directory tree is a stack overflow waiting to be discovered.
        let mut stack: Vec<(PathBuf, String, u32)> = vec![(root_abs.clone(), String::new(), 0)];

        while let Some((dir, prefix, depth)) = stack.pop() {
            if entries.len() >= entry_cap {
                truncated = true;
                break;
            }
            let listing = match std::fs::read_dir(&dir) {
                Ok(l) => l,
                Err(_) => continue,
            };
            for entry in listing.flatten() {
                if entries.len() >= entry_cap {
                    truncated = true;
                    break;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.is_empty() || name.contains('/') {
                    continue;
                }
                let rel = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                // Patterns match a bare name (`.git`, `*.png`) or a path from
                // the root (`archive/*`), whichever the caller wrote.
                if patterns
                    .iter()
                    .any(|p| glob_match(p, &name) || glob_match(p, &rel))
                {
                    continue;
                }
                let kind = match entry.file_type() {
                    Ok(k) => k,
                    Err(_) => continue,
                };
                // A symlink has to prove it lands inside the root before it is
                // resolved at all; otherwise it is left out of the mirror.
                let real = if kind.is_symlink() {
                    match std::fs::canonicalize(entry.path()) {
                        Ok(p) if p.starts_with(&root_abs) => p,
                        _ => continue,
                    }
                } else {
                    entry.path()
                };
                let meta = match std::fs::metadata(&real) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let is_dir = meta.is_dir();
                if !is_dir && !meta.is_file() {
                    continue; // sockets, fifos and devices are not documents
                }
                let modified_at = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0);
                entries.push(DirEntryInfo {
                    rel_path: rel.clone(),
                    size: if is_dir { 0 } else { meta.len() },
                    modified_at,
                    is_dir,
                });
                if !is_dir {
                    continue;
                }
                if depth + 1 > depth_cap {
                    truncated = true; // there is more down there; say so
                    continue;
                }
                let canon = match std::fs::canonicalize(&real) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if canon.starts_with(&root_abs) && seen.insert(canon.clone()) {
                    stack.push((canon, rel, depth + 1));
                }
            }
        }

        // Sorted so two walks of an unchanged tree produce the same list —
        // read_dir order is whatever the filesystem feels like.
        entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(DirWalk {
            root: root_abs.to_string_lossy().to_string(),
            entries,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// TERM then (after a grace period) KILL an entire process group.
fn kill_group(pgid: u32) {
    unsafe {
        libc::killpg(pgid as i32, libc::SIGTERM);
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        unsafe {
            libc::killpg(pgid as i32, libc::SIGKILL);
        }
    });
}

/// Spawn an agent CLI (claude/codex) and stream its stdout lines as events.
/// The prompt is written to stdin (argv has ARG_MAX limits; both CLIs read
/// stdin in print/exec mode). The child gets its own process group so cancel
/// and app-exit can reap everything it spawned. Completion is driven by child
/// exit, not stdout EOF — a background process inheriting the pipe can't wedge
/// the run.
#[tauri::command]
async fn start_agent_run(
    app: AppHandle,
    state: State<'_, RunningAgents>,
    run_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    prompt: String,
) -> Result<(), String> {
    let bin = resolve_bin(&program);
    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .env("PATH", login_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        if !std::path::Path::new(&dir).is_dir() {
            return Err(format!("working directory does not exist: {dir}"));
        }
        cmd.current_dir(dir);
    }
    let mut child: Child = tauri::async_runtime::spawn_blocking(move || cmd.spawn())
        .await
        .map_err(|e| format!("spawn task failed: {e}"))?
        .map_err(|e| format!("failed to launch {bin}: {e}"))?;

    let pgid = child.id();
    state.0.lock().unwrap().insert(run_id.clone(), pgid);

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
        // dropping stdin closes the pipe so the CLI knows the prompt is complete
    });

    let app_err = app.clone();
    let rid_err = run_id.clone();
    let err_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            buf.push_str(&line);
            buf.push('\n');
            let _ = app_err.emit(
                "agent-event",
                AgentEvent {
                    run_id: rid_err.clone(),
                    kind: "stderr".into(),
                    data: line,
                    exit_code: None,
                },
            );
        }
        buf
    });

    let (eof_tx, eof_rx) = std::sync::mpsc::channel::<()>();
    let app_out = app.clone();
    let rid_out = run_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app_out.emit(
                "agent-event",
                AgentEvent {
                    run_id: rid_out.clone(),
                    kind: "line".into(),
                    data: line,
                    exit_code: None,
                },
            );
        }
        let _ = eof_tx.send(());
    });

    std::thread::spawn(move || {
        let status = child.wait().ok();
        // Give the stdout reader a moment to drain buffered lines; if a stray
        // grandchild still holds the pipe open, don't wait forever.
        let _ = eof_rx.recv_timeout(Duration::from_secs(3));
        let stderr_text = err_handle.join().unwrap_or_default();
        let code = status.and_then(|s| s.code());
        let was_tracked = app
            .state::<RunningAgents>()
            .0
            .lock()
            .unwrap()
            .remove(&run_id)
            .is_some();
        // Reap anything the agent left behind in its process group.
        kill_group(pgid);
        let cancelled = !was_tracked;
        let _ = app.emit(
            "agent-event",
            AgentEvent {
                run_id: run_id.clone(),
                kind: if code == Some(0) && !cancelled {
                    "done".into()
                } else {
                    "error".into()
                },
                data: stderr_text,
                exit_code: code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
fn cancel_agent_run(state: State<'_, RunningAgents>, run_id: String) -> Result<(), String> {
    if let Some(pgid) = state.0.lock().unwrap().remove(&run_id) {
        kill_group(pgid);
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * Real terminals (PTY)
 *
 * start_agent_run streams a *headless* harness over pipes. This is the other
 * mode: a genuine pty, so a CLI runs in its literal interactive UI and the
 * user can watch and type. Entirely separate from RunningAgents — nothing
 * here touches runs, sessions or the agent event stream.
 * ------------------------------------------------------------------ */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    session_id: String,
    exit_code: Option<i32>,
}

/// One live pty: the master (resize), a channel to its writer thread
/// (keystrokes), and a killer cloned off the child so signalling never queues
/// behind a blocked `wait()`.
///
/// Input goes through a channel rather than a shared writer for two reasons:
/// writing to a master whose child has stopped reading blocks, and Tauri runs
/// synchronous commands on the main thread — so a direct write could freeze the
/// UI. The channel send never blocks, and one dedicated thread drains it, which
/// also keeps keystrokes in the order they were typed.
///
/// Each field carries its own lock and the registry lock is always released
/// before any of them is taken.
struct PtySlot {
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// None once the terminal is closed; dropping the sender ends the writer thread.
    input: Mutex<Option<std::sync::mpsc::Sender<String>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Session leader pid. portable-pty calls setsid() in the child, so this
    /// is also the process-group id of everything the terminal spawns.
    pgid: Option<u32>,
    /// Cleared the moment this slot stops owning its session id. A reader
    /// thread wedged on a fd a grandchild still holds open can therefore never
    /// emit into a newer terminal that reused the id.
    alive: AtomicBool,
}

impl PtySlot {
    /// Stop emitting for this session and take the process down: SIGHUP (what
    /// a real terminal sends when its window closes) then the same TERM → KILL
    /// ladder the agent runner uses, over the whole process group.
    fn terminate(&self) {
        self.alive.store(false, Ordering::SeqCst);
        // Closing the channel is what stops the writer thread.
        recover(self.input.lock()).take();
        match self.pgid {
            Some(pgid) => {
                unsafe {
                    libc::killpg(pgid as i32, libc::SIGHUP);
                }
                kill_group(pgid);
            }
            None => {
                let _ = recover(self.killer.lock()).kill();
            }
        }
    }
}

/// session_id -> live pty.
struct LivePtys(Mutex<HashMap<String, Arc<PtySlot>>>);

/// Take a lock, recovering rather than panicking if a previous holder panicked.
/// Nothing behind these locks can be left half-updated, and one bad thread must
/// not permanently disable every terminal in the app.
fn recover<'a, T>(
    r: Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>,
) -> MutexGuard<'a, T> {
    r.unwrap_or_else(|e| e.into_inner())
}

fn live_slot(state: &LivePtys, session_id: &str) -> Result<Arc<PtySlot>, String> {
    recover(state.0.lock())
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("no terminal is running for session {session_id}"))
}

/// Decode everything in `pending` that forms complete UTF-8, leaving a
/// truncated trailing sequence in the buffer for the next chunk.
///
/// A pty read can split a multi-byte character down the middle; from_utf8_lossy
/// on the raw chunk would turn that into two replacement characters. Genuinely
/// invalid bytes still become one replacement character each, so the buffer
/// never grows past the 3 bytes a truncated sequence can occupy.
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                match e.error_len() {
                    // Malformed: swallow the bad bytes and keep decoding.
                    Some(bad) => {
                        out.push(char::REPLACEMENT_CHARACTER);
                        pending.drain(..valid + bad);
                    }
                    // Truncated at the chunk boundary: hold it for next time.
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

/// Open a pty, run `program` in it, and stream its output as "pty-output".
/// Reusing a session id replaces whatever was on it, so a double-mounted UI
/// can never leave an orphan attached to the same terminal.
#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    session_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("a terminal needs a session id".into());
    }
    if program.trim().is_empty() {
        return Err("no program given to run in the terminal".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        spawn_pty_blocking(app, session_id, program, args, cwd, cols, rows)
    })
    .await
    .map_err(|e| format!("terminal spawn task failed: {e}"))?
}

fn spawn_pty_blocking(
    app: AppHandle,
    session_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let dir = cwd.filter(|d| !d.trim().is_empty());
    if let Some(d) = &dir {
        if !Path::new(d).is_dir() {
            return Err(format!("working directory does not exist: {d}"));
        }
    }

    if let Some(old) = recover(app.state::<LivePtys>().0.lock()).remove(&session_id) {
        old.terminate();
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("could not open a pty: {e}"))?;

    let bin = resolve_bin(&program);
    let mut cmd = CommandBuilder::new(&bin);
    cmd.args(&args);
    if let Some(d) = &dir {
        cmd.cwd(d);
    }
    // Same login-PATH fix the headless runner needs: a bundled .app inherits a
    // minimal launchd PATH, which breaks both the CLI and the tools it spawns.
    cmd.env("PATH", login_path());
    // TerminalPane implements a deliberately small ANSI subset, but claiming a
    // dumb TERM makes the CLIs disable colour entirely. Advertise the terminal
    // they expect and render the parts of it we support.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Deliberately no LINES/COLUMNS: ncurses trusts those over the kernel's
    // winsize, so setting them would freeze curses apps at the size the
    // terminal happened to open at and make pty_resize a no-op for them.
    // Real terminal emulators leave them unset for exactly this reason.

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to launch {bin}: {e}"))?;
    // The slave fd must go, or the master never reports EOF when the child dies.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read from the pty: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to the pty: {e}"))?;
    let killer = child.clone_killer();
    let pgid = child.process_id();

    let (in_tx, in_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        // Ends when the slot drops its sender (terminate, or the slot itself
        // being dropped). Write errors mean the child is gone; keep draining so
        // an already-queued keystroke can't wedge a sender.
        for chunk in in_rx {
            if writer.write_all(chunk.as_bytes()).is_ok() {
                let _ = writer.flush();
            }
        }
    });

    let slot = Arc::new(PtySlot {
        master: Mutex::new(pair.master),
        input: Mutex::new(Some(in_tx)),
        killer: Mutex::new(killer),
        pgid,
        alive: AtomicBool::new(true),
    });
    recover(app.state::<LivePtys>().0.lock()).insert(session_id.clone(), Arc::clone(&slot));

    let (eof_tx, eof_rx) = std::sync::mpsc::channel::<()>();
    {
        let app = app.clone();
        let sid = session_id.clone();
        let slot = Arc::clone(&slot);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // EIO here is simply "the slave end closed" — a normal exit.
                    Err(_) => break,
                };
                if !slot.alive.load(Ordering::SeqCst) {
                    break;
                }
                pending.extend_from_slice(&buf[..n]);
                let text = drain_utf8(&mut pending);
                if text.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "pty-output",
                    PtyOutput {
                        session_id: sid.clone(),
                        data: text,
                    },
                );
            }
            let _ = eof_tx.send(());
        });
    }

    {
        let app = app.clone();
        let sid = session_id.clone();
        let slot = Arc::clone(&slot);
        std::thread::spawn(move || {
            let status = child.wait().ok();
            // Let the reader drain what the child wrote just before exiting,
            // but never wait on it forever: a grandchild that inherited the
            // slave keeps the master readable indefinitely.
            let _ = eof_rx.recv_timeout(Duration::from_secs(2));
            let code = status.map(|s| s.exit_code() as i32);
            {
                let live = app.state::<LivePtys>();
                let mut map = recover(live.0.lock());
                // Only drop our own entry: the id may already belong to a
                // terminal spawned after this one died.
                if map.get(&sid).is_some_and(|s| Arc::ptr_eq(s, &slot)) {
                    map.remove(&sid);
                }
            }
            // Reap the rest of the pty's process group, which also frees a
            // reader still blocked on a slave fd a grandchild held open.
            slot.terminate();
            let _ = app.emit(
                "pty-exit",
                PtyExit {
                    session_id: sid,
                    exit_code: code,
                },
            );
        });
    }

    Ok(())
}

/// Queue keystrokes (or pasted text) for a live terminal. Returns as soon as
/// the bytes are queued; the slot's writer thread delivers them in order.
#[tauri::command]
fn pty_write(state: State<'_, LivePtys>, session_id: String, data: String) -> Result<(), String> {
    let slot = live_slot(&state, &session_id)?;
    let sender = recover(slot.input.lock()).clone();
    match sender {
        Some(tx) => tx
            .send(data)
            .map_err(|_| "the terminal is no longer accepting input".to_string()),
        None => Err("the terminal is closed".into()),
    }
}

/// Tell the kernel the window changed size, which also signals SIGWINCH.
#[tauri::command]
fn pty_resize(
    state: State<'_, LivePtys>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let slot = live_slot(&state, &session_id)?;
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let resized = recover(slot.master.lock()).resize(size);
    resized.map_err(|e| format!("could not resize the terminal: {e}"))
}

/// Close a terminal. Killing one that already exited is not an error — the UI
/// calls this on unmount, which races the process ending on its own.
#[tauri::command]
fn pty_kill(state: State<'_, LivePtys>, session_id: String) -> Result<(), String> {
    if let Some(slot) = recover(state.0.lock()).remove(&session_id) {
        slot.terminate();
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * Project browser
 *
 * The browser surface itself is a Tauri child webview created from the trusted
 * Spaces frontend. These commands deliberately address only hq-browser-* labels,
 * so an arbitrary frontend call cannot navigate or evaluate the main app
 * webview.
 * ------------------------------------------------------------------ */

fn project_browser(app: &AppHandle, label: &str) -> Result<tauri::Webview, String> {
    if !label.starts_with("hq-browser-") {
        return Err("not an Spaces project browser".into());
    }
    app.get_webview(label)
        .ok_or_else(|| format!("project browser {label} is not open"))
}

fn browser_http_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|e| format!("invalid browser address: {e}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("Spaces's browser opens http and https addresses only".into()),
    }
}

#[tauri::command]
async fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !label.starts_with("hq-browser-") {
        return Err("not an Spaces project browser".into());
    }
    if let Some(stale) = app.get_webview(&label) {
        stale.close().map_err(|e| e.to_string())?;
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "Spaces's main window is not available".to_string())?;
    let builder = tauri::webview::WebviewBuilder::new(
        label,
        tauri::WebviewUrl::External(browser_http_url(&url)?),
    )
    .focused(true)
    .devtools(true)
    .zoom_hotkeys_enabled(true)
    .allow_link_preview(false);
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map(|_| ())
        .map_err(|e| format!("could not open the project browser: {e}"))
}

#[tauri::command]
fn browser_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let browser = project_browser(&app, &label)?;
    browser
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| format!("could not position the project browser: {e}"))?;
    browser
        .set_size(tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| format!("could not size the project browser: {e}"))
}

#[tauri::command]
fn browser_visibility(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    let browser = project_browser(&app, &label)?;
    if visible {
        browser.show()
    } else {
        browser.hide()
    }
    .map_err(|e| format!("could not update the project browser: {e}"))
}

#[tauri::command]
fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    match app.get_webview(&label) {
        Some(browser) => browser.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<String, String> {
    let target = browser_http_url(&url)?;
    project_browser(&app, &label)?
        .navigate(target.clone())
        .map_err(|e| format!("could not open that address: {e}"))?;
    Ok(target.to_string())
}

#[tauri::command]
fn browser_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let browser = project_browser(&app, &label)?;
    match action.as_str() {
        "back" => browser
            .eval("history.back()")
            .map_err(|e| format!("could not go back: {e}")),
        "forward" => browser
            .eval("history.forward()")
            .map_err(|e| format!("could not go forward: {e}")),
        "reload" => browser
            .reload()
            .map_err(|e| format!("could not reload the page: {e}")),
        _ => Err(format!("unknown browser action: {action}")),
    }
}

#[tauri::command]
fn browser_url(app: AppHandle, label: String) -> Result<String, String> {
    project_browser(&app, &label)?
        .url()
        .map(|url| url.to_string())
        .map_err(|e| format!("could not read the browser address: {e}"))
}

#[cfg(test)]
// Keep the tests next to the commands they exercise; Tauri's public entry point
// follows because it is conventionally the final item in this library.
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    fn open(cols: u16, rows: u16) -> portable_pty::PtyPair {
        native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty")
    }

    fn read_all(reader: &mut Box<dyn Read + Send>) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn platform_label_does_not_call_apple_silicon_intel() {
        assert_eq!(platform_label("macos", "aarch64"), "macOS · Apple silicon");
        assert_eq!(platform_label("macos", "x86_64"), "macOS · Intel");
    }

    #[test]
    fn drain_utf8_holds_a_split_sequence() {
        // "é" is 0xC3 0xA9 — arriving one byte per chunk must still decode once.
        let mut pending = vec![b'a', 0xC3];
        assert_eq!(drain_utf8(&mut pending), "a");
        assert_eq!(pending, vec![0xC3]);
        pending.push(0xA9);
        assert_eq!(drain_utf8(&mut pending), "é");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_replaces_invalid_bytes_and_keeps_going() {
        let mut pending = vec![b'a', 0xFF, b'b'];
        assert_eq!(drain_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_never_holds_more_than_a_truncated_sequence() {
        // A 4-byte sequence truncated after three bytes is the worst case.
        let mut pending = vec![0xF0, 0x9F, 0x98];
        assert_eq!(drain_utf8(&mut pending), "");
        assert_eq!(pending.len(), 3);
        pending.push(0x80);
        assert_eq!(drain_utf8(&mut pending), "😀");
    }

    #[test]
    fn a_pty_child_inherits_env_and_cwd_and_reports_its_exit() {
        let pair = open(80, 24);
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'term=%s\\n' \"$TERM\"; pwd; exit 7"]);
        cmd.cwd("/tmp");
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let text = read_all(&mut reader);
        let status = child.wait().expect("wait");
        assert!(
            text.contains("term=xterm-256color"),
            "env not passed through: {text:?}"
        );
        assert!(
            text.contains("/tmp") || text.contains("/private/tmp"),
            "cwd not applied: {text:?}"
        );
        assert_eq!(status.exit_code(), 7);
    }

    #[test]
    fn the_child_sees_the_size_the_pty_was_opened_with() {
        let pair = open(100, 30);
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "stty size"]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let text = read_all(&mut reader);
        let _ = child.wait();
        assert!(text.contains("30 100"), "winsize not applied: {text:?}");

        pair.master
            .resize(PtySize {
                rows: 42,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("resize");
        let size = pair.master.get_size().expect("get_size");
        assert_eq!((size.rows, size.cols), (42, 120));
    }

    #[test]
    fn input_written_to_the_master_reaches_the_child() {
        let pair = open(80, 24);
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "read line; printf 'got:%s\\n' \"$line\""]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut writer = pair.master.take_writer().expect("writer");
        let mut reader = pair.master.try_clone_reader().expect("reader");
        writer.write_all(b"ping\r").expect("write");
        writer.flush().expect("flush");
        let text = read_all(&mut reader);
        let _ = child.wait();
        assert!(text.contains("got:ping"), "input never arrived: {text:?}");
    }

    #[test]
    fn an_interactive_login_zsh_accepts_commands() {
        let pair = open(80, 24);
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.args(["-l", "-i"]);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut writer = pair.master.take_writer().expect("writer");
        let mut reader = pair.master.try_clone_reader().expect("reader");
        writer
            .write_all(b"printf 'hq-shell-ready\\n'; exit\r")
            .expect("write");
        writer.flush().expect("flush");
        let text = read_all(&mut reader);
        let status = child.wait().expect("wait");
        assert!(
            text.contains("hq-shell-ready"),
            "interactive zsh never accepted input: {text:?}"
        );
        assert_eq!(status.exit_code(), 0);
    }

    #[test]
    fn the_session_leader_is_its_own_process_group() {
        let pair = open(80, 24);
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 5"]);
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let pid = child.process_id().expect("pid") as i32;
        // portable-pty calls setsid(), so killing the *group* named by the
        // child's pid is what reaps everything the terminal spawned.
        let pgid = unsafe { libc::getpgid(pid) };
        assert_eq!(pgid, pid, "child is not its own process-group leader");
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(RunningAgents(Mutex::new(HashMap::new())))
        .manage(LivePtys(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            current_platform,
            agent_control_root,
            run_gh,
            run_gh_in,
            run_git,
            run_git_ex,
            check_tools,
            apple_calendar_snapshot,
            apple_calendar_create,
            start_agent_run,
            cancel_agent_run,
            write_text_file,
            read_text_file,
            walk_directory,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            browser_open,
            browser_bounds,
            browser_visibility,
            browser_close,
            browser_navigate,
            browser_action,
            browser_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Don't leave agent processes running unsupervised after quit.
                let state = app.state::<RunningAgents>();
                let pgids: Vec<u32> = state.0.lock().unwrap().drain().map(|(_, v)| v).collect();
                for pgid in pgids {
                    unsafe {
                        libc::killpg(pgid as i32, libc::SIGTERM);
                    }
                }
                // Same for interactive terminals. kill_group's delayed SIGKILL
                // would die with us, so signal inline: SIGHUP is what closing a
                // terminal sends, SIGTERM covers anything that ignores it.
                let slots: Vec<Arc<PtySlot>> = recover(app.state::<LivePtys>().0.lock())
                    .drain()
                    .map(|(_, v)| v)
                    .collect();
                for slot in slots {
                    slot.alive.store(false, Ordering::SeqCst);
                    recover(slot.input.lock()).take();
                    match slot.pgid {
                        Some(pgid) => unsafe {
                            libc::killpg(pgid as i32, libc::SIGHUP);
                            libc::killpg(pgid as i32, libc::SIGTERM);
                        },
                        None => {
                            let _ = recover(slot.killer.lock()).kill();
                        }
                    }
                }
            }
        });
}
