//! Setting agents up: agents the person adds themselves, which agent is
//! the default, and which agents already have Slack.
//!
//! Pure: the app finds files and runs programs; this decides.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_runs;

/// Ids of agents the person added start with this.
pub const CUSTOM_PREFIX: &str = "custom:";
/// Most agents someone can add.
pub const MAX_CUSTOM: usize = 12;

/// A command-line agent the person picked from their Mac ("Add agent…").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomAgent {
    /// `custom:<slug>`.
    pub id: String,
    pub name: String,
    /// The program, an absolute path.
    pub path: String,
}

pub fn is_custom(id: &str) -> bool {
    id.starts_with(CUSTOM_PREFIX)
}

/// "cursor-agent" → "Cursor Agent", "aider" → "Aider".
pub fn pretty_name(file: &str) -> String {
    let words: Vec<String> = file
        .split(|c: char| c == '-' || c == '_' || c == '.' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    let name = words.join(" ");
    if name.is_empty() {
        "My agent".into()
    } else {
        name.chars().take(40).collect()
    }
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "agent".into()
    } else {
        out.chars().take(32).collect()
    }
}

/// What a picked program becomes, or why it can't be added. `path` must be
/// absolute; `existing` are the agents already added. Known agents (Claude
/// Code, Codex…) are found on their own, so picking one says so.
pub fn new_custom(path: &str, existing: &[CustomAgent]) -> Result<CustomAgent, String> {
    let path = path.trim().trim_end_matches('/');
    if !path.starts_with('/') || path.contains('\n') || path.contains('\0') {
        return Err("Pick the agent's program on your Mac.".into());
    }
    if path.ends_with(".app") {
        return Err("Pick the agent's command-line program (for example ~/.local/bin/aider), not the app. For apps, use the setup below.".into());
    }
    let file = path.rsplit('/').next().unwrap_or_default();
    if let Some(known) = agent_runs::CLIS
        .iter()
        .find(|c| c.binaries().contains(&file))
    {
        return Err(format!(
            "{} is one TodoCity knows: choose Check for agents to find it.",
            known.name
        ));
    }
    if existing.iter().any(|a| a.path == path) {
        return Err("That agent is already in your list.".into());
    }
    if existing.len() >= MAX_CUSTOM {
        return Err(format!(
            "Up to {MAX_CUSTOM} agents can be added. Remove one first."
        ));
    }
    let base = slug(file);
    let mut id = format!("{CUSTOM_PREFIX}{base}");
    let mut n = 2;
    while existing.iter().any(|a| a.id == id) {
        id = format!("{CUSTOM_PREFIX}{base}-{n}");
        n += 1;
    }
    Ok(CustomAgent {
        id,
        name: pretty_name(file),
        path: path.to_string(),
    })
}

/// The shell script that starts an added agent (`$1` is its path; its
/// arguments follow). The path is an argument, never shell text.
pub fn custom_script(name: &str) -> String {
    let name = name.replace('\'', "");
    format!(
        "p=\"$1\"; shift; if [ -x \"$p\" ]; then exec \"$p\" \"$@\"; fi; printf '\\n  %s isn'\"'\"'t at %s any more. Add it again in TodoCity → Settings → Agents.\\n\\n' '{name}' \"$p\" >&2; exit 127"
    )
}

/// First message for an added agent on Connect: it adds TodoCity's MCP
/// server to its own settings, with the person watching in the panel.
pub fn connect_prompt(mcp_command: &str) -> String {
    format!(
        "Please connect yourself to TodoCity, my to-do app, through MCP. Add a stdio MCP server named \"todocity\" to your own settings (user or global scope, not this folder) that runs this command with one argument:\n\ncommand: {mcp_command}\nargs: [\"--mcp\"]\n\nDon't change anything else. When you're done, tell me in one line whether I need to restart you to see TodoCity's tools."
    )
}

/// First message for a known agent on Connect: TodoCity has added itself
/// already; the agent checks it can see TodoCity's tools.
pub fn check_prompt() -> String {
    "TodoCity, my to-do app, has just connected itself to you through MCP. Check that you can see TodoCity's tools (like add_task) and tell me in one line. Don't add or change anything.".into()
}

/// Agents in the order to offer them: the default first, then as found.
pub fn ordered(ids: &[String], default: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    if let Some(d) = default.filter(|d| ids.iter().any(|i| i == d)) {
        out.push(d.to_string());
    }
    out.extend(ids.iter().filter(|i| Some(i.as_str()) != default).cloned());
    out
}

