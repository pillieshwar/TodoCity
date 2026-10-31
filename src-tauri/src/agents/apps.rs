//! Connecting AI apps to `TodoCity --mcp` for the user.
//!
//! Each app keeps its MCP servers in its own settings: most in a JSON file,
//! Claude Code through its `claude mcp` command. TodoCity adds or removes only
//! its own `todocity` entry, keeps everything else as it was, and saves a
//! backup of the original file the first time it changes one.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// The name TodoCity uses in every app's MCP settings.
pub const SERVER: &str = "todocity";
/// The name versions before 0.4.45 used; replaced whenever TodoCity writes.
const LEGACY_SERVER: &str = "plucky";
const CLAUDE_CODE: &str = "claude_code";
/// Codex keeps MCP servers in TOML (`~/.codex/config.toml`).
const CODEX: &str = "codex";
const CODEX_BEGIN: &str =
    "# TodoCity begin — added by TodoCity (Settings → Agents); remove it there";
const CODEX_END: &str = "# TodoCity end";
/// Marks the Claude Code subagent file as TodoCity's, so it's only ever
/// replaced or removed when TodoCity wrote it.
const AGENT_MARK: &str = "<!-- Written by TodoCity. Remove TodoCity from Claude Code in TodoCity → Connectors to delete it. -->";
/// How files written before 0.4.45 were marked, then up to 0.4.50.
const LEGACY_MARK: &str = "<!-- Written by Plucky.";
const LEGACY_MARK_2: &str = "<!-- Written by Todo City.";

/// A file TodoCity wrote (now or under its old name), so it may replace it.
fn ours(text: &str) -> bool {
    text.contains(AGENT_MARK) || text.contains(LEGACY_MARK) || text.contains(LEGACY_MARK_2)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
    pub connected: bool,
    /// Connected to a TodoCity that's somewhere else now (e.g. the disk image).
    pub stale: bool,
    /// What to do after connecting.
    pub restart_hint: &'static str,
}

/// An app whose MCP servers live in a JSON file in the home folder.
struct JsonApp {
    id: &'static str,
    name: &'static str,
    /// Settings file, relative to the home folder.
    config: &'static str,
    /// "mcpServers" for most apps; VS Code uses "servers".
    key: &'static str,
    /// VS Code wants `"type": "stdio"` in the entry.
    typed: bool,
    /// Any of these existing (relative to home, or absolute) means installed.
    markers: &'static [&'static str],
    restart_hint: &'static str,
}

