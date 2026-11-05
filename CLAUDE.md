# TodoCity: notes for AI coding agents

TodoCity is a private, Mac-first to-do app, free and open source under the MIT License (the name and icon aren't: `TRADEMARK.md`). Select or copy text in any app, press ⌘C twice, and an on-device model writes the task. Each project is a building in a 3D city, and finishing tasks moves residents in. It syncs between the person's Macs, both ways with Todoist, into it from Things 3, with Apple Reminders and Apple Calendar, and AI agents can add tasks over MCP. The stack is Tauri v2, Rust and React/TypeScript. User-facing docs are in `README.md`; the website (todocity.app, with guides and the privacy FAQ) lives in a separate repo, `pillieshwar/todo-city-website`.

## Layout

| Path | What |
|---|---|
| `crates/todocity-core/src/` | Pure Rust core with unit tests: `store.rs` (SQLite schema, migrations, tasks, repeats), `sync/` (Mac-to-Mac sync), `mirror.rs` (Things/Todoist keep-in-sync: bringing changes in), `mirror_out.rs` (two-way: sending changes back), `things.rs`, `todoist.rs`, `todoist_push.rs` (Todoist writes), `reminders_sync.rs`, `llm.rs`/`prompt.rs`/`extraction.rs` (model calls) |
| `src-tauri/src/` | Tauri shell: commands in `lib.rs`, `capture/`, `engine.rs` (bundled llama-server), `sync.rs`, `mirror.rs` (Things/Todoist passes, "Sync with Todoist"), `reminders/`, `calendar.rs` (meetings, `account_logo`), `calsync.rs`, `agents/` (MCP), `watch.rs`, `settings.rs`, `popover.rs` (menu-bar dropdown), `tray.rs` (menu-bar icon), `app_icons.rs` (installed apps' icons) |
| `src/` | React UI: `App.tsx`, `components/`, `lib/` (`api.ts` = every Tauri invoke, `types.ts`, `dates.ts`/`schedule.ts` = date parsing, `sourceLogos.ts` = where a task came from), `popover/` (menu bar), `quick/` (Quick Add), `main.tsx` (picks the view by window label, wraps it in `ViewBoundary`) |
| `src/assets/logos/` | Every app, site and agent logo, by id, with a README listing them |
| `src/whats-new.json` | Release notes, newest first. Shown in the app and copied into GitHub release notes |
| `scripts/ui-preview/preview.mjs` | Playwright screenshot tests against a faked Tauri backend (`scenario()`, `full()`, `shot()`) |
| `relay/` | Cloudflare Worker sync relay |

## Commands

```bash
cargo test --workspace     # Rust tests
cargo fmt --all            # CI fails on unformatted Rust
npm run typecheck          # tsc --noEmit
npm test                   # Vitest
npm run build              # typecheck + Vite build
npm run tauri dev          # run the app (macOS; needs scripts/build-llama-server.sh once)
```

UI preview: build, serve `dist/` on port 4173, then run `ONLY='name-regex' node scripts/ui-preview/preview.mjs http://localhost:4173 ./shots`.

Debugging a report: the app logs to `~/Library/Logs/TodoCity/todocity.log` (Settings → Help → Log file; started fresh past 2 MB), the bundled model to `~/Library/Logs/app.pluck.desktop/llama-server.log`. Errors while drawing a window show as `page error in <view>: Name: message` plus a stack of minified names. To map them, get the same build: `npm run build` on the release's commit gives the same `dist/assets/index-<hash>.js` (the hash in the log), or take it from the `ui-previews` branch (`app/assets/`), which holds the latest UI preview run's build.

## Shipping a change

1. Branch from an up-to-date `main`. Name it `v0.4.NN-short-name`.
2. Add tests with the change:
   - Rust tests go in `todocity-core`.
   - Vitest tests go in `src/**/*.test.ts`.
   - Add a `shot(...)` in `preview.mjs` for UI. Fake any new Tauri command there too.
3. **Bump the patch version only** (0.4.x → 0.4.x+1). Never jump to 0.5.0 unless the owner asks. The version appears in:
   - `Cargo.toml` (`[workspace.package] version`)
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `package-lock.json` (two places: top level and `packages[""]`)
   - `Cargo.lock` (the `todocity` and `todocity-core` entries)
4. Add a top entry to `src/whats-new.json`: a few short lines written for users, not developers.
5. Open a PR. Wait for every check to pass, then squash-merge:
   - **CI** (`ci.yml`): Rust core tests, Frontend (typecheck, Vitest, build), Desktop app (macOS build), Fuzz.
   - **Security** (`security.yml`): cargo-deny, OSV-Scanner, npm audit, zizmor, model catalog links. A new advisory can fail it on any branch overnight; if it can't reach TodoCity, accept it (see Rules).
   - **CodeQL**.
   - **UI preview** (`ui-preview.yml`, check name `shots`): runs only on pushes to `v0.*` branches that touch `src/`, `scripts/ui-preview/` or the workflow, and force-pushes the screenshots to the `ui-previews` branch (a failed shot leaves a `-FAILED.png`). Look at the new shots, not just the result. `full-side-resized` and `full-city-celebrate` are timing-sensitive: re-run the failed job once before digging in.
6. Release by running the `release.yml` workflow on `main` with `publish=true`. It builds the signed, notarized .dmg and the updater files, creates the `v0.4.NN` tag and publishes the GitHub release.
   - Apple's notary service sometimes times out (`NSURLErrorDomain … The request timed out`): re-run the failed job.
   - The **Protect release tags** ruleset blocks updating or deleting `v*` tags (admins bypass) but allows creating them, so the workflow can tag. Don't turn creation back on in it. (`cleanup-releases.yml` can't delete tags because of it; an admin deletes old ones by hand.)
   - Done when `releases/latest` is the new tag and its `latest.json` says the new version; the app picks that up as "Update ready".
7. If the change alters what the website says (a feature in a guide, a privacy line in the FAQ: `src/site.ts`, `src/pages/content.ts`), open a PR in `todo-city-website` and merge it after the release.

Docs-only changes (like this file) don't need a version bump or a release.

## Rules

- **The name is TodoCity**, one word, everywhere (never "Todo City").
- **Wording:** nothing in the app, Settings, README or website may sound negative, alarming or doubtful about TodoCity.
  - Say what to do: "Select some text first", not "No selected text found"; "Add AI model", not "No model yet".
  - Real errors on genuine failures are fine if they're specific and say how to fix the problem.
- **Privacy claims must stay true.** TodoCity is private by default: nothing leaves the Mac unless the user turns it on, and sending goes as far as they chose (one project at a time for "Sync with Todoist", never the Inbox or "Keep on this Mac only" projects). A feature that would break a claim ("agents can never read your tasks", "no analytics") must update that claim in the same release, in the app, `README.md` and the website.
- **The data folder is** `~/Library/Application Support/TodoCity/` (since 0.4.61). `data_folder::settle` moves the old `app.pluck.desktop` folder there once at launch and leaves a link at the old name. **Never change the bundle identifier** `app.pluck.desktop`: macOS permissions, Keychain items and login items are tied to it.
- **Synced tasks stay editable.** Keep-in-sync is two-way by default (Todoist now; Things comes in only, until its two-way and a TODO.md bridge land): changes here go back to the other app. People can switch a connector to one-way in its card, and synced tasks are never read-only either way.
- **Sync must never lose or resurrect tasks.** For any change touching `sync/`, `mirror.rs`, `mirror_out.rs`, `reminders_sync.rs` or how tasks are deleted or repeated, think through two Macs, offline edits, and deletes on both sides, and add tests. Helpers: `sync/engine.rs` has `send(a, b)`; `mirror_out/tests.rs` has a pretend Todoist (`App`, with `sync_project`) and `Mac`s joined by real Mac-to-Mac sync (`two_macs`, `both`, `LATER`); `reminders_sync.rs` has `FakeReminders` (with `unfindable` for EventKit's brief misses).
- **One item never stops a sync pass.** Report it in the pass's `errors` and carry on; save links so a clash is skipped, not returned with `?` (see `link_new`), and roll back half-made imports.
- **No real personal data** in code, tests, fixtures, screenshots or docs. Use made-up names (Sam, Maya, Priya, Dana).
- **Accepted security advisories** go in both `osv-scanner.toml` and `deny.toml`, each with a reason and a date to look again (`zip` 4 via the Windows-only updater has several).
- **Tests run without Node types:** `tsc` and Vitest see browser types only, so don't import `node:*` in `src/**/*.test.ts`; read bundled files through `import.meta.glob`.

## Design notes

- **Vocabulary:** prefer plain words (Projects, Sections, Tasks) in task screens. City words (buildings, floors, homes, residents) belong in the city view.
- **Mac sync:**
  - Last-writer-wins, field by field, with hybrid logical clocks and a shadow table.
  - A delete is the field `deleted = true`.
  - Changes coming from another Mac are written straight to the tables, skipping app logic, so repeats don't spawn twice.
  - "Keep on this Mac only" projects never leave the Mac.
- **Mirror (Things/Todoist keep-in-sync), shared by every connector:**
  - Each pass pulls first (`Store::mirror`), then, when two-way, plans what to send (`Store::mirror_outbox` → `Op`s), the connector carries them out, and `Store::mirror_sent` records each result. Planning is pure; a failed send is planned again next pass.
  - Three-way merge against `imports.base`: the pull applies fields the other app changed and moves the base; whatever still differs from the base was changed here and goes out. When both changed a field, the other app wins.
  - A task deleted in TodoCity never comes back (its `imports` row stays with no task). Deletes go out too; a safety brake holds back mass removals in both directions (more than 20 that are also more than half the linked tasks).
  - New open tasks in a synced project go out with a `todocity://task/<uid>` line in their notes; the pull strips that line and links a task carrying it (or an unlinked one with the same title and day) instead of adding it twice.
  - Two Macs: changes from another Mac that can't safely happen twice (adding a task, finishing a repeat) wait 10 minutes (`WAIT_FOR_OTHER_MAC_MS`, read from the sync shadow's HLC) so the Mac that made them goes first. A repeat finished here closes it there and moves the link to the next occurrence (by `next_id`, or the series uid on other Macs); when the other app shows the next date first, the pull moves the link instead.
  - A project that starts here joins with **Sync with Todoist** (its ⋯ menu; `mirror_sync_project`): the project is made in Todoist with its sections, or linked to an open top-level one with the same name (`todoist_push::same_name_project`), then `Store::mirror_link_project` records the match and the next pass sends its open tasks. Not offered for the Inbox, "Keep on this Mac only" projects, or with one-way sync. Syncing a stopped project again keeps tasks deleted on either side meanwhile. A Mac that joins a Todoist project to one here *by name* (`mirror_projects.joined_ms`) holds its new tasks for `WAIT_FOR_OTHER_MAC_MS` when paired, so the Mac that sent them links instead of doubling.
  - Moving a linked task into an unsynced project stops syncing it (the other app keeps its copy). "Keep on this Mac only" projects send nothing. Turning two-way on lets go of tasks deleted here while it was one-way (`mirror_start_two_way`).
  - Free: one connected app at a time, Pro: several, once Pro exists. Not enforced yet.
  - Things and Todoist live in Settings → Connectors (`ConnectorsTab.tsx`, `MoveIn.tsx`); how to move in and what goes where sit behind (i)s.
- **Repeats:** completing a repeating task calls `spawn_next`, which creates the next occurrence as a new task. `next_id` is local only. Rules are `todocity_core::recurrence::Repeat` (mirrored in `src/lib/repeat.ts`): the six presets keep their names (`weekly`), custom ones are `rrule:FREQ=…;INTERVAL=…;BYDAY=…;BYMONTHDAY=…;FROM=DONE;UNTIL=…;COUNT=…`. A deadline or UNTIL ends the series; COUNT counts down on each next one and on skip.
- **Task editing autosaves:** 500 ms after typing stops, and on blur or close.
- **AI agents (MCP):** add-only by default (`add_task` → review inbox, same reply every time). With **Full access** (`agents_full_access`, off by default) the `--mcp` helper lists every tool in `todocity_core::agent_tools` and forwards calls to the app as `ToolCall` lines on `agents.sock`; the app checks the setting on every call. New agent tools go in `agent_tools.rs` with tests there.
- **Agent changes:** every mutating tool call goes through `agent_log::record`, which snapshots before/after and writes `agent_changes` rows (one `batch` per call, kept 7 days) and marks tasks with `agent`/`agent_at` (local only, not synced). Any change by the person clears the mark. Undo restores the snapshot; deleted tasks come back with their uid. The header's View menu (`ViewMenu.tsx`: Everything · Only mine · Changed by agents, plus List/Board; `src/lib/agents.ts`) filters on that mark.
- **Tasks have a length:** `duration` in minutes (1–1440) next to `due_time` (any minute). Calendar draws blocks at their real start and size (`src/lib/timeblock.ts`).
- **Calendar view** (`WeekGrid.tsx`, Outlook-style): 72 px hours with a dashed half-hour line; blocks are a soft wash of their color (`--fill` mixed into `--paper` at `--tint`) with a solid left stripe and text in a tone of the same hue (`--block-ink`; deep on light, pale on dark), title only (time shows while dragging and in the hover peek). No side pane: a task's details open beside its block (`BlockPop.tsx`, placed by `blockPop.ts`, anchored on `data-block-id`). Clicking an empty slot adds a 1-hour task at that half hour (`CALENDAR_NEW_MIN`); first giving a task a time by dragging also makes it an hour. Drags snap to 15 min (`CAL_SNAP_MIN`, meetings too): a block keeps its grab offset (`useTaskDrag` `grabY` → `startFromTop`) and a same-size `.wg-shadow` copy shows where it lands. Moves there are quiet (`reschedule(…, { quiet: true })`, no toast).
- **Timeline** (`Timeline.tsx`, sidebar "Timeline", full screen only, no side pane): each project is a pastel bar from `projects.plan_start` to `plan_end` (`Store::set_project_plan`; synced between Macs as project fields, and a Mac that doesn't send them leaves the span alone). Math in `src/lib/timeline.ts` (whole day numbers, `dragSpan`, `barPlace`, `ZOOMS`). Drag a bar to move, its grips to stretch, across an empty row to plan (a click plans four weeks), click to open the project, right-click for color. The window pans with two-finger swipes; ‹ › and Today glide.
- **Pastels:** `.pastel` (and Calendar blocks) derive `--pastel-bg`, `--pastel-line` and `--block-ink` from `--fill`: the color lifted toward white (`--lift`), then washed into `--paper` (`--tint`). Saved project colors stay the plain palette (`PROJECT_COLORS`).
- **Sidebar projects:** one open at a time; opening one folds the others.
- **Calendar sync** (`todocity_core::calendar_sync`, Mac side in `src-tauri/src/calsync.rs`): timed tasks ↔ events, three-way merge against `calendar_links`. One calendar per project ("lane") grouped by mode, titled `TodoCity · <Mode> · <Project>`, never the default calendar. Events carry `todocity://task/<uid>` so two Macs link instead of duplicating. Event deleted → task deleted (with a safety brake). The meetings view hides `TodoCity · ` calendars.
- **Settings → AI** has three pages: **Agents** (`AgentsSection.tsx` → `AgentsPage`: connect agents to TodoCity's MCP server; `agents/apps.rs`, Codex via a marked block in `~/.codex/config.toml`), **Watch** (`WatchSection.tsx`) and **Open models** (`ModelsTab.tsx`; the catalog's `listed` models only, plus any already installed). Long explanations go in `InfoTip`s, not on the page.
- **Watch's reader** (`WatchSettings.reader`): `"local"` (open model) or an agent id. Agents are asked headless (`todocity_core::agent_llm`, `src-tauri/src/watch_agent.rs`), at most every 45 s and 40 times an hour, and only agents connected in Agents are offered. Their answers are checked exactly like the open model's.
- **Slack connector** (`todocity_core::slack` decides, `src-tauri/src/slack.rs` runs it; card in `ConnectorsTab.tsx`, `SlackConnector.tsx`): TodoCity never signs in to Slack; an agent the person uses (Claude Code, Codex, Cursor Agent: `SCAN_AGENTS`) reads it with its own Slack MCP. One switch: `slack_connect` picks the agent and emits `slack-setup`; App opens it in the agent panel with `setup_prompt` (Claude Code gets `--allowedTools mcp__todocity__slack_check` via `term_start`'s `allow`) and shows `SlackSetupDialog`. The agent calls the `slack_check` MCP tool (offered without full access, answers only the pending token) with its Slack read tools and a sample DM, which becomes the first task. Then a worker scans headless every 5 min (`scan_args`: Claude Code with only those read tools allowed) over `window(cursor, now)`: from the last good scan's end (minus 2 min overlap) to now, a day at a time, so a Mac that slept catches up. The agent answers JSON (`parse_scan`); code checks it, and each message (`channel:ts`) becomes at most one Inbox task (`State::seen`, plus `Store::has_source_url` for other Macs). State in `slack.json`, local only.
- **Apple Reminders sync** (`todocity_core::reminders_sync`): a reminder `get` can't find detaches its task, but EventKit can briefly miss one that still exists. A detached reminder that is still in the list is linked back in the same pass (`relinked`), and a bare copy an older version imported for it is let go (`stray_copy`). New links go through `link_new`, so one clash is reported and skipped, never stops the pass; an import that can't be linked is rolled back.
- **Menu-bar popover** (`popover.rs`) is made once and stays hidden between opens, and macOS may unload a hidden window's page. Each open emits `popover-check`; the page answers `popover_alive(check, drawn)` from `main.tsx` (outside React), and no answer in 1.2 s, or nothing drawn, reloads it (at most every 20 s). Every window's view sits in `ViewBoundary`: a drawing error goes to the log (`page_error`), reloads once, then shows a Reload card.
- **Motion:** one system: `--dur-1/2/3` (120/200/280 ms), `--ease`, `--spring` in `styles.css`, mirrored by `src/lib/motion.ts` (`DUR`, `EASE`). Pieces: `Collapse` (slides open/closed, unmounts after; sidebar sections and Projects), `Tick` (counts roll), `useFlip` (rows and section headers with `data-flip` glide together — headers as `g:<key>`; a change mid-glide carries on from where each item is on screen; `greet` softly shows ≤3 new rows; `paused` during drags), `useScrollEdges` (`data-scrolled` hairline, `data-more` bottom fade), the sidebar's `useGlide` (selection highlight per scroll area), `TitleTips` (title attributes become macOS-style tooltips: 550 ms first, instant for 900 ms after). Menus use `menu-in`; the main list cross-fades (`view-fade`, keyed by `viewKey`) and remembers scroll per list. **Reduce motion turns all of it off** (a catch-all at the end of `styles.css`, and `reducedMotion()` in JS): screenshots run with it on, and `motion: true` shots check the motion itself.
- **Avatar:** the mayor's profile picture (`MayorAvatar`, sidebar, city, Settings → Your city) is a DiceBear Notionists portrait with the Sunrise preset (`src/lib/avatar.ts`), drawn on the Mac from `look.avatar_seed` by the vendored `src/vendor/dicebear/` (core MIT, art CC0; parity-tested). Next picks a new random seed. `MayorFigure` is the 3D figure that walks in the city (`mayor_look`).
- **Right-click a task** (list rows, board cards, Calendar blocks, the menu-bar list): `openTaskMenu(e, task)` shows `TaskMenuHost`'s menu (Open, Mark as done, Duplicate, Delete) — one host per window. Text fields keep the Mac's own menu.
- **Updates:** downloaded quietly; full screen shows one "Update ready" pill in the footer (`VersionDot.tsx`), the menu-bar panel a banner. The version lives in Settings → General → Updates.
- **Logos** live in one folder, `src/assets/logos/<id>.svg|png` (official files only; never draw or recreate a brand logo; its README lists them). Light-only ones (Cursor, Grok, OpenAI) are in `DARK_TILE` and sit on a dark tile. Agents use the file or the installed app's icon (`app_icons.rs`), else a lettered tile. Where a task came from (`src/lib/sourceLogos.ts` → `logoKey`): the page's site by host (`siteFile`: Gmail, GitHub, Reddit…, beats the browser), a file by bundle id, a file by recorded name (Todoist, Things 3, Slack), an agent's logo (`agentIdOf`), else the Mac app's own icon by `source_bundle` (`source_icons`, `mdfind`, cached). `SourceChip` shows the logo instead of the name (name in the tooltip); Calendar puts it on a tile at each timed block's top-right corner (`SourceBadge`), and meetings get their account's (`EventInfo.account` from `calendar::account_logo`: Google → `google_calendar`, Exchange/Outlook → `outlook`). The all-day row keeps the small inline `SourceMark`. "Show where tasks came from: never" hides them all.
- **Moving meetings:** Calendar's grid drags a meeting when `todocity_core::meeting_move::movable` says so: your own events (`yes`), ones you organize (`everyone`, after "Move for everyone?"), never invites, read-only calendars, all-day events or TodoCity's own calendars. `calendar::move_event` saves that one occurrence (`EKSpan::ThisEvent`), found by id plus its start.
- **Keys in task lists** (T, D, M…) are changeable in the Keyboard shortcuts sheet: `todocity_core::app_keys` (ids, defaults, `clean`) mirrored by `src/lib/appKeys.ts`; settings store only changed keys (`app_keys`). The App key handler goes through `actionFor`; Space, ↵ and arrows always work too.
- **Focus Blocks** (`todocity_core::focus` decides, `src-tauri/src/focus.rs` acts): every timed event on the Focus calendar (`FocusSettings.calendar`, a `calendar::key`) is a block. macOS has no API to set Focus, so TodoCity runs a Shortcuts shortcut (`/usr/bin/shortcuts run "TodoCity Focus" --input-path …`) with the ISO end time (Focus on *until* then, so macOS ends it itself) or `off`. A worker looks every 20 s and on `calendar-changed`; `focus::plan` merges touching blocks, starts late ones with 5+ min left, follows a running block's new end, turns Focus off when it's deleted (after a second look), and never restarts one ended with End now. State in `focus.json`; picked tasks in `focus_tasks` by occurrence key (`id@start`), local only. "Focus…" typed in Calendar's hour field makes a block (`parseFocusEntry`); `calendar_events` marks focus events (`focus: true`). `SHORTCUT_LINK` is `None` until a shared shortcut link exists; Settings shows the steps meanwhile.
- **Capture is untrusted input.** Selected text is treated as data, never as instructions. The model returns three fields under a JSON Schema, and code (not the model) works out dates.
