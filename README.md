# @uk-hot/cx

Manage multiple Codex accounts and keep their session **provider** metadata
consistent. `cx` switches between registered Codex accounts and, on every switch,
rewrites the `model_provider` field across your rollout files (`rollout-*.jsonl`)
and the Codex SQLite state (`state_5.sqlite`) so the whole session history stays
in sync with the active account's provider. It also removes the per-account
tags Codex 0.168+ puts on sessions, so after a switch every account sees the
sessions that existed at that point.

Codex home is fixed to `~/.codex`.

## Requirements

- **Node.js 22.13+ or 23.4+** (uses the built-in `node:sqlite`; no native addon, no install scripts)

## Install

```bash
npm install -g @uk-hot/cx
```

## Usage

```
cx status
cx switch <email|alias>
cx add [alias]
cx warm [start|stop|--watch]
cx list
cx remove <email|alias>
cx sessions [<email|alias>|--unassigned]
cx sessions assign <email|alias> <id>...
cx sessions delete <email|alias> <id>... | --all
cx sessions delete --unassigned
```

### `cx status`

Shows the current provider (from `~/.codex/config.toml`) and the per-provider
counts found in your rollout files and in the SQLite state, so you can see at a
glance whether everything is aligned.

Below that, printed last because it needs the network, is the live 5-hour and
weekly quota left on every registered account signed in with ChatGPT. The account
Codex is logged in to is marked `*`:

```text
ACCOUNT USAGE
+---------------------+------+------------------------+-------------------------+
| ACCOUNT             | PLAN | 5H LEFT                | WEEKLY LEFT             |
+---------------------+------+------------------------+-------------------------+
| * one@example.com   | team | 33% (resets in 3h 40m) | 90% (resets in 6d 22h)  |
|   two@example.com   | plus | 0% (resets in 9m)      | 22% (resets in 5d 20h)  |
+---------------------+------+------------------------+-------------------------+
```

A window that hasn't started yet shows `not started` (see [`cx warm`](#cx-warm-startstop--watch)).
API-key logins and third-party providers have no such limits and are left out. A
plan without a limit shows `-`, and a limit of any other length gets an
`OTHER LIMITS` column. An account that cannot be read shows why, and the others
are still listed:

- `sign-in expired`: its saved access token has expired. `cx status` never
  refreshes tokens, because a refresh token is single-use and refreshing one here
  could sign out a running Codex. `cx switch` to the account and use Codex to
  renew it. If Codex asks you to sign in instead, its login is gone: sign in to
  it again with `cx add` (see [Signing in again](#signing-in-again)).
- `signed out`: its access token was rejected before it expired, so the login
  was revoked — by `codex logout`, by signing in to the account somewhere that
  replaced this login, or by OpenAI. Codex usually can't renew it; sign in to
  it again with `cx add`.
- `no saved login`: its snapshot is missing, malformed or belongs to another
  account. Sign in to it again with `cx add`.
- `timed out`, `unreachable`, `HTTP <code>`: the usage request failed.
- `unexpected response`: the usage endpoint answered in a format `cx` doesn't
  know.

For each account with one of the first three, the table is followed by the
command that fixes it.

The request honours `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. It doesn't use
the macOS or Windows system proxy, so set those variables if chatgpt.com is only
reachable through one.

### `cx add [alias]`

Signs in to another account through Codex's own sign-in screen and registers it:

1. Saves the currently logged-in account, so it stays usable.
2. Removes `~/.codex/auth.json`, so Codex starts its sign-in.
3. Opens Codex, where you choose how to sign in: ChatGPT, device code, or API key.
4. Registers the new login when you exit Codex.

```bash
cx add            # identity (email, account id) is auto-detected
cx add work       # also gives the new account an alias
```

`delete` and `assign` can't be aliases: `cx sessions` reads them as its actions.

Close Codex before running `cx add`. If you exit Codex without signing in, the
previous login is restored. Signing in to a registered account refreshes its
credentials instead of adding a duplicate, which also recovers an expired or
revoked login (see [Signing in again](#signing-in-again)). If the browser opens
an account that is already signed in, use a private window.

When `cx add` signs in to an account that isn't the one Codex was using, it says
so and prints the `cx switch` that goes back to the previous one.

An API key or another login without an email needs the alias: pass it to
`cx add`, or run `cx add <alias>` after Codex exits. If `cx add` is interrupted
after signing in, the login stays active and `cx switch` registers it first.

> **Do not run `codex login` or `codex logout` directly while `~/.codex` holds an
> account you want to keep.** Both revoke its tokens on OpenAI's side, which also
> invalidates the snapshot `cx` saved. `cx add` removes `auth.json` first to
> avoid this.

Third-party providers have no sign-in screen, so `cx add <alias>` snapshots them
from `~/.codex` instead of opening Codex. To add one, configure it in Codex first:

```bash
cx add gateway
```

An API key that isn't saved yet would be replaced by a sign-in, so `cx add`
without an alias stops and asks for one. Once it is saved, `cx add` signs in as
usual.

Like `cx switch`, a `cx add` that signs in (including one that refreshes an
already registered account) restarts a running Codex app-server daemon so it
uses the new login (see below). Snapshotting a third-party provider or an API
key doesn't change the login, so it leaves the daemon alone.

#### Signing in again

An account whose login expired or was revoked — `cx status` shows `sign-in
expired` or `signed out`, or Codex says its access token could not be refreshed
and asks you to sign in — doesn't need to be removed and added back. Run
`cx add` and sign in to that same account: its saved login is replaced, and its
alias and registration are kept.

```bash
cx add            # sign in as the account that expired
```

If the browser picks another account that is already signed in, that account is
added (or refreshed) instead; sign in to the right one in a private window. A
login whose access token merely expired can usually be renewed without signing
in: `cx switch` to it and use Codex.

### `cx switch <email|alias>`

Restores a registered account's `auth.json` and its provider/model settings from
the saved `config.toml`, then synchronizes the `model_provider` metadata of all
rollout files and SQLite rows to the switched account's provider. If the account
can't be identified uniquely, you'll be prompted to choose (in a TTY).

Codex 0.168+ records which ChatGPT account created a session
(`account_scoped`, `creator_user_id` and `creator_account_id` in the rollout's
`session_meta`, and the `creator_*` columns in SQLite) and its session picker
then hides sessions created with another account. `cx switch` removes these tags,
which makes the sessions shared like the ones created before Codex 0.168, so
switching accounts keeps your session history visible. This also applies when
both accounts use the same provider. Sessions created after the switch are
tagged again until the next `cx switch`; a login changed with `codex login`
instead of `cx` does not remove any tags.

A ChatGPT login that isn't registered yet is registered before it is replaced.
An API key that isn't saved can't be recovered once replaced, so `cx switch`
stops and asks you to save it with `cx add <alias>` first.

Only these `config.toml` settings belong to an account: `model_provider`,
`model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
`model_context_window`, `model_auto_compact_token_limit`, `service_tier`,
`profile`, the login/base-URL keys, and the `[model_providers.*]` and
`[profiles.*]` tables. Everything else — trusted projects, MCP servers, approval
and sandbox settings, TUI state — is kept from the live config, so changes made
after `cx add` survive a switch.

Codex sessions send their requests through a shared app-server daemon
(`codex app-server --managed-daemon`), which reads `auth.json` only when it
starts. Without a restart, sessions opened or resumed after a switch would keep
using the previous account and its usage limits. So after a successful switch
`cx` runs `codex app-server daemon restart` — only if the daemon is running; it
never starts one. Codex sessions that were open are disconnected; reopen them
with `codex resume`. The daemon keeps the rollout files of open sessions open,
so the switch skips them; once the daemon has restarted, `cx` syncs those files
too. To keep a running task from being interrupted, let it finish before
switching. If the restart fails, `cx` keeps the switch and prints the command to
run.

A missing `config.toml` is fine: it means Codex's defaults, i.e. the `openai`
provider.

### `cx warm [start|stop|--watch]`

A weekly quota window doesn't start when the previous one ends, but with the
first request after that. An account left unused after its weekly reset keeps a
full but idle window, and its next week only starts when it is used again, so
every idle hour pushes its next reset back. `cx warm` starts every idle weekly
window right away with the smallest Codex request there is:

```text
$ cx warm
one@example.com  weekly window started (resets in 7d 0h)
two@example.com  weekly window running (22% left, resets in 5d 20h)
```

To have that happen on its own as soon as each window resets, run it in the
background:

```bash
cx warm start   # runs in the background from now on
cx warm stop    # stops it and turns it off
```

The background `cx warm` checks again a minute after the earliest weekly reset
of all accounts, at least every 30 minutes (which picks up added or renewed
accounts), and 5 minutes after a failure that may pass. An account whose
request failed is not sent another one for an hour. It logs to
`~/.codex/log/cx-warm.log` (the state of every account on start, then only
what changed),
and `cx status` shows whether it runs. It stops with the machine, and any `cx`
command starts it again until `cx warm stop`; after it failed to start, they
try again 10 minutes later, and `cx status` says why it failed. `cx warm
--watch` does the same in the terminal instead; only one of them runs at a time.

It works apart from the Codex you are using:

- Each request runs in a private Codex home under `~/.codex/tmp/` holding a copy
  of the account's login, also for the account Codex is logged in to. It is
  `codex exec --ephemeral` with the prompt `Reply with OK.` at low reasoning
  effort, without your `config.toml`, rules, project, sessions or app-server
  daemon, and uses a sliver of the quota (and starts the 5-hour window as
  well). It usually takes under a minute per account, and is given up after 3.
  Whatever that Codex starts ends with it, and when `cx warm` is stopped.
- `cx` holds its lock only for the moment it saves tokens, never while Codex
  runs, so `cx switch` and the other commands keep working.
- Codex refreshes old tokens on the way. A refresh token is single-use, so `cx`
  saves the refreshed tokens back to the account's snapshot, and to
  `~/.codex/auth.json` while Codex is logged in to that account (never older
  ones over newer), within a second of Codex writing them rather than once it
  is done. A running Codex rereads `auth.json` before it refreshes a token or
  after one is rejected, so it picks them up. The private home is then
  removed; one left behind by an interrupted run is recovered by the next, once
  the Codex it started has ended.

Which accounts are sent a request:

- A window is idle when it is 0% used and resets a whole window from now; `cx
  status` shows it as `not started`. Only accounts signed in with ChatGPT have
  one.
- Every idle weekly window.
- While you use Codex, every idle 5-hour window too, of the accounts with at
  least 10% of their week left. The account you work with started its own 5-hour
  window, and the others then have theirs already running down when you switch
  to them. If you keep working past a 5-hour reset, the window is started again
  a minute after it ends; once you stop, they are left alone. Codex counts as in
  use while one of its sessions (terminal or app) was written to in the last 10
  minutes; the background `cx warm` notices within a minute that you started.
- An account whose saved sign-in expired can't report its quota, so it is sent
  the request as well: it renews the sign-in. Not the account Codex is logged
  in to: Codex renews that one itself when you use it, and both refreshing the
  same token at once would sign it out. Accounts that are signed out or have no
  saved login are only reported.

`cx warm` without `start` makes one pass and exits with status 1 if a request
failed, or went through but the window still shows as not started.

### `cx list`

Lists the accounts registered in the registry (email/alias and provider), marking the
active one with `*`. It is offline — it does not contact any provider/usage API —
and only writes the registry to record the account currently logged in to
`auth.json` (and, when that changed behind `cx`'s back, the session owners it
can tell from creator tags).

### `cx sessions`

`cx switch` shares every session with every account, so Codex no longer knows
whose a session is. `cx` keeps track of it instead, in
`~/.codex/accounts/threads.json`: a session belongs to the account that used it
last, i.e. the one logged in when its latest turn started. Resuming another
account's session moves it to the account resuming it.

```text
$ cx sessions
+------------------+----------+-------------+
| ACCOUNT          | SESSIONS | WITH MEMORY |
+------------------+----------+-------------+
| one@example.com  | 12       | 3           |
| two@example.com  | 4        | 0           |
| (unassigned)     | 1250     | 41          |
+------------------+----------+-------------+
```

`cx sessions <email|alias>` lists that account's sessions (id, last update,
how `cx` learned the owner, whether Codex extracted a memory from it, title);
`cx sessions --unassigned` lists the ones no registered account owns.

How the owner is known:

- `activity`: whenever the account changes (`cx switch`, `cx add`), and on
  each `cx sessions`, the sessions whose latest turn started since the account
  became active are credited to it. This only counts while
  `auth.json` holds that account's login; after a `codex login` behind `cx`'s
  back, only creator tags are used until the next `cx switch`.
- `tag`: Codex 0.168+ tags a new session with the ChatGPT account that created
  it, until `cx switch` clears the tag. `cx` reads the tags before it clears
  them, and a tag also wins over `activity` for a session created by another
  login than the active one.
- `manual`: `cx sessions assign <email|alias> <id>...` gives sessions to an
  account by hand.

Sessions from before `cx` tracked owners, sessions of a removed account, and
those used under a login `cx` couldn't attribute are unassigned. Sessions with
API-key and third-party accounts have no tags, so only `activity` and `manual`
apply to them.

`cx sessions delete` permanently deletes sessions with everything Codex keeps
about them:

```bash
cx sessions delete work 01a1f743 01a1f7c9   # these sessions of "work" (an id or a unique prefix)
cx sessions delete work --all               # every session of "work"
cx sessions delete --unassigned             # every session no account owns
cx sessions delete work --all --dry-run     # only show what would be deleted
```

Each session is deleted with `codex delete --force <id>`, which removes its
rollout file, its rows in Codex's databases (including the paginated thread
history), its session name, and the memory Codex extracted from it. `cx` then removes its prompts from `history.jsonl`, its
shell snapshots and its other leftovers. A session the given account doesn't
own is refused. `codex delete` also deletes the sub-agent sessions a session
spawned, so they are listed with it, and a session with a sub-agent session of
another owner is left alone (`cx` says which).

