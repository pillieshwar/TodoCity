# Security policy

TodoCity reads the text you select and keeps your tasks on your Mac, so we take
security reports seriously and answer them quickly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:

1. Go to the repository's **Security** tab → **[Report a vulnerability](https://github.com/pillieshwar/TodoCity/security/advisories/new)**.
2. Describe the problem, the version of TodoCity (Settings → General), your macOS version, and how to reproduce it.

You can expect:

- an acknowledgement within **3 days**,
- an assessment and a plan within **10 days**,
- a fix released as soon as it's ready, usually within **30 days** for serious issues,
- credit in the release notes and the advisory, if you'd like it.

## Supported versions

Only the **latest release** gets security fixes. TodoCity updates itself, so
staying current is automatic unless you've turned off **Update automatically**.

## What's in scope

- The TodoCity app and its update mechanism
- The bundled model runtime as TodoCity configures it
- The release workflow and the files it publishes

Bugs in third-party dependencies are welcome too; we'll coordinate with the
upstream project.

## How TodoCity protects you

- **Local only.** Selections and tasks never leave the Mac. (The Slack
  connector was removed in 0.4.20; on first launch TodoCity revokes any old
  Slack sign-in and deletes it from the Keychain.)
- **Write-only AI agents.** `TodoCity --mcp` offers AI apps one tool,
  `add_task`, and nothing to read. It reaches the app over a Unix socket that
  only the user can open (mode 0600, no network). Every accepted task gets the
  same reply — no ids, counts or duplicate checks — and lands in an inbox the
  user reviews before anything joins the task list. Off by default; rate- and
  size-limited. TodoCity only edits another app's MCP settings when the user
  clicks Connect, changes only its own `todocity` entry, and keeps a
  `.todocity-backup` of the original file.
- **Watch mode** (off by default) reads the static text of the frontmost
  window of any app through Accessibility — except password managers,
  Keychain Access, System Settings, security dialogs, terminals and TodoCity,
  which are never read, and any app the user skips. It never reads text fields or password fields, keeps only
  hashes of lines it has seen (in memory), and sends nothing off the Mac;
  the on-device model's suggestions go to the review inbox.
- **Local model.** The model runtime
  listens on `127.0.0.1` only, on a random port with a random key.
- **Signed updates.** Every in-app update is verified against the project's
  public key before it's installed.
- **Verified downloads.** Models are checked against published SHA-256 sums;
  every release publishes `SHA256SUMS.txt` and a signed build-provenance
  attestation (see the README for how to verify a download).
- **Dependency checks.** Locked dependencies, weekly Dependabot updates, and
  cargo-deny, npm audit, OSV-Scanner and zizmor on every pull request.