const JSON_APPS: &[JsonApp] = &[
    JsonApp {
        id: "claude_desktop",
        name: "Claude Desktop",
        config: "Library/Application Support/Claude/claude_desktop_config.json",
        key: "mcpServers",
        typed: false,
        markers: &[
            "/Applications/Claude.app",
            "Applications/Claude.app",
            "Library/Application Support/Claude",
        ],
        restart_hint: "Quit Claude Desktop (⌘Q) and open it again.",
    },
    JsonApp {
        id: "cursor",
        name: "Cursor",
        config: ".cursor/mcp.json",
        key: "mcpServers",
        typed: false,
        markers: &[
            "/Applications/Cursor.app",
            "Applications/Cursor.app",
            ".cursor",
        ],
        restart_hint: "Restart Cursor, or turn TodoCity on under Settings → MCP.",
    },
    JsonApp {
        id: "vscode",
        name: "VS Code",
        config: "Library/Application Support/Code/User/mcp.json",
        key: "servers",
        typed: true,
        markers: &[
            "/Applications/Visual Studio Code.app",
            "Applications/Visual Studio Code.app",
            "Library/Application Support/Code/User",
        ],
        restart_hint: "Reload VS Code, then start TodoCity from the MCP servers list if it asks.",
    },
    JsonApp {
        id: "windsurf",
        name: "Windsurf",
        config: ".codeium/windsurf/mcp_config.json",
        key: "mcpServers",
        typed: false,
        markers: &[
            "/Applications/Windsurf.app",
            "Applications/Windsurf.app",
            ".codeium/windsurf",
        ],
        restart_hint: "Restart Windsurf, or refresh its MCP servers.",
    },
    JsonApp {
        id: "antigravity",
        name: "Antigravity CLI",
        config: ".gemini/antigravity-cli/settings.json",
        key: "mcpServers",
        typed: false,
        markers: &[
            ".gemini/antigravity-cli",
            "/Applications/Antigravity.app",
            "Applications/Antigravity.app",
            ".local/bin/agy",
        ],
        restart_hint: "Start a new Antigravity CLI session.",
    },
    JsonApp {
        id: "gemini_cli",
        name: "Gemini CLI",
        config: ".gemini/settings.json",
        key: "mcpServers",
        typed: false,
        markers: &[".gemini"],
        restart_hint: "Start a new Gemini CLI session (or run /mcp refresh).",
    },
    JsonApp {
        id: "lm_studio",
        name: "LM Studio",
        config: ".lmstudio/mcp.json",
        key: "mcpServers",
        typed: false,
        markers: &[
            "/Applications/LM Studio.app",
            "Applications/LM Studio.app",
            ".lmstudio",
        ],
        restart_hint: "Restart LM Studio.",
    },
];

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn exists(home: &Path, marker: &str) -> bool {
    if marker.starts_with('/') {
        Path::new(marker).exists()
    } else {
        home.join(marker).exists()
    }
}

/// The `todocity` entry each app should have.
fn entry(command: &str, typed: bool) -> Value {
    if typed {
        json!({ "type": "stdio", "command": command, "args": ["--mcp"] })
    } else {
        json!({ "command": command, "args": ["--mcp"] })
    }
}

/// Read a settings file that may have comments or trailing commas (VS Code
/// allows both). Missing → empty object.
pub(crate) fn read_json(path: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(&text)
        .or_else(|_| serde_json::from_str(&strip_jsonc(&text)))
        .map_err(|_| {
            format!(
                "{} isn't valid JSON, so TodoCity left it alone.",
                path.display()
            )
        })?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!(
            "{} has an unexpected shape, so TodoCity left it alone.",
            path.display()
        ))
    }
}

