use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunRequest {
    run_id: String,
    agent_id: String,
    channel_id: String,
    project_id: String,
    trigger_id: String,
    reply_to: String,
    project_root: String,
    context_dir: String,
    mcp_server: String,
    runtime: String,
    harness_protocol: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    prompt: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalMedia {
    id: String,
    project_id: String,
    file_name: String,
    content_type: String,
    size: u64,
    etag: String,
    url: String,
}

#[derive(Deserialize)]
struct PortalMediaResponse {
    media: Option<PortalMedia>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredAgentProfile {
    path: String,
    name: String,
    kind: String,
    description: String,
    model: String,
    persona: String,
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

/// Locate the pre-Spaces HQ database, if this computer has one.
///
/// Spaces intentionally has its own bundle identifier, but that also moved its
/// app-data directory. Existing users must not look as though their projects,
/// paths and vault disappeared after installing the public build. The database
/// layer attaches this file and merges rows by identity; it never replaces
/// either database.
#[tauri::command]
fn legacy_hq_database_path(app: AppHandle) -> Result<Option<String>, String> {
    let current = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))?;
    let Some(parent) = current.parent() else {
        return Ok(None);
    };
    let legacy = parent.join("com.lauren.hq").join("hq.db");
    Ok(legacy
        .is_file()
        .then(|| legacy.to_string_lossy().to_string()))
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

fn media_content_type(path: &Path) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "avif" => Ok("image/avif"),
        "gif" => Ok("image/gif"),
        "jpeg" | "jpg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "webp" => Ok("image/webp"),
        "mp4" => Ok("video/mp4"),
        "mov" => Ok("video/quicktime"),
        "webm" => Ok("video/webm"),
        "m4v" => Ok("video/x-m4v"),
        _ => Err("Choose a PNG, JPEG, WebP, GIF, AVIF, MP4, MOV, M4V, or WebM file.".into()),
    }
}

/// Stream a local media file through the paired Spaces site into its R2
/// bucket. The desktop owns the connection token; agent processes only submit
/// a path, and an approved operation invokes this command on their behalf.
#[tauri::command]
async fn upload_portal_media(
    path: String,
    allowed_root: String,
    base_url: String,
    token: String,
    project_id: String,
    instagram_compatible: bool,
) -> Result<PortalMedia, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if token.trim().is_empty() {
            return Err("Pair this Spaces desktop before uploading media.".into());
        }
        let real = std::fs::canonicalize(&path)
            .map_err(|error| format!("media file is unavailable ({path}): {error}"))?;
        if !real.is_file() {
            return Err(format!("media path is not a file: {}", real.display()));
        }
        if !allowed_root.trim().is_empty() {
            let root = std::fs::canonicalize(&allowed_root).map_err(|error| {
                format!("project folder is unavailable ({allowed_root}): {error}")
            })?;
            if !root.is_dir() || !real.starts_with(&root) {
                return Err("Agent media must be inside the selected project's folder.".into());
            }
        }
        let metadata = std::fs::metadata(&real)
            .map_err(|error| format!("could not inspect {}: {error}", real.display()))?;
        if metadata.len() == 0 {
            return Err("The media file is empty.".into());
        }
        if metadata.len() > 95 * 1024 * 1024 {
            return Err("Media uploads are limited to 95 MB.".into());
        }
        let original_file_name = real
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "The media file must have a valid filename.".to_string())?
            .to_string();
        let mut upload_path = real.clone();
        let mut file_name = original_file_name;
        let mut content_type = media_content_type(&real)?.to_string();
        let mut converted_path: Option<PathBuf> = None;

        // Instagram's publishing API accepts feed photos as JPEG. The Content
        // Studio and channel media surfaces deliberately accept richer image
        // formats, so normalize only the copy being sent to Instagram and
        // leave the source asset untouched.
        if instagram_compatible
            && content_type.starts_with("image/")
            && content_type != "image/jpeg"
        {
            #[cfg(target_os = "macos")]
            {
                let converted =
                    std::env::temp_dir().join(format!("spaces-instagram-{}.jpg", temp_suffix()));
                let output = Command::new("/usr/bin/sips")
                    .args(["-s", "format", "jpeg", "-s", "formatOptions", "95"])
                    .arg(&real)
                    .arg("--out")
                    .arg(&converted)
                    .output()
                    .map_err(|error| {
                        format!("could not prepare this image for Instagram: {error}")
                    })?;
                if !output.status.success() || !converted.is_file() {
                    let _ = std::fs::remove_file(&converted);
                    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if detail.is_empty() {
                        "Could not convert this image to the JPEG format Instagram requires.".into()
                    } else {
                        format!("Could not convert this image for Instagram: {detail}")
                    });
                }
                upload_path = converted.clone();
                file_name = real
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("{value}.jpg"))
                    .unwrap_or_else(|| "instagram-media.jpg".into());
                content_type = "image/jpeg".into();
                converted_path = Some(converted);
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err(
                    "Instagram feed images must be JPEG. Convert this image to .jpg and try again."
                        .into(),
                );
            }
        }
        let upload_metadata = std::fs::metadata(&upload_path)
            .map_err(|error| format!("could not inspect {}: {error}", upload_path.display()))?;
        if upload_metadata.len() == 0 {
            if let Some(path) = converted_path.as_ref() {
                let _ = std::fs::remove_file(path);
            }
            return Err("The prepared media file is empty.".into());
        }
        if upload_metadata.len() > 95 * 1024 * 1024 {
            if let Some(path) = converted_path.as_ref() {
                let _ = std::fs::remove_file(path);
            }
            return Err("Media uploads are limited to 95 MB.".into());
        }
        let result = (|| -> Result<PortalMedia, String> {
            let mut endpoint = reqwest::Url::parse(base_url.trim())
                .map_err(|error| format!("Spaces site address is invalid: {error}"))?
                .join("/api/device/media")
                .map_err(|error| format!("Spaces upload address is invalid: {error}"))?;
            endpoint
                .query_pairs_mut()
                .append_pair("filename", &file_name)
                .append_pair("projectId", project_id.trim());
            let file = std::fs::File::open(&upload_path)
                .map_err(|error| format!("could not open {}: {error}", upload_path.display()))?;
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .map_err(|error| format!("could not prepare the media upload: {error}"))?;
            let response = client
                .post(endpoint)
                .bearer_auth(token.trim())
                .header(reqwest::header::CONTENT_TYPE, &content_type)
                .header(reqwest::header::CONTENT_LENGTH, upload_metadata.len())
                .body(reqwest::blocking::Body::sized(file, upload_metadata.len()))
                .send()
                .map_err(|error| format!("Spaces could not upload the media file: {error}"))?;
            let status = response.status();
            let payload = response
                .json::<PortalMediaResponse>()
                .map_err(|error| format!("Spaces returned an invalid upload response: {error}"))?;
            if !status.is_success() {
                return Err(payload
                    .error
                    .unwrap_or_else(|| format!("Spaces rejected the upload ({status}).")));
            }
            payload
                .media
                .ok_or_else(|| "Spaces did not return the uploaded media URL.".into())
        })();
        if let Some(path) = converted_path {
            let _ = std::fs::remove_file(path);
        }
        result
    })
    .await
    .map_err(|error| format!("media upload task failed: {error}"))?
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

/// Every harness binary Spaces knows how to launch, plus the two tools it needs
/// itself. Keyed by *executable*, which is not always the harness id — the
/// Cursor harness is `cursor` and its binary is `cursor-agent`.
///
/// The registry in desktop/src/capabilities.ts is the source of truth; this is
/// its executable list, and tests/coordination.test.ts fails if the two drift.
const HARNESS_BINS: [&str; 5] = ["claude", "codex", "cursor-agent", "gh", "node"];

/* ── Reading what other agents already did ─────────────────────── */

