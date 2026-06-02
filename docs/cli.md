# tgcli CLI Commands

CLI goal: human-readable output by default with --json for scripting.

## Global flags
- --json
- --timeout DURATION
  - No default for most commands (long-running ones like `sync`, `--follow`, and `server` stay unbounded).
  - `send` commands default to `30s` so agents/scripts never hang on a stuck connection. Override with `--timeout 5m`, or `--timeout 0` to disable.
- --quiet
  - Suppress informational progress/status output on stderr (e.g. the `Connecting to Telegram…` note from `send`). Errors and primary stdout/`--json` output are unaffected.
- --version

Store location: OS app data dir (override with TGCLI_STORE).
MCP: disabled by default (set `mcp.enabled` in config.json to true to serve MCP).

## auth
- auth
  - Interactive login (Telegram MTProto), then bootstrap sync.
  - Flags: --follow, --idle-exit 30s, --download-media
- auth status
- auth logout

## sync
- sync
  - Flags: --once | --follow, --idle-exit 30s, --download-media, --refresh-contacts, --refresh-groups
- sync status
- sync jobs list [--status] [--limit] [--channel]
- sync jobs add --chat <id|username> [--min-date ISO] [--depth N]
- sync jobs retry [--job-id] [--channel] [--all-errors]
- sync jobs cancel --job-id|--channel

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
- channels sync --chat <id|username> --enable|--disable
  - Enabling queues a backfill job; run `tgcli sync --once` or `tgcli sync --follow` to process it.

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
  - `--retries` defaults to `2` for all send commands.
  - Send commands default to a `30s` wall-clock timeout so a stuck Telegram connection fails fast instead of hanging. Override with `--timeout <duration>` (e.g. `--timeout 5m`) or disable with `--timeout 0`. On timeout the command exits non-zero with: `Send timed out after 30s (no response from Telegram).`
  - If Telegram returns a `FLOOD_WAIT` whose required wait exceeds the remaining timeout budget, the command aborts early reporting the rate limit (e.g. `Telegram rate-limited this send (FLOOD_WAIT 120s), which exceeds the 30s timeout.`) rather than silently timing out. Retry later or pass `--timeout 0`.

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