/// Remove `//` and `/* */` comments and trailing commas, outside strings.
pub fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match (c, chars.get(i + 1)) {
            ('"', _) => {
                in_string = true;
                out.push(c);
                i += 1;
            }
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            (',', _) => {
                // Drop a comma that only has whitespace before `}` or `]`.
                let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
                if !matches!(next, Some('}') | Some(']')) {
                    out.push(c);
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Write settings back, keeping a one-time backup of the original.
fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let backup = PathBuf::from(format!("{}.todocity-backup", path.display()));
    if path.exists() && !backup.exists() {
        let _ = std::fs::copy(path, &backup);
    }
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let tmp = PathBuf::from(format!("{}.todocity-tmp", path.display()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't save {}: {e}", path.display()))
}

/// `Some(command)` of the `todocity` entry under `key`, if there is one.
fn server_command(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)?
        .get(SERVER)
        .or_else(|| config.get(key)?.get(LEGACY_SERVER))?
        .get("command")?
        .as_str()
        .map(str::to_string)
}

/// Put TodoCity's entry in, leaving everything else alone.
pub fn set_entry(config: &mut Value, key: &str, value: Value) {
    if !config[key].is_object() {
        config[key] = Value::Object(Map::new());
    }
    if let Some(m) = config[key].as_object_mut() {
        m.remove(LEGACY_SERVER);
    }
    config[key][SERVER] = value;
}

/// Take TodoCity's entry out. True if there was one.
pub fn remove_entry(config: &mut Value, key: &str) -> bool {
    config
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .is_some_and(|m| {
            let old = m.remove(LEGACY_SERVER).is_some();
            m.remove(SERVER).is_some() || old
        })
}

// ── Claude Code ───────────────────────────────────────────────────────────

/// Where `claude` usually lives. A Mac app doesn't get the shell's PATH, so
/// look in the usual places, then ask a login shell.
/// `ask_shell` also asks a login shell, which can take a moment.
pub(crate) fn find_claude(home: &Path, ask_shell: bool) -> Option<PathBuf> {
    let candidates = [
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        home.join(".volta/bin/claude"),
        home.join(".bun/bin/claude"),
    ];
    if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(p);
    }
    if !ask_shell {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = run(
        Command::new(shell).args(["-lc", "command -v claude"]),
        Duration::from_secs(5),
    )
    .ok()?;
    let path = PathBuf::from(out.trim());
    path.is_file().then_some(path)
}

/// Run a command with a time limit; stdout on success.
pub(crate) fn run(cmd: &mut Command, limit: Duration) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `claude mcp …`, with a PATH that finds Node for npm installs.
fn claude_mcp(home: &Path, claude: &Path, args: &[&str]) -> Result<String, String> {
    let mut path = vec![
        claude
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        home.join(".volta/bin").display().to_string(),
        home.join(".local/bin").display().to_string(),
        "/usr/bin".into(),
        "/bin".into(),
    ];
    if let Ok(p) = std::env::var("PATH") {
        path.push(p);
    }
    run(
        Command::new(claude)
            .args(["mcp"])
            .args(args)
            .env("PATH", path.join(":")),
        Duration::from_secs(20),
    )
}

pub(crate) fn claude_json(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

fn subagent_path(home: &Path) -> PathBuf {
    home.join(".claude/agents/todocity.md")
}

/// Where versions before 0.4.45 put the subagent; removed if TodoCity wrote it.
fn legacy_subagent(home: &Path) {
    let path = home.join(".claude/agents/plucky.md");
    if std::fs::read_to_string(&path).is_ok_and(|s| ours(&s)) {
        let _ = std::fs::remove_file(path);
    }
}

/// A Claude Code subagent that notices to-dos and sends them to TodoCity.
pub fn subagent() -> String {
    format!(
        r#"---
name: todocity
description: Saves to-dos, follow-ups and reminders to the user's private TodoCity task list. Use proactively whenever the user mentions something they need to do later, a deadline, an appointment, a follow-up or "remind me" — even in passing — and when finished work leaves a clear next step for the user. It only adds tasks.
tools: mcp__todocity__add_task
model: inherit
---

{AGENT_MARK}

You add tasks to TodoCity, the user's to-do list on their Mac, with the
`add_task` tool. Depending on the user's settings, each task waits in TodoCity
for their approval or is added right away. You only add tasks here.

For each thing the user needs to do:
- Call `add_task` once, with a short, actionable `title` ("Send the Q3 deck to
  Priya", not "Q3 deck").
- Give `due_date` (YYYY-MM-DD) and, if a time was said, `due_time` (24-hour
  HH:MM) in the user's local time, worked out from today's date. Leave them out
  if there's no date; don't guess one.
- Put useful context in `notes` — who asked, where it came from — in a sentence
  or two. Never include passwords, keys or other secrets.

Don't add things that are already done, things for other people, or vague
ideas with nothing to do. Don't ask follow-up questions. When you're done, reply
in one line with what you sent, e.g. "Sent 2 tasks to TodoCity for review."
"#
    )
}

/// Write the subagent, unless the user has their own `todocity` agent.
fn install_subagent(home: &Path) -> Result<(), String> {
    legacy_subagent(home);
    let path = subagent_path(home);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !ours(&existing) {
            return Ok(());
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, subagent())
        .map_err(|e| format!("Couldn't add the TodoCity subagent: {e}"))
}

fn command_path(home: &Path) -> PathBuf {
    home.join(".claude/commands/email-tasks.md")
}

/// The `/email-tasks` command older versions added (email to tasks was
/// removed in 0.4.69): take ours out, leave anyone else's.
fn remove_email_command(home: &Path) {
    let path = command_path(home);
    if std::fs::read_to_string(&path).is_ok_and(|s| ours(&s)) {
        let _ = std::fs::remove_file(path);
    }
}

fn remove_subagent(home: &Path) {
    legacy_subagent(home);
    let path = subagent_path(home);
    if std::fs::read_to_string(&path).is_ok_and(|s| ours(&s)) {
        let _ = std::fs::remove_file(path);
    }
}

fn claude_code_status(home: &Path, command: &str) -> AppStatus {
    let installed = find_claude(home, false).is_some() || claude_json(home).exists();
    let current = read_json(&claude_json(home))
        .ok()
        .and_then(|c| server_command(&c, "mcpServers"));
    AppStatus {
        id: CLAUDE_CODE,
        name: "Claude Code",
        installed,
        connected: current.is_some(),
        stale: current.is_some_and(|c| c != command),
        restart_hint: "Start a new Claude Code session (or run /mcp).",
    }
}

fn connect_claude_code(home: &Path, command: &str, proactive: bool) -> Result<(), String> {
    let via_cli = find_claude(home, true).map(|claude| {
        let _ = claude_mcp(home, &claude, &["remove", "--scope", "user", SERVER]);
        let _ = claude_mcp(home, &claude, &["remove", "--scope", "user", LEGACY_SERVER]);
        claude_mcp(
            home,
            &claude,
            &["add", "--scope", "user", SERVER, "--", command, "--mcp"],
        )
    });
    match via_cli {
        Some(Ok(_)) => {}
        // No `claude` found, or it failed: edit its settings directly.
        _ => {
            let path = claude_json(home);
            let mut config = read_json(&path)?;
            set_entry(
                &mut config,
                "mcpServers",
                json!({ "type": "stdio", "command": command, "args": ["--mcp"], "env": {} }),
            );
            write_json(&path, &config)?;
        }
    }
    if proactive {
        install_subagent(home)?;
    }
    Ok(())
}

fn disconnect_claude_code(home: &Path) -> Result<(), String> {
    remove_subagent(home);
    remove_email_command(home);
    if let Some(claude) = find_claude(home, true) {
        let _ = claude_mcp(home, &claude, &["remove", "--scope", "user", LEGACY_SERVER]);
        if claude_mcp(home, &claude, &["remove", "--scope", "user", SERVER]).is_ok() {
            return Ok(());
        }
    }
    let path = claude_json(home);
    let mut config = read_json(&path)?;
    if remove_entry(&mut config, "mcpServers") {
        write_json(&path, &config)?;
    }
    Ok(())
}

// ── Codex ─────────────────────────────────────────────────────────────────

fn codex_config(home: &Path) -> PathBuf {
    home.join(".codex/config.toml")
}

/// The `[mcp_servers.todocity]` block TodoCity adds to Codex's settings.
pub fn codex_block(command: &str) -> String {
    format!(
        "{CODEX_BEGIN}\n[mcp_servers.todocity]\ncommand = {}\nargs = [\"--mcp\"]\n{CODEX_END}\n",
        todocity_core::agent_runs::toml_str(command)
    )
}

/// Codex's settings without the block TodoCity added (the person's own
/// lines, including any `todocity` server they wrote themselves, stay).
pub fn codex_without_ours(text: &str) -> String {
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if line.trim() == CODEX_BEGIN {
            inside = true;
            continue;
        }
        if inside {
            if line.trim() == CODEX_END {
                inside = false;
            }
            continue;
        }
        out.push(line);
    }
    let mut joined = out.join("\n");
    if !joined.is_empty() {
        joined.push('\n');
    }
    joined
}

/// The command of the `todocity` MCP server in Codex's settings, if any.
pub fn codex_command(text: &str) -> Option<String> {
    let mut in_table = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_table = t == "[mcp_servers.todocity]";
            continue;
        }
        if !in_table {
            continue;
        }
        let Some(rest) = t.strip_prefix("command") else {
            continue;
        };
        let rest = rest.trim_start().strip_prefix('=')?.trim();
        let inner = rest.strip_prefix('"')?;
        let mut value = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return Some(value),
                '\\' => match chars.next()? {
                    'n' => value.push('\n'),
                    't' => value.push('\t'),
                    other => value.push(other),
                },
                c => value.push(c),
            }
        }
        return None;
    }
    None
}