- `cx` lists what it will delete and asks first; outside a terminal it needs
  `--yes`. Nothing can be restored afterwards.
- Sessions that Codex has open are skipped; close them and run it again. A
  session another account used between the confirmation and the delete is
  skipped too.
- Codex appends to `history.jsonl` while it runs, so close Codex before a
  delete if you can. If the prompts or leftover files of deleted sessions can't
  be removed, or the delete is interrupted, the next `cx sessions` command
  finishes it.
- Codex rebuilds its consolidated memory (`~/.codex/memories`) without the
  deleted sessions the next time it runs with memories on; until then, what it
  had already merged in from them stays there.
- It needs a Codex with `codex delete --force` (0.171 has it).
- It deletes local data only: OpenAI's records of the requests and Codex Cloud
  tasks are not affected.

### `cx remove <email|alias>`

Removes a registered account and its snapshot files from the registry. An
identifier that only partially matches an account must be confirmed in a TTY.
Removing the account Codex is logged in to leaves `auth.json` as it is, so Codex
stays signed in, but neither `cx switch` nor `cx add` registers that login
again. To add it back, sign in to it with `cx add`. A removed API key that is
still in `auth.json` no longer counts as unsaved, so `cx switch` and `cx add`
can replace it (the registry keeps only its SHA-256 digest); `cx add <alias>`
adds it back. `cx remove` doesn't change the login, so it never restarts the
Codex app-server daemon. The account's sessions stay and become unassigned.