/// The agent to use when nothing else says which: the default when it's
/// there, else the last one used, else the first.
pub fn preferred(ids: &[String], default: Option<&str>, last: Option<&str>) -> Option<String> {
    let has = |x: &str| ids.iter().any(|i| i == x);
    default
        .filter(|d| has(d))
        .or(last.filter(|l| has(l)))
        .map(str::to_string)
        .or_else(|| ids.first().cloned())
}

/// The agent that reads Slack: the one asked for; else the default if it
/// has Slack; else any agent that has Slack; else the one used before, the
/// default, Watch's, or the first that can. `can` are the installed agents
/// that can read Slack for TodoCity, `with_slack` those that already have it.
pub fn slack_agent(
    asked: Option<&str>,
    default: Option<&str>,
    before: Option<&str>,
    watch: Option<&str>,
    can: &[String],
    with_slack: &[String],
) -> Option<String> {
    let usable = |x: &str| can.iter().any(|c| c == x);
    if let Some(a) = asked.filter(|a| crate::slack::can_scan(a)) {
        return Some(a.to_string());
    }
    if let Some(d) = default.filter(|d| usable(d) && with_slack.iter().any(|s| s == d)) {
        return Some(d.to_string());
    }
    if let Some(s) = can.iter().find(|c| with_slack.contains(c)) {
        return Some(s.clone());
    }
    [before, default, watch]
        .into_iter()
        .flatten()
        .find(|x| usable(x))
        .map(str::to_string)
        .or_else(|| can.first().cloned())
}

fn mentions_slack(v: &Value) -> bool {
    match v {
        Value::String(s) => s.to_ascii_lowercase().contains("slack"),
        Value::Array(a) => a.iter().any(mentions_slack),
        Value::Object(o) => o
            .iter()
            .any(|(k, v)| k.to_ascii_lowercase().contains("slack") || mentions_slack(v)),
        _ => false,
    }
}

/// Whether a JSON settings file has a Slack MCP server: a server under
/// `mcpServers` (or VS Code's `servers`, at the top or in any project)
/// whose name, command, arguments or URL mention Slack.
pub fn json_has_slack(config: &Value) -> bool {
    fn servers(v: &Value) -> bool {
        ["mcpServers", "servers"].iter().any(|k| {
            v.get(k).and_then(Value::as_object).is_some_and(|m| {
                m.iter().any(|(name, s)| {
                    name.to_ascii_lowercase().contains("slack") || mentions_slack(s)
                })
            })
        })
    }
    if servers(config) {
        return true;
    }
    // Claude Code keeps servers per project too.
    config
        .get("projects")
        .and_then(Value::as_object)
        .is_some_and(|p| p.values().any(servers))
}