fn codex_installed(home: &Path) -> bool {
    [
        home.join(".codex"),
        PathBuf::from("/Applications/Codex.app"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        home.join(".local/bin/codex"),
        home.join(".npm-global/bin/codex"),
    ]
    .iter()
    .any(|p| p.exists())
}

fn codex_status(home: &Path, command: &str) -> AppStatus {
    let current = std::fs::read_to_string(codex_config(home))
        .ok()
        .and_then(|t| codex_command(&t));
    AppStatus {
        id: CODEX,
        name: "Codex",
        installed: codex_installed(home),
        connected: current.is_some(),
        stale: current.is_some_and(|c| c != command),
        restart_hint: "Start a new Codex session.",
    }
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let backup = PathBuf::from(format!("{}.todocity-backup", path.display()));
    if path.exists() && !backup.exists() {
        let _ = std::fs::copy(path, &backup);
    }
    let tmp = PathBuf::from(format!("{}.todocity-tmp", path.display()));
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't save {}: {e}", path.display()))
}

fn connect_codex(home: &Path, command: &str) -> Result<(), String> {
    let path = codex_config(home);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut rest = codex_without_ours(&text);
    // The person wrote their own `todocity` server: it's theirs to change.
    if codex_command(&rest).is_some() {
        return Ok(());
    }
    if !rest.is_empty() && !rest.ends_with("\n\n") {
        rest.push('\n');
    }
    rest.push_str(&codex_block(command));
    write_text(&path, &rest)
}

fn disconnect_codex(home: &Path) -> Result<(), String> {
    let path = codex_config(home);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let rest = codex_without_ours(&text);
    if rest != text {
        write_text(&path, rest.trim_end_matches('\n').to_string().as_str())?;
    }
    Ok(())
}

// ── All apps ──────────────────────────────────────────────────────────────

fn json_status(home: &Path, app: &JsonApp, command: &str) -> AppStatus {
    let current = read_json(&home.join(app.config))
        .ok()
        .and_then(|c| server_command(&c, app.key));
    AppStatus {
        id: app.id,
        name: app.name,
        installed: app.markers.iter().any(|m| exists(home, m)),
        connected: current.is_some(),
        stale: current.is_some_and(|c| c != command),
        restart_hint: app.restart_hint,
    }
}

/// Every supported app, installed or not, Claude apps first.
pub fn statuses(command: &str) -> Vec<AppStatus> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let mut out = vec![
        claude_code_status(&home, command),
        codex_status(&home, command),
    ];
    out.extend(JSON_APPS.iter().map(|a| json_status(&home, a, command)));
    out
}

