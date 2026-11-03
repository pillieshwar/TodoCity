# Logos

Every logo TodoCity shows lives in this one folder, named by id. Drop a file
in and it's used everywhere that app, site or agent appears: a task's "from"
chip, the corner badge on Calendar's blocks, the agent panel and Settings →
AI → Agents. `src/lib/sourceLogos.ts` says which logo goes with which app
(bundle id), site (host) or recorded name.

| File | Shown for |
|---|---|
| `todoist.svg` | Tasks synced or imported from Todoist; todoist.com |
| `things.png` | Tasks synced or imported from Things 3 |
| `claude.svg` | Claude Code, Claude Desktop and tasks they add; claude.ai |
| `openai.svg` | Codex and ChatGPT; chatgpt.com (on a dark tile) |
| `gemini.svg` | Gemini CLI; gemini.google.com |
| `cursor.svg` | Cursor (on a dark tile) |
| `antigravity.svg` | Antigravity |
| `kiro.svg` | Kiro |
| `grok.svg` | Grok; grok.com (on a dark tile) |
| `slack.svg` | Slack, the Slack connection; slack.com |
| `gmail.svg` | mail.google.com |
| `outlook.svg` | Outlook; Outlook on the web; meetings from Exchange and Outlook accounts |
| `google_calendar.svg` | calendar.google.com; meetings from Google accounts |
| `chrome.svg`, `safari.svg` | Pages read in those browsers, when the site has no logo here |
| `zoom.svg`, `notion.svg`, `obsidian.svg`, `linear.svg`, `github.svg` | Those apps and their sites |
| `reddit.svg`, `substack.svg` | reddit.com, substack.com |

Rules:

- Official files only (press or brand kits), following each company's
  guidelines: the symbol, not the wordmark, on a transparent background.
  Never draw or recreate a logo.
- A logo drawn light for dark backgrounds (Cursor, Grok, OpenAI) goes in
  `DARK_TILE` in `src/lib/agentIcons.ts`, so it sits on a small dark tile.
- Apps on the Mac without a file here still show their own icon, read from
  the app by its bundle id (`app_icons::source_icons`). A file wins over the
  installed icon, so it looks the same on every Mac.
