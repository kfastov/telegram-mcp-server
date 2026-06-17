# tgcli CLI Commands

CLI goal: human-readable output by default with --json for scripting.

## Execution model
Every Telegram and archive command (channels, messages, send, media, topics,
tags, metadata, contacts, groups, folders) runs through the always-on control
server, not in the CLI process. The CLI is a thin one-shot client: it auto-starts
`tgcli server --idle-exit 60s` in the background when one isn't already running,
asks it to execute the operation against its warm (already-authed) MTProto
connection and open database over the loopback control API, then renders the
result. The server is the single writer; the auto-started server shuts itself
down once the queue drains and nothing is watched.

Commands that stay local (no server): `config`, `service`, `doctor`, and `auth`
(interactive login bootstraps the session the server then uses).

## Global flags
- --json
- --timeout DURATION
  - No default for most commands (long-running ones like `backfill`, `--follow`, and `server` stay unbounded).
  - `send` commands default to `30s` so agents/scripts never hang on a stuck connection. Override with `--timeout 5m`, or `--timeout 0` to disable.
- --quiet
  - Suppress informational progress/status output on stderr (e.g. backfill progress lines). Errors and primary stdout/`--json` output are unaffected.
- --version

Store location: OS app data dir (override with TGCLI_STORE).
MCP: disabled by default (set `mcp.enabled` in config.json to true to serve MCP).

## auth
- auth [--qr] [--qr-file <path>] [--force-sms]
  - Interactive login + session bootstrap only: writes the session and exits. It
    does not sync or run a worker. Archiving runs in the always-on server, which
    auto-starts on the next command that needs it (or via `tgcli server`).
  - --qr for QR code login (scan in Telegram app).
  - --qr-file saves the QR code as a PNG image (useful for agents).
  - --force-sms forces code delivery via SMS instead of in-app notification.
- auth status
- auth logout

## backfill
Backfill work is executed by the always-on control server, not in the CLI
process. Commands that need the server (`backfill --chat`, `backfill wait`)
auto-start `tgcli server --idle-exit 60s` in the background if one isn't already
running, talk to it over the loopback control API, and the server shuts itself
down once the queue drains and nothing is watched. The CLI stays a thin,
one-shot client.

- backfill --chat <id|username> [--depth N] [--min-date ISO] [--background]
  - Enqueue a single-chat backfill on the server (auto-starting it).
  - Foreground (default): follows progress to terminal, printing
    `Backfilling <title>: <done>/<target> (NN%)` to stderr (suppressed by
    `--quiet`) and a final summary on stdout. Exits non-zero if the job errors.
  - **Ctrl-C detaches** instead of cancelling: it prints a note and exits 0; the
    server keeps draining the job. Use `backfill cancel --chat <id>` to stop it.
  - `--background`: enqueue and return immediately, printing `{ jobId, channelId,
    status }` (one human line, or JSON with `--json`).
  - Long-running: no default timeout (a user-supplied `--timeout` is honored).
- backfill status [--json]
  - Snapshot: queue counts, whether the server is up, and each in-progress /
    pending backfill (title, message_count/target, %, cursor date, updated_at).
- backfill count [--json]
  - Print the number of in-progress backfills (cheap; brief read lock).
- backfill wait [--json]
  - Auto-start the server if needed, then block until no pending/in-progress
    backfills remain, showing progress (respects `--quiet`).
- backfill cancel --chat <id|username>
  - Cancel a chat's backfills via the server when one is up; falls back to a
    direct cancel (same as `backfill jobs cancel --channel`) when none is.
- backfill (no --chat): track the server's queue (alias: `sync`)
  - `--follow`: auto-start the server if needed, track the queue with live
    progress, and exit once it drains. The server keeps running on its own
    (realtime continues while it is up / has watched chats).
  - `--once`: deprecated alias of `backfill wait` — drain quietly and exit.
  - With no flag: prints usage (there is no queue to track).
- backfill jobs list [--status] [--limit] [--channel]
- backfill jobs add --chat <id|username> [--min-date ISO] [--depth N]
  - Enqueue a job on the server (auto-starting it); the server's queue processes it.
- backfill jobs retry [--job-id] [--channel] [--all-errors]
  - Reset errored job(s) to pending on the server; the server's queue reprocesses them.
- backfill jobs cancel --job-id|--channel
- `sync` remains a silent alias of `backfill` (and every subcommand), so existing `sync …` invocations keep working unchanged.

## server
- server
  - Start the background sync service (MCP HTTP server runs only when enabled in config).

## service
- service install
- service start
- service stop
- service status
- service logs

## doctor
- doctor [--connect]
  - Checks auth, lock, FTS, last sync, queue state.

## channels
- channels list [--limit] [--query]
- channels show --chat <id|username>
- channels watch --chat <id|username>
  - Subscribe a chat for archiving: enables sync and queues a backfill job; run `tgcli backfill --once` or `tgcli backfill --follow` to process it.
- channels unwatch --chat <id|username>
  - Unsubscribe a chat from archiving (disables sync).
  - `channels sync --chat <id|username> --enable|--disable` remains as a hidden alias of watch/unwatch.

## topics (forum supergroups)
- topics list --chat <id|username> [--limit]
- topics search --chat <id|username> --query <text> [--limit]

## messages
- messages list [--chat] [--topic] [--source archive|live|both] [--after ISO] [--before ISO] [--before-id N] [--after-id N] [--limit]
- messages search <query> [--chat] [--topic] [--source] [--after] [--before] [--before-id N] [--after-id N] [--tag] [--regex] [--limit]
- messages show --chat <id> --id <msgId> [--source]
- messages context --chat <id> --id <msgId> [--before N] [--after N] [--source]