pub fn connect(id: &str, command: &str, proactive: bool) -> Result<(), String> {
    let home = home().ok_or("Couldn't find your home folder.")?;
    if id == CLAUDE_CODE {
        return connect_claude_code(&home, command, proactive);
    }
    if id == CODEX {
        return connect_codex(&home, command);
    }
    let app = JSON_APPS
        .iter()
        .find(|a| a.id == id)
        .ok_or("Unknown app.")?;
    let path = home.join(app.config);
    let mut config = read_json(&path)?;
    set_entry(&mut config, app.key, entry(command, app.typed));
    write_json(&path, &config)
}

pub fn disconnect(id: &str) -> Result<(), String> {
    let home = home().ok_or("Couldn't find your home folder.")?;
    if id == CLAUDE_CODE {
        return disconnect_claude_code(&home);
    }
    if id == CODEX {
        return disconnect_codex(&home);
    }
    let app = JSON_APPS
        .iter()
        .find(|a| a.id == id)
        .ok_or("Unknown app.")?;
    let path = home.join(app.config);
    let mut config = read_json(&path)?;
    if remove_entry(&mut config, app.key) {
        write_json(&path, &config)?;
    }
    Ok(())
}

/// Turn the Claude Code subagent on or off (only where TodoCity is connected).
pub fn set_proactive(on: bool) {
    let Some(home) = home() else { return };
    let connected = read_json(&claude_json(&home))
        .ok()
        .and_then(|c| server_command(&c, "mcpServers"))
        .is_some();
    if on && connected {
        if let Err(e) = install_subagent(&home) {
            log::warn!("{e}");
        }
    } else if !on {
        remove_subagent(&home);
    }
}

