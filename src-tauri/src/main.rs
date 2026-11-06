// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `TodoCity --mcp`: the MCP server that AI apps launch. It runs
    // without any UI and hands tasks to the running app (see agents.rs).
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        std::process::exit(todocity_lib::run_mcp());
    }
    // `TodoCity --slack-secretary`: one Slack check by Slack Secretary's
    // background task (launchd starts it every five minutes; no UI).
    if std::env::args().nth(1).as_deref() == Some("--slack-secretary") {
        std::process::exit(todocity_lib::run_slack_secretary());
    }
    todocity_lib::run();
}