// Claude Code and Codex both keep every session on this Mac as JSONL, keyed by
// the directory the work happened in. That is a complete record of the context
// somebody already has — and until now Spaces started every project from
// nothing while thousands of sessions sat on the same disk.
//
// Scanning is separated from reading on purpose. A scan touches ~3,000 files
// and has to feel instant, so it reads the head of each one and takes the rest
// from the directory entry. Reading a transcript is only done for sessions
// somebody is actually importing.

/// How far into a session file a scan will read before giving up on it.
///
/// A scan stops the moment it has the two things it needs — the working
/// directory and a title — which for almost every file is within a handful of
/// records. The caps are for the rest.
///
/// They are not generous by accident. A fixed 64 KB window looked ample and
/// silently lost the title of 998 Codex sessions out of 1,307: Codex opens
/// with a `session_meta` record carrying the model's entire base instructions,
/// which on its own can run past 64 KB, so the first thing the user actually
/// said lands beyond the window. Reading until the answer appears, rather than
/// reading a guessed amount and hoping, costs nothing for the common file and
/// recovers the rest.
const SCAN_BYTES: usize = 1_000_000;
const SCAN_LINES: usize = 600;

/// How long to keep looking for a better title once a usable one exists.
///
/// Claude Code names a session itself and writes that name as an `ai-title`
/// record — but only after the conversation has started, so it is always
/// behind the opening prompt. Stopping at the prompt would mean never seeing
/// the name the person actually recognises from Claude Code's own list.
const TITLE_GRACE: usize = 60;

/// The longest a single turn may be once imported.
///
/// A pasted file or a long tool result can run to hundreds of kilobytes, which
/// is real content but not conversation. Truncating keeps a transcript legible
/// and the database a sensible size; the original file is never modified and
/// stays the complete record.
const TURN_LIMIT: usize = 8_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    /// Which agent wrote it: "claude" or "codex".
    source: String,
    /**
     * What identifies this session, which is its *file*, not the id inside it.
     *
     * Codex reuses `session_id` across every rollout a conversation resumes
     * into: 1,307 files on this machine carry only 251 distinct ids, one of
     * them shared by 212 files. Keying on that would have thrown away four
     * fifths of the Codex history and, worse, made a re-import delete the
     * siblings of whichever file it happened to read last. The file stem is
     * unique in both formats — for Claude Code it *is* the session id — so
     * that is the identity.
     */
    id: String,
    /// The id the session records for itself, which several files may share.
    /// Kept because it is how the agent's own tooling refers to a
    /// conversation; never used as a key.
    session_id: String,
    /// Absolute path, so importing does not have to search again.
    path: String,
    /// The directory the work happened in. This is what makes a session
    /// belong to a project rather than to a machine.
    cwd: String,
    /// The session's own title where it has one, else its opening prompt.
    title: String,
    /// Milliseconds since the epoch; 0 when the file carried no timestamp.
    started_at: i64,
    /// Last write, from the directory entry — near enough to when it ended,
    /// and free.
    ended_at: i64,
    bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionTurn {
    /// "user" or "assistant".
    role: String,
    text: String,
    at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionTranscript {
    source: String,
    /// The file's identity — see `SessionSummary::id`.
    id: String,
    session_id: String,
    cwd: String,
    title: String,
    started_at: i64,
    ended_at: i64,
    turns: Vec<SessionTurn>,
}

/// `2026-07-07T22:14:16.211Z` to milliseconds, without pulling in a date crate.
///
/// Both formats write RFC 3339 in UTC and nothing else, so this parses exactly
/// that and returns 0 rather than guessing at anything it does not recognise —
/// a wrong timestamp would sort a transcript into nonsense.
fn iso_millis(text: &str) -> i64 {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return 0;
    }
    let num = |from: usize, to: usize| -> i64 { text[from..to].parse().unwrap_or(-1) };
    let (y, mo, d) = (num(0, 4), num(5, 7), num(8, 10));
    let (h, mi, s) = (num(11, 13), num(14, 16), num(17, 19));
    if y < 1970 || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    // 60 seconds is allowed: a leap second is a real timestamp, not a typo.
    if !(0..=23).contains(&h) || !(0..=59).contains(&mi) || !(0..=60).contains(&s) {
        return 0;
    }
    // Days from the civil calendar, by Howard Hinnant's algorithm: exact for
    // every proleptic Gregorian date and no leap-year special cases.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let millis = text
        .get(19..)
        .and_then(|rest| rest.strip_prefix('.'))
        .map(|frac| {
            let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
            let mut value: i64 = digits.get(..3).unwrap_or(&digits).parse().unwrap_or(0);
            for _ in digits.len()..3 {
                value *= 10;
            }
            value
        })
        .unwrap_or(0);

    ((days * 24 + h) * 60 + mi) * 60_000 + s * 1_000 + millis
}

/// Last-modified, in milliseconds.
fn modified_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Every `.jsonl` under a root, at any depth.
///
/// Codex files them by date — `sessions/2026/07/01/rollout-*.jsonl` — and
/// Claude Code by encoded working directory, one level down. One recursive
/// walk handles both and will keep handling both if either changes its mind.
fn jsonl_files(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 || out.len() > 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => jsonl_files(&path, out, depth + 1),
            Ok(t) if t.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") => {
                out.push(path);
            }
            _ => {}
        }
    }
}

/// Flatten a message body to plain text.
///
/// Both formats allow a string or a list of blocks, and the blocks that matter
/// are the ones with text in them. Thinking and tool calls are deliberately
/// dropped: they are the agent talking to itself, they dwarf the conversation,
/// and what is wanted here is what was asked and what was answered.
fn block_text(value: &serde_json::Value) -> String {
    if let Some(text) = value.as_str() {
        return text.trim().to_string();
    }
    let Some(items) = value.as_array() else { return String::new() };
    let mut parts: Vec<String> = Vec::new();
    for item in items {
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(kind, "thinking" | "tool_use" | "tool_result" | "reasoning") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    parts.join("\n\n")
}

/// The first line of a message that a person actually wrote.
///
/// Codex opens most sessions by injecting blocks of its own into the first
/// user message — `<recommended_plugins>`, `<user_instructions>`,
/// `<environment_context>` — so taking "the first line of the first user turn"
/// titles a session `<recommended_plugins>`, which says nothing about it and
/// is the same for hundreds of sessions. Skipping a leading tag and the block
/// it opens finds the sentence underneath.
///
/// Anything that is not that shape is returned as-is: a prompt is allowed to
/// start with a less-than sign, and only a line that is *entirely* a tag is
/// treated as one.
fn first_prose_line(text: &str) -> String {
    let mut inside: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(tag) = &inside {
            if line == format!("</{tag}>") {
                inside = None;
            }
            continue;
        }
        if line.starts_with('<') && line.ends_with('>') && !line.starts_with("</") {
            let name: String = line[1..line.len() - 1]
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_string();
            let tagish = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            if tagish {
                // A self-closing tag opens no block.
                if !line.ends_with("/>") {
                    inside = Some(name);
                }
                continue;
            }
        }
        return line.chars().take(160).collect();
    }
    String::new()
}

/// Keep a turn to a readable size, on a character boundary.
fn clamp(text: String) -> String {
    if text.chars().count() <= TURN_LIMIT {
        return text;
    }
    let kept: String = text.chars().take(TURN_LIMIT).collect();
    format!("{kept}\n\n… truncated — the full session is in the original file.")
}

