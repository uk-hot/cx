# @uk-hot/cx

Manage multiple Codex accounts and keep their session **provider** metadata
consistent. `cx` switches between registered Codex accounts and, on every switch,
rewrites the `model_provider` field across your rollout files (`rollout-*.jsonl`)
and the Codex SQLite state (`state_5.sqlite`) so the whole session history stays
in sync with the active account's provider.

Codex home is fixed to `~/.codex`.

## Requirements

- **Node.js >= 22**
- Native dependency **`better-sqlite3`** (compiled/prebuilt at install time)

> **Note (npm 11.16+ / npm 12):** install scripts are gated by `allowScripts`.
> If the native build is skipped during a global install, allow it explicitly:
>
> ```bash
> npm install -g --allow-scripts=better-sqlite3 @uk-hot/cx
> ```

## Install

```bash
npm install -g @uk-hot/cx
```

## Usage

```
cx status
cx switch <email|alias>
cx add [alias]
cx list
cx remove <email|alias>
```

### `cx status`

Shows the current provider (from `~/.codex/config.toml`) and the per-provider
counts found in your rollout files and in the SQLite state, so you can see at a
glance whether everything is aligned.

### `cx add [alias]`

Snapshots the current `~/.codex/auth.json` and `config.toml` into
`~/.codex/accounts/` and registers the account. For ChatGPT/OAuth logins the
identity (email, account id) is auto-detected from `auth.json`; for other logins
provide an `alias`:

```bash
cx add work
```

### `cx switch <email|alias>`

Restores a registered account's `auth.json` and its provider/model settings from
the saved `config.toml`, then synchronizes the `model_provider` metadata of all
rollout files and SQLite rows to the switched account's provider. If the account
can't be identified uniquely, you'll be prompted to choose (in a TTY).

Only these `config.toml` settings belong to an account: `model_provider`,
`model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
`model_context_window`, `model_auto_compact_token_limit`, `service_tier`,
`profile`, the login/base-URL keys, and the `[model_providers.*]` and
`[profiles.*]` tables. Everything else — trusted projects, MCP servers, approval
and sandbox settings, TUI state — is kept from the live config, so changes made
after `cx add` survive a switch.

### `cx list`

Lists the accounts registered in the registry (email/alias and provider), marking the
active one with `*`. It is offline — it does not contact any provider/usage API —
and only writes the registry to record the account currently logged in to
`auth.json`.

### `cx remove <email|alias>`

Removes a registered account and its snapshot files from the registry. An
identifier that only partially matches an account must be confirmed in a TTY.

## How it works

On a `switch` (and its underlying sync), `cx`:

1. Acquires a lock under `~/.codex/tmp/` so two runs can't interfere.
2. Persists the current account's latest OAuth credentials and provider/model
   settings before replacing them, preserving token refreshes made by Codex and
   settings changed since `cx add`.
3. Scans `sessions/` and `archived_sessions/` for `rollout-*.jsonl` files and
   collects those whose `session_meta` first line has a different provider.
4. Skips rollout files another process still has open (a running Codex session
   would otherwise keep appending to the replaced file and lose those events).
5. Verifies the SQLite database is writable, then **rewrites the rollout files
   first** (outside any DB transaction) and **updates SQLite in a short
   transaction** — keeping the database lock brief regardless of file count.
   Rows of skipped rollout files keep their provider.
6. If the SQLite update fails, the already-rewritten rollout files are rolled
   back, so the two stores do not diverge.

Open files are detected via `/proc` on Linux, `lsof` on macOS, and an exclusive
open on Windows, where rollouts are rewritten via a single batched PowerShell
pass. Skipped files are reported rather than corrupted; re-run `cx switch` after
closing Codex to sync them.

## Data & safety

- `cx` reads and writes only under `~/.codex`.
- `cx add` copies your `auth.json` (OAuth tokens or API keys) and `config.toml`
  into `~/.codex/accounts/`, readable by the owner only. Treat that directory as
  sensitive.
- Close Codex and the Codex app before switching if files are reported as locked.

## Changelog

### 0.2.8

- Ship `src/cli.js` as executable again; with 0.2.7 a global install failed
  with "Permission denied" when running `cx`.

### 0.2.7

0.2.6 was tagged on GitHub but never published to npm; its changes are
included here.

- `cx switch` no longer replaces the whole `config.toml` with the snapshot from
  `cx add`; only provider/model settings are per account, so trusted projects
  and MCP servers added later are kept.
- Preserve OAuth token refreshes and provider/model settings before switching
  accounts, so returning to an account does not restore stale state.
- Skip rollout files that a running Codex still has open on Linux and macOS
  (previously only on Windows), and keep rewritten rollouts' file mode.
- The SQLite update leaves threads of skipped rollout files unchanged.
- Read `model_provider` written with single quotes, with a trailing comment, or
  from the active `profile`; these were treated as the default `openai`.
- `cx add <alias>` with a third-party provider registers a manual account even
  if `auth.json` still holds ChatGPT tokens.
- Snapshots and the registry are written atomically with owner-only permissions;
  registry updates take the `cx` lock; a lock left without an owner file is
  recovered after a minute.
- Snapshot file names use base64url, so no account key can produce a `/`.
- `cx remove` asks for confirmation when the identifier only partially matches.
- `cx save` was renamed to `cx add`; `cx save` still works as a deprecated alias.
- Hold the `cx` lock across the complete account switch and provider sync.

### 0.2.5

- `cx list` no longer prints the trailing per-provider count summary; it now
  shows only the registered-account listing.

### 0.2.4

- Restored the `list` command — a lightweight, offline listing of the accounts
  registered in the registry (email/alias, provider, active marker) with a
  per-provider count summary. Unlike the pre-0.2.3 version it does not contact
  any usage API.

### 0.2.3

- Removed the `list` and `usage` subcommands.
- Sync now rewrites rollout files first and updates SQLite in a short
  transaction, rolling the files back byte-for-byte if the database update
  fails — keeping the database lock brief and the two stores consistent.
- On Windows, rollout rewrites and rollbacks run in a single batched pass
  instead of one PowerShell process per file.

## License

MIT © uk-hot