## How it works

On a `switch` (and its underlying sync), `cx`:

1. Acquires a lock under `~/.codex/tmp/` so two runs can't interfere.
2. Persists the current account's latest OAuth credentials and provider/model
   settings before replacing them, preserving token refreshes made by Codex and
   settings changed since `cx add`.
3. Scans `sessions/` and `archived_sessions/` for `rollout-*.jsonl` files and
   collects those whose `session_meta` first line has a different provider or
   carries a creator tag (`account_scoped`, `creator_user_id`,
   `creator_account_id`), which is removed.
4. Skips rollout files another process still has open (a running Codex session
   would otherwise keep appending to the replaced file and lose those events).
5. Verifies the SQLite database is writable, then **rewrites the rollout files
   first** (outside any DB transaction) and **updates SQLite in a short
   transaction** — keeping the database lock brief regardless of file count.
   The transaction also clears the `creator_user_id`/`creator_account_id`
   columns; Codex fills empty columns from the rollout file, so both stores must
   be cleared. Rows of skipped rollout files keep their provider and creator.
6. If the SQLite update fails, the already-rewritten rollout files are rolled
   back, so the two stores do not diverge.

Open files are detected via `/proc` on Linux, `lsof` on macOS, and an exclusive
open on Windows, which cx keeps while it rewrites the file so Codex cannot open
it in between. A thread whose writer lock (`~/.codex/thread-writer-locks/`,
Codex 0.168+) is held open counts as in use too, even while its rollout file is
closed. Skipped files are reported rather than corrupted; re-run
`cx switch` after closing Codex to sync them.

## Data & safety

- `cx` reads and writes only under `~/.codex`.
- `cx status` and `cx warm` send each OpenAI account's access token to
  `https://chatgpt.com/backend-api/wham/usage`, an undocumented endpoint that
  Codex calls too and that may change without notice. No other command contacts
  a usage API, and the result is not cached or written anywhere.
- `cx warm` runs `codex exec` as each account whose weekly window is idle, which
  sends one short request to OpenAI and may refresh that account's tokens. The
  private Codex home it uses for that holds a copy of the account's login while
  it runs.