/// What a scan can learn from the head of one file.
fn summarise(path: &Path, source: &str) -> Option<SessionSummary> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut cwd = String::new();
    let mut title = String::new();
    let mut id = String::new();
    let mut started_at = 0i64;
    let mut used = 0usize;
    // Whether the title came from the agent naming the session, rather than
    // from falling back to its opening prompt.
    let mut named = false;

    for (seen, line) in std::io::BufRead::lines(reader).enumerate() {
        // Stop as soon as there is nothing left to learn, which for nearly
        // every file is the first few records — but hold on a little longer
        // when the title is only a fallback and this format has a real one.
        let settled = named || source != "claude" || seen >= TITLE_GRACE;
        if !cwd.is_empty() && !title.is_empty() && settled {
            break;
        }
        let Ok(line) = line else { break };
        used += line.len();
        if seen >= SCAN_LINES || used >= SCAN_BYTES {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let kind = record.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if started_at == 0 {
            if let Some(stamp) = record.get("timestamp").and_then(|v| v.as_str()) {
                started_at = iso_millis(stamp);
            }
        }

        match source {
            "claude" => {
                if cwd.is_empty() {
                    if let Some(value) = record.get("cwd").and_then(|v| v.as_str()) {
                        cwd = value.to_string();
                    }
                }
                if id.is_empty() {
                    if let Some(value) = record.get("sessionId").and_then(|v| v.as_str()) {
                        id = value.to_string();
                    }
                }
                // The agent's own title beats the opening prompt, and beats one
                // already taken from it.
                if kind == "ai-title" {
                    if let Some(value) = record.get("aiTitle").and_then(|v| v.as_str()) {
                        if !value.trim().is_empty() {
                            title = value.trim().to_string();
                            named = true;
                        }
                    }
                } else if kind == "user" && title.is_empty() {
                    let body = record.get("message").and_then(|m| m.get("content"));
                    if let Some(body) = body {
                        let line = first_prose_line(&block_text(body));
                        if !line.is_empty() {
                            title = line;
                        }
                    }
                }
            }
            _ => {
                if kind == "session_meta" {
                    let payload = record.get("payload");
                    if let Some(payload) = payload {
                        if let Some(value) = payload.get("cwd").and_then(|v| v.as_str()) {
                            cwd = value.to_string();
                        }
                        if let Some(value) = payload.get("session_id").and_then(|v| v.as_str()) {
                            id = value.to_string();
                        }
                        if started_at == 0 {
                            if let Some(stamp) = payload.get("timestamp").and_then(|v| v.as_str()) {
                                started_at = iso_millis(stamp);
                            }
                        }
                    }
                } else if kind == "response_item" && title.is_empty() {
                    let payload = record.get("payload");
                    let is_user = payload
                        .and_then(|p| p.get("role"))
                        .and_then(|v| v.as_str())
                        == Some("user");
                    if is_user {
                        if let Some(content) = payload.and_then(|p| p.get("content")) {
                            let line = first_prose_line(&block_text(content));
                            if !line.is_empty() {
                                title = line;
                            }
                        }
                    }
                }
            }
        }
    }

    let file_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    if file_id.is_empty() {
        return None;
    }
    // A session with no working directory cannot be placed in a project, and a
    // project is the whole point — so it is not offered rather than offered
    // wrongly.
    if cwd.trim().is_empty() {
        return None;
    }

    let title = title.chars().take(160).collect::<String>();
    Some(SessionSummary {
        source: source.to_string(),
        id: file_id,
        session_id: id,
        path: path.to_string_lossy().to_string(),
        cwd,
        title,
        started_at,
        ended_at: modified_millis(&meta),
        bytes: meta.len(),
    })
}

/// Every Claude Code and Codex session on this Mac, with the directory each
/// one belongs to.
///
/// Returns what it can read and says nothing about what it cannot: an
/// unreadable or half-written file is skipped, because a scan that fails
/// because one session of three thousand is malformed is useless.
#[tauri::command]
async fn scan_agent_sessions() -> Result<Vec<SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = std::env::var("HOME").map_err(|_| "no home directory".to_string())?;
        let mut found: Vec<SessionSummary> = Vec::new();

        for (source, root) in [
            ("claude", PathBuf::from(&home).join(".claude").join("projects")),
            ("codex", PathBuf::from(&home).join(".codex").join("sessions")),
        ] {
            if !root.is_dir() {
                continue;
            }
            let mut files = Vec::new();
            jsonl_files(&root, &mut files, 0);
            for path in files {
                if let Some(summary) = summarise(&path, source) {
                    found.push(summary);
                }
            }
        }

        // Newest first: the sessions somebody wants are the recent ones, and
        // this is the order every caller would otherwise impose itself.
        found.sort_by_key(|s| std::cmp::Reverse(s.ended_at));
        Ok(found)
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// One session in full, as an alternating conversation.
#[tauri::command]
async fn read_agent_session(path: String, source: String) -> Result<SessionTranscript, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;
        let file = std::fs::File::open(&path).map_err(|e| format!("could not open {path}: {e}"))?;
        let meta = std::fs::metadata(&path).ok();
        let reader = std::io::BufReader::new(file);

        let mut turns: Vec<SessionTurn> = Vec::new();
        let mut cwd = String::new();
        let mut title = String::new();
        let mut id = String::new();
        let mut started_at = 0i64;
        let mut last_at = 0i64;

        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let kind = record.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let at = record
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(iso_millis)
                .unwrap_or(0);
            if at > 0 {
                if started_at == 0 {
                    started_at = at;
                }
                last_at = at;
            }

            if source == "claude" {
                if cwd.is_empty() {
                    if let Some(value) = record.get("cwd").and_then(|v| v.as_str()) {
                        cwd = value.to_string();
                    }
                }
                if id.is_empty() {
                    if let Some(value) = record.get("sessionId").and_then(|v| v.as_str()) {
                        id = value.to_string();
                    }
                }
                if kind == "ai-title" {
                    if let Some(value) = record.get("aiTitle").and_then(|v| v.as_str()) {
                        if !value.trim().is_empty() {
                            title = value.trim().to_string();
                        }
                    }
                    continue;
                }
                if kind != "user" && kind != "assistant" {
                    continue;
                }
                let Some(body) = record.get("message").and_then(|m| m.get("content")) else { continue };
                let text = block_text(body);
                if text.is_empty() {
                    continue;
                }
                if title.is_empty() && kind == "user" {
                    title = first_prose_line(&text);
                }
                turns.push(SessionTurn { role: kind.to_string(), text: clamp(text), at });
            } else {
                if kind == "session_meta" {
                    if let Some(payload) = record.get("payload") {
                        if let Some(value) = payload.get("cwd").and_then(|v| v.as_str()) {
                            cwd = value.to_string();
                        }
                        if let Some(value) = payload.get("session_id").and_then(|v| v.as_str()) {
                            id = value.to_string();
                        }
                        if started_at == 0 {
                            if let Some(stamp) = payload.get("timestamp").and_then(|v| v.as_str()) {
                                started_at = iso_millis(stamp);
                            }
                        }
                    }
                    continue;
                }
                if kind != "response_item" {
                    continue;
                }
                let Some(payload) = record.get("payload") else { continue };
                if payload.get("type").and_then(|v| v.as_str()) != Some("message") {
                    continue;
                }
                let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }
                let Some(content) = payload.get("content") else { continue };
                let text = block_text(content);
                if text.is_empty() {
                    continue;
                }
                if title.is_empty() && role == "user" {
                    title = first_prose_line(&text);
                }
                turns.push(SessionTurn { role: role.to_string(), text: clamp(text), at });
            }
        }

        let file_id = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let ended_at = if last_at > 0 {
            last_at
        } else {
            meta.as_ref().map(modified_millis).unwrap_or(0)
        };

        Ok(SessionTranscript {
            source,
            id: file_id,
            session_id: id,
            cwd,
            title: title.chars().take(160).collect(),
            started_at,
            ended_at,
            turns,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/* ── Accessibility permission ──────────────────────────────────── */

// Driving another application needs the Accessibility grant, and there is a
// real API for both asking and checking. The alternative — inferring it from
// whether `System Events` answers within a timeout — cannot tell a denied
// permission from a busy machine, and takes seconds to be wrong.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // CoreFoundation's `Boolean` is an unsigned char, not C's `_Bool`. Reading
    // it as a Rust `bool` is undefined behaviour for any value other than 0 or
    // 1, and silently wrong rather than loudly wrong.
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> u8;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}

/// Whether Spaces may drive other applications. Instant, and never prompts.
#[tauri::command]
fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Ask for the Accessibility grant, with macOS's own dialog.
///
/// Worth preferring over sending somebody to System Settings by hand: the
/// system prompt deep-links to the right pane *and* registers the app in the
/// list, so the whole task becomes one toggle instead of finding a hidden
/// window, clicking +, and typing a path into a file picker.
///
/// Returns the trust state as it is *now*. It is almost always false on the
/// first call — the dialog is not modal and the grant lands later — so callers
/// poll `accessibility_trusted` rather than believing this answer.
#[tauri::command]
fn request_accessibility() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0
    }
}

