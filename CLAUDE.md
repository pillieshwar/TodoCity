# TodoCity: notes for AI coding agents

TodoCity is a private, Mac-first to-do app. Select or copy text in any app, press ⌘C twice, and an on-device model writes the task. Each project is a building in a 3D city, and finishing tasks moves residents in. The stack is Tauri v2, Rust and React/TypeScript. User-facing docs are in `README.md`; the website lives in a separate repo, `pillieshwar/todo-city-website`.

## Layout

| Path | What |
|---|---|
| `crates/todocity-core/src/` | Pure Rust core with unit tests: `store.rs` (SQLite schema, migrations, tasks, repeats), `sync/` (Mac-to-Mac sync), `mirror.rs` (Things/Todoist keep-in-sync: bringing changes in), `mirror_out.rs` (two-way: sending changes back), `things.rs`, `todoist.rs`, `todoist_push.rs` (Todoist writes), `reminders_sync.rs`, `llm.rs`/`prompt.rs`/`extraction.rs` (model calls) |
| `src-tauri/src/` | Tauri shell: commands in `lib.rs`, `capture/`, `engine.rs` (bundled llama-server), `sync.rs`, `mirror.rs`, `reminders/`, `calendar.rs`, `agents/` (MCP), `watch.rs`, `settings.rs` |
| `src/` | React UI: `App.tsx`, `components/`, `lib/` (`api.ts` = every Tauri invoke, `types.ts`, `dates.ts`/`schedule.ts` = date parsing), `popover/` (menu bar), `quick/` (Quick Add) |
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
5. Open a PR. Wait for CI (`ci.yml`, `security.yml`, CodeQL, `ui-preview.yml`) to pass, then squash-merge.
6. Release by running the `release.yml` workflow on `main` with `publish=true`. It builds the signed, notarized .dmg and the updater files.

Docs-only changes (like this file) don't need a version bump or a release.

## Rules

- **Wording:** nothing in the app, Settings, README or website may sound negative, alarming or doubtful about TodoCity.
  - Say what to do: "Select some text first", not "No selected text found"; "Add AI model", not "No model yet".
  - Real errors on genuine failures are fine if they're specific and say how to fix the problem.
- **Privacy claims must stay true.** TodoCity is private by default: nothing leaves the Mac unless the user turns it on. A feature that would break a claim ("agents can never read your tasks", "no analytics") must update that claim in the same release, in the app, `README.md` and the website.
- **The data folder is** `~/Library/Application Support/TodoCity/` (since 0.4.61). `data_folder::settle` moves the old `app.pluck.desktop` folder there once at launch and leaves a link at the old name. **Never change the bundle identifier** `app.pluck.desktop`: macOS permissions, Keychain items and login items are tied to it.
- **Synced tasks stay editable.** Keep-in-sync is two-way by default (Todoist now; Things and a TODO.md bridge next): changes here go back to the other app. People can switch a connector to one-way in its card, and synced tasks are never read-only either way.
- **Sync must never lose or resurrect tasks.** For any change touching `sync/`, `mirror.rs`, `reminders_sync.rs` or how tasks are deleted or repeated, think through two Macs, offline edits, and deletes on both sides, and add tests (`sync/engine.rs` has a `send(a, b)` helper).
- **No real personal data** in code, tests, fixtures, screenshots or docs. Use made-up names (Sam, Maya, Priya, Dana).
- **Accepted security advisories** go in both `osv-scanner.toml` and `deny.toml`, each with a reason and a date to look again.

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
- **Calendar sync** (`todocity_core::calendar_sync`, Mac side in `src-tauri/src/calsync.rs`): timed tasks ↔ events, three-way merge against `calendar_links`. One calendar per project ("lane") grouped by mode, titled `TodoCity · <Mode> · <Project>`, never the default calendar. Events carry `todocity://task/<uid>` so two Macs link instead of duplicating. Event deleted → task deleted (with a safety brake). The meetings view hides `TodoCity · ` calendars.
- **Settings → AI** has three pages: **Agents** (`AgentsSection.tsx` → `AgentsPage`: connect agents to TodoCity's MCP server; `agents/apps.rs`, Codex via a marked block in `~/.codex/config.toml`), **Watch** (`WatchSection.tsx`) and **Open models** (`ModelsTab.tsx`; the catalog's `listed` models only, plus any already installed). Long explanations go in `InfoTip`s, not on the page.
- **Watch's reader** (`WatchSettings.reader`): `"local"` (open model) or an agent id. Agents are asked headless (`todocity_core::agent_llm`, `src-tauri/src/watch_agent.rs`), at most every 45 s and 40 times an hour, and only agents connected in Agents are offered. Their answers are checked exactly like the open model's.
- **Updates:** downloaded quietly; full screen shows one "Update ready" pill in the footer (`VersionDot.tsx`), the menu-bar panel a banner. The version lives in Settings → General → Updates.
- **Agent icons** come from `src/assets/agents/<id>.svg|png` (official files, if added) or the installed app's own icon (`app_icons.rs`), else a lettered tile. Never draw or recreate a brand logo.
- **Moving meetings:** Calendar's grid drags a meeting when `todocity_core::meeting_move::movable` says so: your own events (`yes`), ones you organize (`everyone`, after "Move for everyone?"), never invites, read-only calendars, all-day events or TodoCity's own calendars. `calendar::move_event` saves that one occurrence (`EKSpan::ThisEvent`), found by id plus its start.
- **Keys in task lists** (T, D, M…) are changeable in the Keyboard shortcuts sheet: `todocity_core::app_keys` (ids, defaults, `clean`) mirrored by `src/lib/appKeys.ts`; settings store only changed keys (`app_keys`). The App key handler goes through `actionFor`; Space, ↵ and arrows always work too.
- **Capture is untrusted input.** Selected text is treated as data, never as instructions. The model returns three fields under a JSON Schema, and code (not the model) works out dates.
