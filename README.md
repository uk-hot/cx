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

Restores a registered account's `auth.json`/`config.toml`, then synchronizes the
`model_provider` metadata of all rollout files and SQLite rows to the switched
account's provider. If the account can't be identified uniquely, you'll be
prompted to choose (in a TTY).

### `cx list`

Lists the accounts registered in the registry (email/alias and provider), marking the
active one with `*`. It is read-only and offline — it does not contact any
provider/usage API.

### `cx remove <email|alias>`

Removes a registered account and its snapshot files from the registry.

## How it works

On a `switch` (and its underlying sync), `cx`:

1. Acquires a lock under `~/.codex/tmp/` so two runs can't interfere.
2. Persists the current account's latest OAuth credentials before replacing
   `auth.json`, preserving token refreshes made by Codex since `cx add`.
3. Scans `sessions/` and `archived_sessions/` for `rollout-*.jsonl` files and
   collects those whose `session_meta` first line has a different provider.
4. Verifies the SQLite database is writable, then **rewrites the rollout files
   first** (outside any DB transaction) and **updates SQLite in a short
   transaction** — keeping the database lock brief regardless of file count.
5. If the SQLite update fails, the already-rewritten rollout files are rolled
   back byte-for-byte, so the two stores never diverge.

On Windows, rollout files are opened exclusively and rewritten via a single
batched PowerShell pass; files locked by a running Codex are skipped and
reported rather than corrupted.

## Data & safety

- `cx` reads and writes only under `~/.codex`.
- `cx add` copies your `auth.json` (which contains OAuth tokens) into
  `~/.codex/accounts/`. Treat that directory as sensitive.
- Close Codex and the Codex app before switching if files are reported as locked.

## Changelog

### 0.2.6

- Preserve OAuth token refreshes before switching accounts, so returning to a
  ChatGPT account does not restore stale credentials and require another login.
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