/* ── Driving an app Spaces cannot launch ───────────────────────── */

// Everything below runs *in this process* on purpose.
//
// The obvious implementation shells out to `osascript`, and it does not work:
// macOS attributes the Accessibility check to the child, so the script is
// refused with "osascript is not allowed assistive access (-25211)" no matter
// how thoroughly Spaces itself has been granted the permission. Whoever grants
// it would have no way to tell why. Calling the same APIs directly means the
// process being checked is the one the user allowed.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> core_foundation::base::CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: core_foundation::base::CFTypeRef,
        attribute: core_foundation::string::CFStringRef,
        value: *mut core_foundation::base::CFTypeRef,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: core_foundation::base::CFTypeRef,
        attribute: core_foundation::string::CFStringRef,
        value: core_foundation::base::CFTypeRef,
    ) -> i32;
    fn AXValueGetValue(
        value: core_foundation::base::CFTypeRef,
        the_type: u32,
        out: *mut std::ffi::c_void,
    ) -> bool;
}

const AX_VALUE_CGPOINT: u32 = 1;
const AX_VALUE_CGSIZE: u32 = 2;

/// The frontmost app's process id, so focus can be handed back afterwards.
///
/// `lsappinfo`, not AppleScript: asking System Events who is in front is
/// itself an accessibility operation attributed to the child process, which is
/// the trap this whole module exists to avoid. Launch Services will answer the
/// same question without any permission at all.
fn frontmost_pid() -> Option<i32> {
    let front = Command::new("/usr/bin/lsappinfo").arg("front").output().ok()?;
    let asn = String::from_utf8_lossy(&front.stdout).trim().to_string();
    if asn.is_empty() {
        return None;
    }
    let info = Command::new("/usr/bin/lsappinfo")
        .args(["info", "-only", "pid", &asn])
        .output()
        .ok()?;
    // Answers as `"pid"=1234`; the number is the only digits in it.
    String::from_utf8_lossy(&info.stdout)
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

/// Ask an AX element for one attribute, as a retained value.
///
/// `AXUIElementCopyAttributeValue` follows the Create Rule, so the result owns
/// a reference. Wrapping it in `CFType` is what makes a tree walk safe: raw
/// `CFTypeRef`s handed around by hand either leak on every node or dangle once
/// the array they came from is dropped.
unsafe fn ax_get(element: &core_foundation::base::CFType, name: &str) -> Option<core_foundation::base::CFType> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    let key = CFString::new(name);
    let mut value: core_foundation::base::CFTypeRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(element.as_CFTypeRef(), key.as_concrete_TypeRef(), &mut value) != 0 {
        return None;
    }
    if value.is_null() { None } else { Some(CFType::wrap_under_create_rule(value)) }
}

/// An AX attribute as a string, for roles and for reading a field back.
unsafe fn ax_string(element: &core_foundation::base::CFType, name: &str) -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    let value = ax_get(element, name)?;
    if value.type_of() != CFString::type_id() {
        return None;
    }
    Some(CFString::wrap_under_get_rule(value.as_CFTypeRef() as CFStringRef).to_string())
}

/// An AX element's children, or an empty list for a leaf.
unsafe fn ax_children(element: &core_foundation::base::CFType) -> Vec<core_foundation::base::CFType> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    let Some(value) = ax_get(element, "AXChildren") else { return Vec::new() };
    if value.type_of() != CFArray::<CFType>::type_id() {
        return Vec::new();
    }
    let list = CFArray::<CFType>::wrap_under_get_rule(value.as_CFTypeRef() as _);
    list.iter().map(|item| item.clone()).collect()
}

/// An element's rectangle in screen points: x, y, width, height.
unsafe fn ax_frame(element: &core_foundation::base::CFType) -> Option<(f64, f64, f64, f64)> {
    use core_foundation::base::TCFType;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Pair { a: f64, b: f64 }

    let pos = ax_get(element, "AXPosition")?;
    let size = ax_get(element, "AXSize")?;
    let mut point = Pair::default();
    let mut extent = Pair::default();
    let ok_point = AXValueGetValue(pos.as_CFTypeRef(), AX_VALUE_CGPOINT, &mut point as *mut _ as *mut _);
    let ok_size = AXValueGetValue(size.as_CFTypeRef(), AX_VALUE_CGSIZE, &mut extent as *mut _ as *mut _);
    if !ok_point || !ok_size {
        return None;
    }
    Some((point.a, point.b, extent.a, extent.b))
}

/// The window Spaces should aim at.
///
/// Not `AXWindows[0]`: an app that has been running a while has more than one
/// window, and the order is arbitrary. Muse keeps a stale "Log in" window on
/// another Space — first in the list, 1200 points wide, and completely wrong.
/// Focused first, then main, and only then the arbitrary one.
unsafe fn target_window(app: &core_foundation::base::CFType) -> Option<core_foundation::base::CFType> {
    for attribute in ["AXFocusedWindow", "AXMainWindow"] {
        if let Some(window) = ax_get(app, attribute) {
            if ax_frame(&window).is_some() {
                return Some(window);
            }
        }
    }
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    let value = ax_get(app, "AXWindows")?;
    if value.type_of() != CFArray::<CFType>::type_id() {
        return None;
    }
    let list = CFArray::<CFType>::wrap_under_get_rule(value.as_CFTypeRef() as _);
    list.get(0).map(|item| item.clone())
}

/// A text box in a window, and where it is.
struct Composer {
    element: core_foundation::base::CFType,
    frame: (f64, f64, f64, f64),
}

/// How deep to walk, and how many nodes to look at.
///
/// A chat window's accessibility tree contains every message ever rendered —
/// Muse's runs to several thousand nodes, and does not contain its composer at
/// all. The depth is generous because an Electron window is a web
/// page: the composer in one sits twenty-odd levels down inside wrappers that
/// a native app would not have. Finding it is a bonus, not the mechanism —
/// what it buys is a box Spaces can focus precisely and then read back, rather
/// than trusting the app to have focused the right thing. Not finding one
/// costs nothing but the search.
const WALK_DEPTH: usize = 32;
const WALK_NODES: usize = 2500;
/// And how long to spend, which is the cap that actually bites.
///
/// Every step of the walk is a call into another process, and an Electron chat
/// window can absorb thousands of them before admitting it has nothing — Muse
/// takes several seconds to say no. Since the search only buys a read-back,
/// not the send itself, it gets a fixed slice of time and no more.
const WALK_BUDGET: Duration = Duration::from_millis(300);

/// What has the caret right now, as text.
///
/// The one question that matters after a click, and the one the tree walk can
/// get wrong: this is the element about to receive the keystrokes, whatever it
/// is and however deep it lives. Apps that bury their composer past any
/// sensible walk still answer this.
unsafe fn focused_text(app: &core_foundation::base::CFType) -> Option<String> {
    let focused = ax_get(app, "AXFocusedUIElement")?;
    ax_string(&focused, "AXValue")
}