### Pagination

Use `--before-id` and `--after-id` for cursor-based pagination by message ID:
- `--before-id N` — only messages older than message ID N (backward pagination)
- `--after-id N` — only messages newer than message ID N (forward pagination)

With `--json`, the response includes pagination metadata:
```json
{
  "source": "live",
  "returned": 50,
  "hasMore": true,
  "nextBeforeId": 429100,
  "messages": [...]
}
```
- `hasMore` — true when the number of returned messages equals the requested limit
- `nextBeforeId` — the ID of the oldest message in the batch; pass it as `--before-id` to get the next page

Example: paginating through history:
```bash
# Page 1
tgcli messages list --chat <id> --limit 50 --source live --json
# → hasMore: true, nextBeforeId: 12345

# Page 2
tgcli messages list --chat <id> --limit 50 --source live --before-id 12345 --json
# → hasMore: true, nextBeforeId: 11000

# Continue until hasMore: false
```

Legacy `--offset-id` is accepted as a hidden alias for `--before-id`.

## feedback
- feedback <message>
  - Sends feedback directly to the tgcli maintainer (@kfastov) via Telegram.
  - Override recipient: `tgcli config set feedback.chatId <username-or-id>`
  - Rate limited: 1 message per 60 seconds.
  - **What is sent:** your message text, plus a metadata footer containing: tgcli version, OS name (`process.platform`), and Node.js version. No other data (no username, chat history, file paths, or system info) is included. The message is sent from your authenticated Telegram account, so the recipient will see your Telegram profile.

## send
- send text --to <id|username> --message "..." [--topic <id>] [--parse-mode markdown|html|none] [--reply-to <id>] [--schedule <iso>] [--silent] [--no-preview] [--no-forwards] [--retries <n>] [--retry-backoff constant|linear|exponential|<ms>]
- send photo --to <id|username> --photo PATH [--caption "..."] [--topic <id>] [--parse-mode markdown|html|none] [--reply-to <id>] [--schedule <iso>] [--silent] [--no-forwards] [--spoiler] [--caption-above] [--retries <n>] [--retry-backoff constant|linear|exponential|<ms>]
- send file --to <id|username> --file PATH [--caption "..."] [--filename NAME] [--topic <id>] [--parse-mode markdown|html|none] [--reply-to <id>] [--schedule <iso>] [--silent] [--no-forwards] [--spoiler] [--caption-above] [--force-document] [--retries <n>] [--retry-backoff constant|linear|exponential|<ms>]
  - Sends are executed by the warm server (the single writer): the CLI routes the send through the control server, which runs the retry/`FLOOD_WAIT` logic against its live connection.
  - `--retries` defaults to `2` for all send commands. Retries and `FLOOD_WAIT` waits happen server-side.
  - Send commands default to a `30s` wall-clock timeout, which bounds the CLI's wait on the server. A stuck send fails fast instead of hanging. Override with `--timeout <duration>` (e.g. `--timeout 5m`) or disable with `--timeout 0`. On timeout the command exits non-zero with: `Send timed out after 30s (no response from Telegram).`
  - If Telegram returns a `FLOOD_WAIT` whose required wait exceeds the timeout budget, the command reports the rate limit (e.g. `Telegram rate-limited this send (FLOOD_WAIT 120s), which exceeds the 30s timeout.`) rather than silently timing out. Retry later or pass `--timeout 0`.

## media
- media download --chat <id|username> --id <msgId> [--output PATH]

## tags
- tags set --chat <id|username> --tags ai,news [--source]
- tags list --chat <id|username> [--source]
- tags search --tag ai [--source] [--limit]
- tags auto [--chat ...] [--limit] [--refresh-metadata]

## metadata
- metadata get --chat <id|username>
- metadata refresh [--chat ...] [--limit] [--force] [--only-missing]

## contacts (users)
- contacts search <query> [--limit]
- contacts show --user <id>
- contacts alias set --user <id> --alias "Name"
- contacts alias rm --user <id>
- contacts tags add --user <id> --tag <tag> [--tag ...]
- contacts tags rm --user <id> --tag <tag> [--tag ...]
- contacts notes set --user <id> --notes "..."

## groups (optional, permission-based)
- groups list [--query]
- groups info --chat <id>
- groups rename --chat <id> --name "New Name"
- groups members add --chat <id> --user <id> [--user ...]
- groups members remove --chat <id> --user <id> [--user ...]
- groups members list --chat <id> [--limit <n>] [--search <text>]
- groups invite get --chat <id>
- groups invite revoke --chat <id>
- groups join --code <invite-code>
- groups leave --chat <id>

## folders
- folders list
- folders show <folder> [--resolve]
- folders create --title <name> [--emoji] [--include-contacts] [--include-non-contacts] [--include-groups] [--include-channels] [--include-bots] [--exclude-muted] [--exclude-read] [--exclude-archived] [--chat <id>...] [--exclude-chat <id>...] [--pin-chat <id>...]
- folders edit <folder> [--title] [--emoji] [flags...] [--chat <id>...] [--exclude-chat <id>...] [--pin-chat <id>...]
- folders delete <folder>
- folders reorder --ids <id1,id2,...>
- folders chats add <folder> --chat <id>
- folders chats remove <folder> --chat <id>
- folders join <link>

`<folder>` can be a numeric folder ID or folder title.