/// Point apps that were connected to an old copy of TodoCity at this one.
pub fn repair(command: &str) {
    let all = statuses(command);
    // Email to tasks is gone (0.4.69): remove the command it added.
    if let Some(home) = home() {
        remove_email_command(&home);
    }
    for s in all.into_iter().filter(|s| s.stale) {
        match connect(s.id, command, false) {
            Ok(()) => log::info!("updated TodoCity's path in {}", s.name),
            Err(e) => log::warn!("could not update TodoCity's path in {}: {e}", s.name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_gets_one_marked_block_and_keeps_the_rest() {
        let own = "model = \"o4\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n";
        let cmd = "/Applications/TodoCity.app/Contents/MacOS/todocity";
        let mut with = codex_without_ours(own);
        with.push('\n');
        with.push_str(&codex_block(cmd));
        assert_eq!(codex_command(&with).as_deref(), Some(cmd));
        assert!(with.starts_with(own));
        // Taking it out leaves exactly what was there.
        assert_eq!(codex_without_ours(&with).trim_end(), own.trim_end());
        // Adding again replaces, never duplicates.
        let again = format!(
            "{}\n{}",
            codex_without_ours(&with),
            codex_block("/new/todocity")
        );
        assert_eq!(again.matches("[mcp_servers.todocity]").count(), 1);
        assert_eq!(codex_command(&again).as_deref(), Some("/new/todocity"));
        // Another table's command isn't ours; quotes and backslashes survive.
        assert_eq!(codex_command(own), None);
        let tricky = codex_block("/A \"B\"\\c");
        assert_eq!(codex_command(&tricky).as_deref(), Some("/A \"B\"\\c"));
    }

    #[test]
    fn codex_settings_on_disk_round_trip() {
        let home = tempfile::tempdir().unwrap();
        let path = codex_config(home.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "model = \"o4\"\n").unwrap();
        connect_codex(home.path(), "/x/todocity").unwrap();
        connect_codex(home.path(), "/x/todocity").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches(CODEX_BEGIN).count(), 1);
        assert!(codex_status(home.path(), "/x/todocity").connected);
        assert!(codex_status(home.path(), "/y/todocity").stale);
        disconnect_codex(home.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "model = \"o4\"");
        assert!(!codex_status(home.path(), "/x/todocity").connected);
        // Their own todocity server is left alone.
        std::fs::write(&path, "[mcp_servers.todocity]\ncommand = \"/mine\"\n").unwrap();
        connect_codex(home.path(), "/x/todocity").unwrap();
        assert_eq!(
            codex_command(&std::fs::read_to_string(&path).unwrap()).as_deref(),
            Some("/mine")
        );
    }

    #[test]
    fn strips_comments_and_trailing_commas() {
        let text = r#"{
  // servers
  "servers": { "a": { "url": "http://x//y", "b": "/* not a comment */", }, },
  /* block */ "z": [1, 2,],
}"#;
        let v: Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(v["servers"]["a"]["url"], "http://x//y");
        assert_eq!(v["servers"]["a"]["b"], "/* not a comment */");
        assert_eq!(v["z"], json!([1, 2]));
    }

    #[test]
    fn adds_and_removes_only_ours() {
        let mut c = json!({ "theme": "dark", "mcpServers": { "other": { "command": "x" } } });
        set_entry(&mut c, "mcpServers", entry("/A/TodoCity", false));
        assert_eq!(
            server_command(&c, "mcpServers").as_deref(),
            Some("/A/TodoCity")
        );
        assert_eq!(c["mcpServers"]["other"]["command"], "x");
        assert_eq!(c["theme"], "dark");
        assert!(remove_entry(&mut c, "mcpServers"));
        assert!(!remove_entry(&mut c, "mcpServers"));
        assert_eq!(c["mcpServers"]["other"]["command"], "x");

        let mut empty = json!({});
        set_entry(&mut empty, "servers", entry("/A/TodoCity", true));
        assert_eq!(empty["servers"]["todocity"]["type"], "stdio");
    }

    #[test]
    fn replaces_the_old_name() {
        // Set up before the rename: "plucky".
        let mut c = json!({ "mcpServers": { "plucky": { "command": "/Old/Pluck" } } });
        assert_eq!(
            server_command(&c, "mcpServers").as_deref(),
            Some("/Old/Pluck")
        );
        set_entry(&mut c, "mcpServers", entry("/A/TodoCity", false));
        assert!(c["mcpServers"].get("plucky").is_none());
        assert_eq!(
            server_command(&c, "mcpServers").as_deref(),
            Some("/A/TodoCity")
        );

        let mut old = json!({ "mcpServers": { "plucky": { "command": "/Old/Pluck" } } });
        assert!(remove_entry(&mut old, "mcpServers"));
        assert!(old["mcpServers"].as_object().unwrap().is_empty());

        let dir = tempfile::tempdir().unwrap();
        let agents = dir.path().join(".claude/agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("plucky.md"),
            "x\n<!-- Written by Plucky. Remove … -->\n",
        )
        .unwrap();
        install_subagent(dir.path()).unwrap();
        assert!(!agents.join("plucky.md").exists());
        assert!(subagent_path(dir.path()).exists());
    }

    #[test]
    fn json_apps_round_trip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let app = &JSON_APPS[1];
        let path = dir.path().join(app.config);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        assert!(!json_status(dir.path(), app, "/A/TodoCity").connected);

        let mut c = read_json(&path).unwrap();
        set_entry(&mut c, app.key, entry("/Old/TodoCity", false));
        write_json(&path, &c).unwrap();
        let s = json_status(dir.path(), app, "/A/TodoCity");
        assert!(s.connected && s.stale);
        assert!(PathBuf::from(format!("{}.todocity-backup", path.display())).exists());
    }

    #[test]
    fn the_old_email_command_is_removed_but_not_the_users() {
        let dir = tempfile::tempdir().unwrap();
        let path = command_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("---\n---\n{AGENT_MARK}\nold")).unwrap();
        remove_email_command(dir.path());
        assert!(!path.exists());
        std::fs::write(&path, "my own command").unwrap();
        remove_email_command(dir.path());
        assert!(path.exists());
    }

    #[test]
    fn subagent_is_marked_and_respects_the_users_own() {
        let dir = tempfile::tempdir().unwrap();
        install_subagent(dir.path()).unwrap();
        let text = std::fs::read_to_string(subagent_path(dir.path())).unwrap();
        assert!(text.starts_with("---\nname: todocity\n"));
        assert!(text.contains("tools: mcp__todocity__add_task"));
        remove_subagent(dir.path());
        assert!(!subagent_path(dir.path()).exists());

        std::fs::write(subagent_path(dir.path()), "my own").unwrap();
        install_subagent(dir.path()).unwrap();
        remove_subagent(dir.path());
        assert_eq!(
            std::fs::read_to_string(subagent_path(dir.path())).unwrap(),
            "my own"
        );
    }
}