/// Find the message box in a window, by looking for one.
///
/// Optional, and worth doing anyway. Raising a chat app already puts the caret
/// in its message box, so this is not how the text is aimed — but an element
/// found here can be focused explicitly and, more to the point, read back
/// afterwards. That is the whole difference between reporting that a send
/// worked and knowing it did.
///
/// The heuristic is deliberately narrow, because a wrong text field is worse
/// than none: an editable text area reaching into the bottom two fifths of the
/// window, wide enough to be a composer rather than a search box. Ties go to the lowest,
/// then the widest — a chat window's composer is the bottom-most thing you can
/// type into.
unsafe fn find_composer(window: &core_foundation::base::CFType) -> Option<Composer> {
    let (wx, wy, ww, wh) = ax_frame(window)?;
    if ww <= 0.0 || wh <= 0.0 {
        return None;
    }
    let floor = wy + wh * 0.6;

    let mut best: Option<Composer> = None;
    let mut stack = vec![(window.clone(), 0usize)];
    let mut seen = 0usize;
    let deadline = Instant::now() + WALK_BUDGET;

    while let Some((element, depth)) = stack.pop() {
        seen += 1;
        // Checked every 32 nodes: reading the clock is cheap, but not as cheap
        // as the arithmetic it would otherwise dominate.
        if seen > WALK_NODES || (seen.is_multiple_of(32) && Instant::now() > deadline) {
            break;
        }

        let frame = ax_frame(&element);

        /*
         * Prune by geometry before doing anything else.
         *
         * A container's rectangle encloses its children, so one entirely above
         * the composer line cannot hold the composer — and in a chat window
         * that is every message ever rendered. Without this the walk visits
         * thousands of nodes over a process boundary and takes seconds to
         * conclude nothing; with it, it visits the bottom strip and finishes
         * in the noise. The scroll container itself is not pruned, which is
         * correct: it spans the window, so it might.
         */
        if let Some((_, y, _, h)) = frame {
            if h > 0.0 && y + h < floor {
                continue;
            }
        }

        if let Some((x, y, w, h)) = frame {
            let role = ax_string(&element, "AXRole").unwrap_or_default();
            let entry = role == "AXTextArea" || role == "AXTextField";
            let fits = w >= 120.0
                && h >= 14.0
                && h <= wh * 0.5
                && y + h >= floor
                && x >= wx - 1.0
                && x + w <= wx + ww + 1.0;
            if entry && fits {
                let better = match &best {
                    None => true,
                    Some(current) => {
                        let (_, cy, cw, ch) = current.frame;
                        (y + h, w) > (cy + ch, cw)
                    }
                };
                if better {
                    best = Some(Composer { element: element.clone(), frame: (x, y, w, h) });
                }
            }
        }

        if depth < WALK_DEPTH {
            for child in ax_children(&element) {
                stack.push((child, depth + 1));
            }
        }
    }

    best
}

/// Bring an application forward without launching anything.
unsafe fn raise(app: &core_foundation::base::CFType) {
    ax_set_true(app, "AXFrontmost");
}

/// Activate an app the way clicking its Dock icon does.
///
/// `AXFrontmost` raises the window; it does not reliably make the app *active*
/// — and the difference is the whole feature. An app decides what has the
/// caret when it becomes active, which for a chat window means its message
/// box. Muse raised by `AXFrontmost` alone took the paste nowhere; the same
/// app activated properly put it straight in the composer.
///
/// `open` is a subprocess, which everything else in this module avoids. It is
/// allowed here for the same reason `lsappinfo` is: activation goes through
/// Launch Services, not the accessibility API, so there is no permission to be
/// attributed to the wrong process. `-g` is deliberately *not* passed —
/// bringing the app forward is the point — and the app is known to be running
/// already, so nothing is launched.
fn activate(bundle_id: &str, name: &str) {
    let mut command = Command::new("/usr/bin/open");
    if bundle_id.trim().is_empty() {
        command.arg("-a").arg(name);
    } else {
        command.arg("-b").arg(bundle_id.trim());
    }
    let _ = command.output();
}

/// Set a boolean AX attribute, for the two things worth asking for directly:
/// which app is in front, and which element has the caret.
unsafe fn ax_set_true(element: &core_foundation::base::CFType, name: &str) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;
    let key = CFString::new(name);
    AXUIElementSetAttributeValue(
        element.as_CFTypeRef(),
        key.as_concrete_TypeRef(),
        CFBoolean::true_value().as_CFTypeRef(),
    ) == 0
}