/// Whether Codex's `config.toml` has a Slack MCP server: a
/// `[mcp_servers.<name>]` table whose name or lines mention Slack.
pub fn toml_has_slack(text: &str) -> bool {
    let mut in_server = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('#') {
            continue;
        }
        if l.starts_with('[') {
            let table = l.trim_start_matches('[').trim_end_matches(']').trim();
            in_server = table.starts_with("mcp_servers.") || table.starts_with("mcp_servers\"");
            if in_server && table.to_ascii_lowercase().contains("slack") {
                return true;
            }
            continue;
        }
        if in_server && l.to_ascii_lowercase().contains("slack") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn added_agents_get_a_name_and_a_unique_id() {
        let a = new_custom("/Users/sam/.local/bin/aider", &[]).unwrap();
        assert_eq!(a.id, "custom:aider");
        assert_eq!(a.name, "Aider");
        let b = new_custom("/opt/tools/aider", std::slice::from_ref(&a)).unwrap();
        assert_eq!(b.id, "custom:aider-2");
        assert_eq!(pretty_name("open-code_cli"), "Open Code Cli");
        assert_eq!(pretty_name(""), "My agent");
    }

    #[test]
    fn some_picks_are_turned_away_with_what_to_do() {
        assert!(new_custom("relative/aider", &[]).is_err());
        assert!(new_custom("/Applications/Thing.app", &[])
            .unwrap_err()
            .contains("command-line"));
        assert!(new_custom("/opt/homebrew/bin/claude", &[])
            .unwrap_err()
            .contains("Check for agents"));
        let a = new_custom("/x/aider", &[]).unwrap();
        assert!(new_custom("/x/aider", &[a])
            .unwrap_err()
            .contains("already"));
        let many: Vec<CustomAgent> = (0..MAX_CUSTOM)
            .map(|i| new_custom(&format!("/x/a{i}"), &[]).unwrap())
            .collect();
        assert!(new_custom("/x/one-more", &many).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_added_agent_starts_with_its_arguments_and_says_when_it_moved() {
        let out = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &custom_script("Printer"),
                "todocity-agent",
                "/usr/bin/printf",
                "%s|",
                "a b",
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a b|");
        let gone = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                &custom_script("Gone's"),
                "todocity-agent",
                "/no/such/agent",
            ])
            .output()
            .unwrap();
        assert_eq!(gone.status.code(), Some(127));
        assert!(String::from_utf8_lossy(&gone.stderr).contains("Add it again"));
    }

    #[test]
    fn the_default_comes_first_and_is_preferred() {
        let all = ids(&["claude", "codex", "cursor"]);
        assert_eq!(
            ordered(&all, Some("codex")),
            ids(&["codex", "claude", "cursor"])
        );
        assert_eq!(ordered(&all, Some("gone")), all);
        assert_eq!(
            preferred(&all, Some("cursor"), Some("codex")).as_deref(),
            Some("cursor")
        );
        assert_eq!(
            preferred(&all, None, Some("codex")).as_deref(),
            Some("codex")
        );
        assert_eq!(
            preferred(&all, Some("gone"), None).as_deref(),
            Some("claude")
        );
        assert_eq!(preferred(&[], Some("x"), None), None);
    }

    #[test]
    fn slack_goes_to_an_agent_that_has_it() {
        let can = ids(&["claude", "codex", "cursor"]);
        // Asked for wins.
        assert_eq!(
            slack_agent(Some("cursor"), None, None, None, &can, &[]).as_deref(),
            Some("cursor")
        );
        // The default, when it has Slack.
        assert_eq!(
            slack_agent(
                None,
                Some("codex"),
                None,
                None,
                &can,
                &ids(&["codex", "claude"])
            )
            .as_deref(),
            Some("codex")
        );
        // Otherwise one that has Slack beats the default.
        assert_eq!(
            slack_agent(None, Some("codex"), None, None, &can, &ids(&["claude"])).as_deref(),
            Some("claude")
        );
        // Nobody has Slack: the one used before, then the default.
        assert_eq!(
            slack_agent(None, Some("codex"), Some("cursor"), None, &can, &[]).as_deref(),
            Some("cursor")
        );
        assert_eq!(
            slack_agent(None, Some("codex"), None, Some("claude"), &can, &[]).as_deref(),
            Some("codex")
        );
        assert_eq!(
            slack_agent(None, None, None, None, &can, &[]).as_deref(),
            Some("claude")
        );
        assert_eq!(slack_agent(None, None, None, None, &[], &[]), None);
        // Agents that can't scan headless aren't asked.
        assert_eq!(
            slack_agent(Some("gemini"), None, None, None, &can, &[]).as_deref(),
            Some("claude")
        );
    }

    #[test]
    fn finds_slack_servers_in_json_settings() {
        assert!(json_has_slack(
            &json!({"mcpServers": {"slack": {"command": "npx", "args": ["x"]}}})
        ));
        assert!(json_has_slack(
            &json!({"mcpServers": {"work": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"]}}})
        ));
        assert!(json_has_slack(
            &json!({"mcpServers": {"chat": {"type": "http", "url": "https://mcp.slack.com/mcp"}}})
        ));
        assert!(json_has_slack(
            &json!({"servers": {"Slack": {"type": "stdio"}}})
        ));
        assert!(json_has_slack(
            &json!({"projects": {"/Users/sam/x": {"mcpServers": {"slack": {}}}}})
        ));
        assert!(!json_has_slack(
            &json!({"mcpServers": {"todocity": {"command": "/Applications/TodoCity.app/x"}}})
        ));
        // Slack mentioned outside a server doesn't count.
        assert!(!json_has_slack(
            &json!({"theme": "slack", "mcpServers": {}})
        ));
    }

    #[test]
    fn finds_slack_servers_in_codex_settings() {
        assert!(toml_has_slack("[mcp_servers.slack]\ncommand = \"npx\"\n"));
        assert!(toml_has_slack(
            "[mcp_servers.work]\ncommand = \"npx\"\nargs = [\"-y\", \"slack-mcp-server\"]\n"
        ));
        assert!(!toml_has_slack(
            "model = \"slack\"\n[mcp_servers.todocity]\ncommand = \"/x\"\n"
        ));
        assert!(!toml_has_slack(
            "# [mcp_servers.slack]\n[profiles.slack]\nmodel = \"o3\"\n"
        ));
    }
}