- `cx sessions delete` runs `codex delete` and rewrites `history.jsonl`
  without the deleted sessions' prompts. Every other `cx sessions` command and
  each account change read the session database and rollouts, and write only
  `~/.codex/accounts/threads.json` (and finish removing the prompts of
  sessions an earlier delete couldn't).
- `cx add` copies your `auth.json` (OAuth tokens or API keys) and `config.toml`
  into `~/.codex/accounts/`, readable by the owner only. Treat that directory as
  sensitive.
- Close Codex and the Codex app before switching if files are reported as locked.

## Changelog

### Unreleased

- New `cx sessions`: `cx` now records which account each session belongs to
  (the one that used it last; Codex's creator tags are read before
  `cx switch` clears them), lists the sessions by account, and
  `cx sessions delete` permanently deletes an account's sessions (some or all),
  or the unassigned ones, with their memories and prompt history, through
  `codex delete`.
- New `cx warm`: starts every account's weekly quota window that hasn't
  started yet with a minimal `codex exec` request, so an unused account's next
  week starts at its reset rather than at its next use. While Codex is in use,
  it also starts the idle 5-hour windows of accounts with at least 10% of their
  week left, again after each reset until Codex is no longer used. `cx warm start` keeps
  doing it in the background a minute after each reset (any `cx` command starts
  it again after a reboot; `cx warm stop` turns it off), `cx warm --watch` in
  the terminal. Each request runs in a private Codex home, apart from `~/.codex`
  and without holding the cx lock; tokens Codex refreshes there are saved back.
- `cx status` shows a 5-hour or weekly window that hasn't started as
  `100% (not started)` instead of a reset time that keeps moving.

### 0.3.0

- Use Node's built-in `node:sqlite` instead of `better-sqlite3`: no native
  addon, no install scripts, and no `prebuild-install` deprecation warning.
  Requires Node.js 22.13+ or 23.4+ (23.0–23.3 still hide `node:sqlite` behind
  a flag).
- Windows: rewrite rollout files in Node with an exclusive open instead of
  PowerShell scripts, so a switch no longer starts PowerShell (or needs
  `-ExecutionPolicy Bypass`).
- On Linux and macOS, a rollout file cx may not read or write is reported as an
  error instead of being skipped as "in use".
- Switching back from a third-party account no longer saves the stale ChatGPT
  tokens left in `auth.json` over the official account's newer snapshot, which
  signed that account out (its refresh token had already been used). A
  snapshot is also never replaced by tokens with an older `last_refresh`.
- With a third-party provider in use, `cx status`, `cx list` and `cx remove` no
  longer mark the ChatGPT account whose old tokens are in `auth.json` as active,
  and `cx status` queries that account's quota with its own snapshot.
- A rollout whose thread writer lock Codex holds open is skipped as in use.
- Errors that wrap another one print it on a `Caused by:` line.
- Removed the undocumented `--account` and `--alias` options; pass the account
  or alias as an argument.

### 0.2.13

- `cx switch` keeps sessions visible after an account switch with Codex 0.168+,
  which shows only the sessions created with the current ChatGPT account. The
  sync removes the creator tags from rollout files and SQLite, also when both
  accounts use the same provider. The first switch after upgrading rewrites
  every session created since Codex started tagging them.

### 0.2.12

- `cx status` tells an expired sign-in (`sign-in expired`) from a revoked one
  (`signed out`), and prints under the usage table the command that fixes each
  account that needs a new sign-in.
- The help and README explain that `cx add` also signs in again to a registered
  account whose login expired or was revoked, keeping its alias.
- After `cx add` signs in to another account, it prints how to switch back to
  the previous one.

### 0.2.11

- `cx status` shows the live 5-hour and weekly quota left on every account signed
  in with ChatGPT, after the local status.
- Accounts with neither an email nor an alias are shown by their key instead of a
  blank name.

### 0.2.10

- `cx switch` and a `cx add` that signs in restart a running Codex app-server
  daemon, which otherwise keeps sending requests as the previous account (and
  hits its usage limits). After the restart, `cx switch` also syncs the rollout
  files the daemon had open.
- `cx switch` and `cx status` work without `~/.codex/config.toml`.
- A failed switch now restores every file in `~/.codex/accounts/`, removing
  snapshots it had just created, and restores files atomically with their mode.
- Removing the API key Codex is using no longer blocks `cx switch` and `cx add`
  with "The current login ... is not saved".

### 0.2.9

- `cx add` now signs in to a new account: it saves the current one, removes
  `auth.json` so its tokens aren't revoked, opens Codex to sign in, and registers
  the result on exit. Third-party providers and unsaved API keys are still
  snapshotted with `cx add <alias>`.
- `cx switch` registers a login that has no snapshot before replacing it, and
  refuses to replace an unsaved API key.
- An account removed while Codex is logged in to it stays removed: `cx switch`
  and `cx add` no longer register it again.
- Removed the deprecated `cx save`.

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

## Development

```bash
npm ci
npm test            # node --test
npm run typecheck   # tsc over the JSDoc types in src/, no build step
```

## License

MIT © uk-hot