/// A single left click at a screen point.
fn click(x: f64, y: f64) {
    use core_graphics::event::{CGEvent, CGEventType, CGMouseButton};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else { return };
    let at = CGPoint::new(x, y);
    for kind in [CGEventType::LeftMouseDown, CGEventType::LeftMouseUp] {
        if let Ok(event) = CGEvent::new_mouse_event(source.clone(), kind, at, CGMouseButton::Left) {
            event.post(core_graphics::event::CGEventTapLocation::HID);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Where to click in a window that will not say where its message box is.
///
/// Measured from the window, every time, so there is nothing to store and
/// nothing to re-measure when the window moves or resizes. The two constants
/// describe the shape of a chat window rather than any particular app: the
/// composer is the bottom strip, and it lives in the *first* column — the
/// conversation — because that is what the reading order of a chat client is.
/// A window wide enough to hold a second panel puts that panel to the right,
/// so aiming near the left edge stays inside the conversation.
///
/// Checked against Muse: a 1101-point window whose composer spans 100 to 529
/// points from the left and sits 30 points off the bottom.
///
/// This is a last resort and is treated as one. An app that publishes its
/// message box gets clicked in the middle of that box instead, which is exact.
fn composer_guess(wx: f64, wy: f64, ww: f64, wh: f64) -> (f64, f64) {
    (wx + (ww * 0.25).min(160.0), wy + wh - 40.0)
}

/// Press one key, optionally with command held.
fn key(code: u16, command: bool) {
    use core_graphics::event::{CGEvent, CGEventFlags};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else { return };
    for down in [true, false] {
        if let Ok(event) = CGEvent::new_keyboard_event(source.clone(), code, down) {
            if command {
                event.set_flags(CGEventFlags::CGEventFlagCommand);
            }
            event.post(core_graphics::event::CGEventTapLocation::HID);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

const KEY_V: u16 = 9;
const KEY_RETURN: u16 = 36;

/// Put text on the clipboard, returning whatever was there before.
///
/// `LC_CTYPE` is not a detail. `pbcopy` and `pbpaste` encode according to it,
/// and a GUI app launched by launchd inherits no locale at all — so without
/// this they fall back to Mac OS Roman and every character above ASCII arrives
/// mangled. An em dash pasted into Muse came out as `‚Äî`, which is exactly
/// what UTF-8 looks like when it is read one byte at a time.
fn set_clipboard(text: &str) -> String {
    let previous = Command::new("/usr/bin/pbpaste")
        .env("LC_CTYPE", "UTF-8")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    write_clipboard(text);
    previous
}

/// Put the clipboard back, unless there is nothing to put back.
///
/// An empty read does not mean an empty clipboard — it means no *text* on it.
/// Somebody who had copied an image or a file would otherwise find it replaced
/// by nothing, because Spaces sent a message.
fn restore_clipboard(previous: &str) {
    if !previous.is_empty() {
        write_clipboard(previous);
    }
}

fn write_clipboard(text: &str) {
    if let Ok(mut child) = Command::new("/usr/bin/pbcopy")
        .env("LC_CTYPE", "UTF-8")
        .stdin(std::process::Stdio::piped())
        .spawn()
    {
        if let Some(mut sink) = child.stdin.take() {
            use std::io::Write;
            let _ = sink.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}

#[derive(serde::Serialize)]
struct AppSendResult {
    /// Spaces raised the app and pasted. On its own this means the keystrokes
    /// were posted, not that they arrived — see `verified`.
    delivered: bool,
    /// The message box was read back and had the text in it. The only field
    /// that means the message arrived; false for an app that does not publish
    /// its message box, where nobody but a human can tell.
    verified: bool,
    /// How the text was aimed: "composer" when Spaces found the message box in
    /// the app's own window contents, "shape" when the app publishes nothing
    /// and Spaces went by where a chat window keeps its composer.
    method: String,
    /// What went wrong, in a sentence the UI can show as-is.
    problem: String,
    /// The app that was frontmost before, so the UI can say what it interrupted.
    previous_app: String,
    /// The target window, in screen points: x, y, width, height.
    window: [f64; 4],
    /// The message box, when one was found: x, y, width, height. Zeroes when
    /// the app publishes nothing.
    composer: [f64; 4],
    /// Where Spaces clicked, in screen points — so a miss is measurable
    /// instead of mysterious.
    clicked: [f64; 2],
}

/// Type a message into another application's composer and optionally send it.
///
/// This exists because some agents have no other door. Muse has no CLI, no
/// scripting dictionary, no local port, no local database, and its `hatch://`
/// scheme drops every host it is handed. Its threads live on Meta's servers
/// behind an authenticated socket. Typing into the window is not a shortcut
/// past an API — it is the only interface the app has.
///
/// It does not click anything, and it stores no coordinates.
///
/// That was the first design and it was wrong: an offset from the window's
/// bottom-left corner cannot be got right without a screenshot and some
/// arithmetic, it is wrong again the moment a toolbar or a side panel appears,
/// and being wrong looks exactly like the permission being missing. It was
/// also unnecessary. A chat window puts the caret in its message box when you
/// switch to it — that is what makes it a chat window — so raising the app is
/// the whole of "aim". Muse focuses its composer on activation; so do Slack,
/// Messages and every other app in this shape.
///
/// Where the app does publish its message box, Spaces focuses that element
/// directly and reads it back afterwards, which is the difference between
/// believing the send worked and knowing it did.
///
/// Text arrives by clipboard rather than keystroke: a brief is longer than
/// anyone wants typed one event at a time, and paste cannot interleave with
/// whatever the app does between characters. The previous clipboard goes back.
#[tauri::command]
async fn send_to_app(
    bundle_id: String,
    app_name: String,
    text: String,
    submit: bool,
) -> Result<AppSendResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = if app_name.trim().is_empty() {
            bundle_id.trim().to_string()
        } else {
            app_name.trim().to_string()
        };
        if name.is_empty() {
            return Err("no application named".to_string());
        }
        if text.trim().is_empty() {
            return Err("nothing to send".to_string());
        }

        let fail = |problem: String| {
            Ok(AppSendResult {
                delivered: false,
                verified: false,
                method: String::new(),
                problem,
                previous_app: String::new(),
                window: [0.0; 4],
                composer: [0.0; 4],
                clicked: [0.0; 2],
            })
        };

        // pgrep, not AX: finding the process is not an accessibility operation,
        // and the executable inside an .app bundle is named after the bundle.
        let pid: i32 = match Command::new("/usr/bin/pgrep").arg("-x").arg(&name).output() {
            Ok(out) => match String::from_utf8_lossy(&out.stdout).lines().next() {
                Some(line) => match line.trim().parse() {
                    Ok(value) => value,
                    Err(_) => return fail(format!("{name} is not running.")),
                },
                None => return fail(format!("{name} is not running, so there was nowhere to put the message.")),
            },
            Err(e) => return fail(format!("could not look for {name}: {e}")),
        };

        let was_front = frontmost_pid();
        /*
         * The clipboard is loaded first, before anything is activated or
         * clicked, and put back last.
         *
         * Setting it just before pressing ⌘V looks tidier and is a race. A
         * synthetic keystroke is delivered asynchronously, and an app that has
         * just been brought forward can take most of a second to get round to
         * it — long enough that Muse pasted whatever had been on the clipboard
         * *before* the send, having read the pasteboard after Spaces put the
         * old contents back. Widening the window on both sides costs nothing
         * and removes the race rather than shortening it.
         */
        let previous_clipboard = set_clipboard(&text);
        let frame;
        let mut box_frame = [0.0f64; 4];
        let point;
        let method;
        // Three states, not two: `None` is "could not tell", which is a
        // different thing from "looked and it was not there" and leads to
        // different wording — and to whether return is pressed at all.
        let seen: Option<bool>;

        unsafe {
            use core_foundation::base::{CFType, TCFType};
            let raw = AXUIElementCreateApplication(pid);
            if raw.is_null() {
                return fail(format!("macOS would not describe {name}'s windows."));
            }
            let app = CFType::wrap_under_create_rule(raw);
            raise(&app);
            activate(&bundle_id, &name);
            // Long enough for the app to come forward and put the caret where
            // it puts it. This is the aiming step, and the only one.
            std::thread::sleep(Duration::from_millis(500));

            let Some(window) = target_window(&app) else {
                return fail(format!("{name} is running but has no window Spaces can address."));
            };
            let Some((wx, wy, ww, wh)) = ax_frame(&window) else {
                return fail(format!("{name}'s window would not say where it is."));
            };
            frame = [wx, wy, ww, wh];

            /*
             * Put the caret in the message box.
             *
             * Setting `AXFocused` is the polite way and works when the app
             * publishes the element. When it does not — Muse's composer is
             * absent from its accessibility tree entirely — a click is the
             * only thing that focuses a web composer: activating the app does
             * not, and Muse will swallow every keystroke sent to an unfocused
             * window without a word. So click either way, at the box when
             * there is one and at the shape of a chat window when there is
             * not.
             */
            let composer = find_composer(&window);
            let (cx, cy) = match &composer {
                Some(found) => {
                    let (x, y, w, h) = found.frame;
                    box_frame = [x, y, w, h];
                    method = "composer".to_string();
                    ax_set_true(&found.element, "AXFocused");
                    (x + w / 2.0, y + h / 2.0)
                }
                None => {
                    method = "shape".to_string();
                    composer_guess(wx, wy, ww, wh)
                }
            };
            point = [cx, cy];
            click(point[0], point[1]);
            std::thread::sleep(Duration::from_millis(220));

            key(KEY_V, true);
            std::thread::sleep(Duration::from_millis(700));

            /*
             * Read it back before sending, while there is still something to
             * read: submitting empties the box.
             *
             * The two sources are not equally trustworthy, and treating them
             * as though they were produces a confident lie. Reading the
             * composer found by the walk is authoritative both ways — it is
             * the right element by construction. Reading "whatever is focused"
             * only proves a positive: Muse reports a focused element that is
             * not its composer and never contains the text, so believing its
             * negative would report every successful send as a failure, and
             * would stop the real hand-off pressing return.
             *
             * So: a match from either source is proof. A mismatch is only
             * proof from the box itself; otherwise the answer is "cannot tell",
             * which is a thing this type can say.
             */
            seen = match composer.as_ref().and_then(|found| ax_string(&found.element, "AXValue")) {
                Some(value) => Some(contains_trimmed(&value, &text)),
                None => match focused_text(&app) {
                    Some(value) if contains_trimmed(&value, &text) => Some(true),
                    _ => None,
                },
            };

            // Don't press return into a box Spaces has just read and found
            // empty — that is the one case where sending is known to do
            // something other than send this message.
            if submit && seen != Some(false) {
                key(KEY_RETURN, false);
                std::thread::sleep(Duration::from_millis(250));
            }

            // Put the user back where they were. Stealing focus is unavoidable
            // — the app only accepts input when it is frontmost — but keeping
            // it is not.
            if let Some(back) = was_front {
                if back != pid {
                    let previous = AXUIElementCreateApplication(back);
                    if !previous.is_null() {
                        raise(&CFType::wrap_under_create_rule(previous));
                    }
                }
            }
        }

        restore_clipboard(&previous_clipboard);

        // Never a gate — only a note. macOS drops synthetic input from an
        // untrusted process without telling anyone, so an unverified send by a
        // process with no permission has an obvious first suspect.
        let trusted = unsafe { AXIsProcessTrusted() != 0 };
        let problem = match seen {
            Some(true) => String::new(),
            _ if !trusted => format!(
                "macOS reports no Accessibility permission for Spaces, so it may have dropped the \
                 paste. If nothing appeared in {name}, that is why."
            ),
            Some(false) => format!(
                "Spaces pasted into {name} and then read its message box, which did not contain \
                 the text. {name} may have had something else focused."
            ),
            None => format!(
                "{name} does not publish its message box, so Spaces clicked where a chat window \
                 keeps one and cannot read back what happened next. Look at {name} once: if the \
                 line is there, this works, and it will keep working — the point is measured from \
                 the window every time, so it follows the window around."
            ),
        };

        Ok(AppSendResult {
            delivered: true,
            verified: seen == Some(true),
            method,
            problem,
            previous_app: String::new(),
            window: frame,
            composer: box_frame,
            clicked: point,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Whether a composer's contents include what was pasted.
///
/// Not equality: a box that already had a draft in it keeps the draft, and
/// some apps normalise whitespace or newlines on the way in. Comparing the
/// first line is enough to tell "the paste landed" from "nothing happened",
/// which is the only question being asked.
fn contains_trimmed(seen: &str, sent: &str) -> bool {
    let needle: String = sent.trim().lines().next().unwrap_or_default().trim().to_string();
    if needle.is_empty() {
        return false;
    }
    seen.contains(&needle)
}

/// Which agent/GitHub CLIs are available on this machine.
#[tauri::command]
async fn check_tools() -> HashMap<String, bool> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut m = HashMap::new();
        for name in HARNESS_BINS {
            let found = std::path::Path::new(&resolve_bin(name)).is_absolute();
            m.insert(name.to_string(), found);
        }
        m
    })
    .await
    .unwrap_or_default()
}

/// Check a user-configured executable without launching it. Bare commands are
/// resolved against the same login-shell PATH used for agent runs; explicit
/// paths are checked directly.
#[tauri::command]
async fn check_program(program: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let program = program.trim();
        if program.is_empty() {
            return false;
        }
        let path = Path::new(program);
        if path.components().count() > 1 || path.is_absolute() {
            return path.is_file();
        }
        Path::new(&resolve_bin(program)).is_absolute()
    })
    .await
    .unwrap_or(false)
}

/// One harness probe: run a short, non-interactive command (`--version`,
/// `status`) and report what came back.
#[derive(serde::Serialize)]
struct ProbeResult {
    found: bool,
    path: String,
    exit_code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// Ask a harness about itself.
///
/// Deliberately narrow: no stdin, a hard wall-clock cap, and output truncated,
/// because this runs against third-party binaries whose `--version` may decide
/// to prompt, update itself, or print a megabyte of banner. A probe that hangs
/// would freeze the agent editor, so a timeout is a normal result rather than
/// an error.
#[tauri::command]
async fn probe_program(
    program: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<ProbeResult, String> {
    const MAX_OUTPUT: usize = 8 * 1024;
    let limit = Duration::from_millis(timeout_ms.unwrap_or(6_000).clamp(500, 30_000));

    tauri::async_runtime::spawn_blocking(move || {
        let program = program.trim().to_string();
        if program.is_empty() {
            return Err("no program given".to_string());
        }
        let resolved = if Path::new(&program).is_absolute() || Path::new(&program).components().count() > 1
        {
            program.clone()
        } else {
            resolve_bin(&program)
        };
        if !Path::new(&resolved).is_absolute() || !Path::new(&resolved).is_file() {
            return Ok(ProbeResult {
                found: false,
                path: String::new(),
                exit_code: -1,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
            });
        }

        let mut cmd = Command::new(&resolved);
        cmd.args(&args)
            .env("PATH", login_path())
            // Some CLIs render a progress UI when they think they own a
            // terminal; tell them plainly that they do not.
            .env("NO_COLOR", "1")
            .env("CI", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("failed to launch: {e}"))?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if started.elapsed() >= limit {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
                Err(e) => return Err(format!("probe failed: {e}")),
            }
        };

        let out = child
            .wait_with_output()
            .map_err(|e| format!("probe did not finish: {e}"))?;
        let clip = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes).to_string();
            if text.len() > MAX_OUTPUT {
                format!("{}…", &text[..MAX_OUTPUT])
            } else {
                text
            }
        };
        Ok(ProbeResult {
            found: true,
            path: resolved,
            exit_code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout: clip(&out.stdout),
            stderr: clip(&out.stderr),
            timed_out: status.is_none(),
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

#[derive(serde::Serialize)]
struct AppPresence {
    installed: bool,
    path: String,
    running: bool,
    version: String,
}

/// Whether a macOS app is installed and running.
///
/// This is how Spaces sees an agent it does not launch — Muse, Cursor, Zed. The
/// bundle id is authoritative and `mdfind` answers it wherever the app lives;
/// the `/Applications` fallback covers a Spotlight index that is off or stale.
#[tauri::command]
async fn check_app(bundle_id: String, app_name: String) -> Result<AppPresence, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bundle_id = bundle_id.trim().to_string();
        let app_name = app_name.trim().to_string();
        let mut path = String::new();

        if !bundle_id.is_empty() {
            let mut cmd = Command::new("/usr/bin/mdfind");
            cmd.arg(format!("kMDItemCFBundleIdentifier == '{bundle_id}'"));
            if let Ok(out) = blocking_output(cmd) {
                if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    if !first.trim().is_empty() {
                        path = first.trim().to_string();
                    }
                }
            }
        }
        if path.is_empty() && !app_name.is_empty() {
            for base in ["/Applications", "/System/Applications"] {
                let candidate = format!("{base}/{app_name}.app");
                if Path::new(&candidate).is_dir() {
                    path = candidate;
                    break;
                }
            }
            if path.is_empty() {
                if let Ok(home) = std::env::var("HOME") {
                    let candidate = format!("{home}/Applications/{app_name}.app");
                    if Path::new(&candidate).is_dir() {
                        path = candidate;
                    }
                }
            }
        }

        let version = if path.is_empty() {
            String::new()
        } else {
            let mut cmd = Command::new("/usr/bin/defaults");
            cmd.arg("read")
                .arg(format!("{path}/Contents/Info.plist"))
                .arg("CFBundleShortVersionString");
            blocking_output(cmd)
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .unwrap_or_default()
        };

        // pgrep matches the executable name, which for an app bundle is the
        // binary inside Contents/MacOS — usually, but not always, the app name.
        let running = {
            let needle = if !path.is_empty() {
                Path::new(&path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| app_name.clone())
            } else {
                app_name.clone()
            };
            if needle.is_empty() {
                false
            } else {
                let mut cmd = Command::new("/usr/bin/pgrep");
                cmd.arg("-x").arg(&needle);
                blocking_output(cmd)
                    .map(|out| out.status.success())
                    .unwrap_or(false)
            }
        };

        Ok(AppPresence {
            installed: !path.is_empty(),
            path,
            running,
            version,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}


fn unquote_frontmatter(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn parse_agent_profile(path: &Path, kind: &str) -> Option<DiscoveredAgentProfile> {
    let bytes = std::fs::read(path).ok()?;
    let bounded = &bytes[..bytes.len().min(65_536)];
    let source = String::from_utf8_lossy(bounded).replace("\r\n", "\n");
    let mut name = path.file_stem()?.to_string_lossy().replace(['-', '_'], " ");
    let mut description = String::new();
    let mut model = String::new();
    let mut persona = source.trim().to_string();

    if let Some(body) = source.strip_prefix("---\n") {
        if let Some(end) = body.find("\n---\n") {
            let front = &body[..end];
            persona = body[end + 5..].trim().to_string();
            for line in front.lines() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                let value = unquote_frontmatter(value);
                match key.trim() {
                    "name" if !value.is_empty() => name = value,
                    "description" => description = value,
                    "model" => model = value,
                    _ => {}
                }
            }
        }
    }
    if persona.is_empty() {
        persona = description.clone();
    }
    Some(DiscoveredAgentProfile {
        path: path.to_string_lossy().to_string(),
        name,
        kind: kind.to_string(),
        description,
        model,
        persona,
    })
}

/// Discover agent instruction profiles from the conventional user and project
/// locations used by Claude Code, Codex and tool-neutral repos. Read-only,
/// bounded, and restricted to fixed subdirectories.
#[tauri::command]
async fn discover_agent_profiles(project_roots: Vec<String>) -> Vec<DiscoveredAgentProfile> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut roots: Vec<(PathBuf, String)> = vec![
            (
                PathBuf::from(&home).join(".claude/agents"),
                "claude".to_string(),
            ),
            (
                PathBuf::from(&home).join(".codex/agents"),
                "codex".to_string(),
            ),
        ];
        for root in project_roots.into_iter().take(50) {
            let root = PathBuf::from(root);
            roots.push((root.join(".claude/agents"), "claude".to_string()));
            roots.push((root.join(".codex/agents"), "codex".to_string()));
            roots.push((root.join(".agents"), "codex".to_string()));
        }

        let mut seen = std::collections::HashSet::new();
        let mut found = Vec::new();
        for (directory, kind) in roots {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if found.len() >= 200 {
                    break;
                }
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("md")
                    || !path.is_file()
                {
                    continue;
                }
                let key = path.to_string_lossy().to_string();
                if !seen.insert(key) {
                    continue;
                }
                if let Some(profile) = parse_agent_profile(&path, &kind) {
                    found.push(profile);
                }
            }
        }
        found.sort_by_key(|profile| profile.name.to_lowercase());
        found
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
    request: AgentRunRequest,
) -> Result<(), String> {
    let AgentRunRequest {
        run_id,
        agent_id,
        channel_id,
        project_id,
        trigger_id,
        reply_to,
        project_root,
        context_dir,
        mcp_server,
        runtime,
        harness_protocol,
        program,
        args,
        cwd,
        prompt,
    } = request;
    let bin = resolve_bin(&program);
    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .env("PATH", login_path())
        .env("SPACES_RUN_ID", &run_id)
        .env("SPACES_AGENT_ID", agent_id)
        .env("SPACES_CHANNEL_ID", channel_id)
        .env("SPACES_PROJECT_ID", project_id)
        .env("SPACES_TRIGGER_ID", trigger_id)
        .env("SPACES_REPLY_TO", reply_to)
        .env("SPACES_PROJECT_ROOT", project_root)
        .env("SPACES_CONTEXT_DIR", context_dir)
        .env("SPACES_MCP_SERVER", &mcp_server)
        .env("SPACES_CLI", mcp_server)
        .env("SPACES_RUNTIME", runtime)
        .env("SPACES_HARNESS_PROTOCOL", harness_protocol)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(app_data) = app.path().app_data_dir() {
        cmd.env("SPACES_DB_PATH", app_data.join("spaces.db"));
    }
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

    /*
     * Timestamps decide the order a transcript reads in, and a date parser
     * that is wrong is wrong silently — the session still imports, it just
     * comes out shuffled or stamped in 1970. Known-good values from real
     * session files, plus the cases a hand-rolled civil-calendar conversion
     * gets wrong: a leap day, a century that is not a leap year, one that is,
     * and the epoch itself.
     */
    #[test]
    fn iso_timestamps_convert_to_milliseconds() {
        assert_eq!(iso_millis("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(iso_millis("2026-07-07T22:14:16.211Z"), 1_783_462_456_211);
        assert_eq!(iso_millis("2026-07-01T12:41:44.488Z"), 1_782_909_704_488);
        // Leap day, and a leap year divisible by 100 but also by 400.
        assert_eq!(iso_millis("2024-02-29T00:00:00.000Z"), 1_709_164_800_000);
        assert_eq!(iso_millis("2000-02-29T00:00:00.000Z"), 951_782_400_000);
        // 2100 is divisible by 100 and not by 400, so it is not a leap year —
        // the case a naive every-fourth-year rule gets wrong by a day.
        assert_eq!(iso_millis("2100-03-01T00:00:00.000Z"), 4_107_542_400_000);
        // Fractions are optional, and shorter than three digits scales up.
        assert_eq!(iso_millis("2026-07-07T22:14:16Z"), 1_783_462_456_000);
        assert_eq!(iso_millis("2026-07-07T22:14:16.2Z"), 1_783_462_456_200);
        // Anything not recognised is refused rather than guessed at. A
        // timestamp before the epoch is in that class on purpose: no session
        // file predates Unix, so one that claims to is corrupt, and a
        // plausible-looking negative would sort a transcript into nonsense.
        assert_eq!(iso_millis(""), 0);
        assert_eq!(iso_millis("07/07/2026"), 0);
        assert_eq!(iso_millis("2026-13-07T22:14:16.211Z"), 0);
        assert_eq!(iso_millis("1969-12-31T23:59:59.999Z"), 0);
    }

    /*
     * A session's title is the first thing a person wrote, not the first thing
     * its harness injected. Codex prefixes most opening messages with blocks of
     * its own; titling by "first line" labelled hundreds of sessions
     * `<recommended_plugins>`, which distinguishes none of them.
     */
    #[test]
    fn a_title_skips_the_harness_and_finds_the_prompt() {
        assert_eq!(
            first_prose_line("<recommended_plugins>\nuse ripgrep\n</recommended_plugins>\n\nfix the build"),
            "fix the build"
        );
        // Several blocks in a row, and one with attributes.
        assert_eq!(
            first_prose_line(
                "<user_instructions>\nbe terse\n</user_instructions>\n<environment_context cwd=\"/x\">\nmac\n</environment_context>\nship it"
            ),
            "ship it"
        );
        // A self-closing tag opens no block, so the next line still counts.
        assert_eq!(first_prose_line("<meta/>\nthe actual ask"), "the actual ask");
        // Ordinary prose is untouched, including prose that merely contains a
        // less-than sign.
        assert_eq!(first_prose_line("  make it faster  \nand smaller"), "make it faster");
        assert_eq!(first_prose_line("if a < b then swap"), "if a < b then swap");
        // Nothing but scaffolding, and nothing at all, are both "no title".
        assert_eq!(first_prose_line("<x>\ny\n</x>"), "");
        assert_eq!(first_prose_line(""), "");
    }

    /*
     * Thinking and tool traffic dwarf the conversation in both formats and are
     * the agent talking to itself. What is wanted is what was asked and what
     * was answered — importing the rest would bury it.
     */
    #[test]
    fn message_bodies_keep_the_conversation_and_drop_the_machinery() {
        let plain = serde_json::json!("just a string");
        assert_eq!(block_text(&plain), "just a string");

        let blocks = serde_json::json!([
            {"type": "thinking", "thinking": "hmm", "signature": "x"},
            {"type": "text", "text": "  the answer  "},
            {"type": "tool_use", "name": "Bash", "input": {}},
            {"type": "text", "text": "and a second paragraph"},
        ]);
        assert_eq!(block_text(&blocks), "the answer\n\nand a second paragraph");

        // Codex writes the same idea with its own block names.
        let codex = serde_json::json!([{"type": "input_text", "text": "do the thing"}]);
        assert_eq!(block_text(&codex), "do the thing");

        // Nothing sayable is an empty string, not a panic and not whitespace.
        assert_eq!(block_text(&serde_json::json!([{"type": "thinking"}])), "");
        assert_eq!(block_text(&serde_json::json!({})), "");
    }

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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            current_platform,
            legacy_hq_database_path,
            agent_control_root,
            upload_portal_media,
            run_gh,
            run_gh_in,
            run_git,
            run_git_ex,
            check_tools,
            check_program,
            discover_agent_profiles,
            apple_calendar_snapshot,
            apple_calendar_create,
            probe_program,
            accessibility_trusted,
            request_accessibility,
            send_to_app,
            scan_agent_sessions,
            read_agent_session,
            check_app,
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
