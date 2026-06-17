---
name: tgcli
description: Telegram CLI for reading/searching messages, syncing archives, and sending or downloading files. Use when the user asks about Telegram chats, messages, contacts, groups, or files.
---

# tgcli

Telegram CLI with background sync.

## When to Use

Use this skill when the user:
- Wants to read or search Telegram messages
- Needs recent updates or an inbox-style view of chats
- Asks to send a Telegram message or file
- Wants to download media or files from Telegram
- Wants to look up channels, groups, or contacts
- Needs archive/backfill sync for a chat

## Install

```bash
npm install -g @kfastov/tgcli
```

Or:
```bash
brew install kfastov/tap/tgcli
```

## Authentication

First-time setup needs Telegram API credentials from https://my.telegram.org/apps

```bash
tgcli auth
```

## Common Commands

### Reading
```bash
tgcli channels list --limit 20
tgcli messages list --chat @username --limit 50
tgcli messages search "query" --chat @channel --source archive
tgcli topics list --chat @channel --limit 20
```

### Files & Media
```bash
tgcli media download --chat @channel --id 12345
tgcli send file --to @channel --file ./report.pdf --caption "FYI"
```

### Writing
```bash
tgcli send text --to @username --message "Hello"
```

### Backfill & Service
```bash
tgcli backfill --chat @channel                 # backfill one chat (auto-starts the server, follows progress)
tgcli backfill --chat @channel --background    # enqueue and return the job id
tgcli backfill --chat @channel --depth 5000 --min-date 2024-01-01T00:00:00Z
tgcli backfill status                          # active backfills + server status
tgcli backfill count                           # number of in-progress backfills
tgcli backfill wait                            # block until the queue drains
tgcli backfill cancel --chat @channel          # stop a chat's backfills
tgcli channels watch --chat @channel           # subscribe a chat for archiving (queues a backfill)
tgcli channels unwatch --chat @channel         # stop archiving a chat
tgcli backfill --follow                         # track the server's queue to completion (`sync` is a silent alias)
tgcli service install
tgcli service start
```

Telegram and archive commands (channels, messages, send, media, topics, tags,
metadata, contacts, groups, folders) run through the always-on control server,
not the CLI. The CLI is a thin client: it auto-starts `tgcli server` in the
background when one isn't running, has it execute the operation against its warm
connection and database, then renders the result; the server shuts itself down
once idle. `config`, `service`, `doctor`, and `auth` stay local. Foreground
`backfill --chat` follows progress on stderr; **Ctrl-C detaches** (the job keeps
running — check `tgcli backfill status`).

### Contacts & Groups
```bash
tgcli contacts search "alex"
tgcli groups list --query "Nha Trang"
tgcli groups members list --chat @mygroup           # list all members
tgcli groups members list --chat @mygroup --search "alex"  # filter by name/username
```

## Output Formats

All commands support `--json` for structured output:

```bash
tgcli messages list --chat @username --limit 5 --json
tgcli channels list --limit 10 --json
```

## Notes

- Use `--source live|archive|both` when listing or searching messages.
- `--json` is best for AI/tooling pipelines.
- `send` commands time out after `30s` by default so they never hang on a stuck connection. Override with `--timeout 5m` or disable with `--timeout 0`. Long-running commands (`backfill`, `--follow`, `server`) are unbounded by default.
- `backfill` is the canonical archive command; `sync` (and `channels sync --enable/--disable`) keep working as aliases. Prefer `channels watch`/`channels unwatch` to subscribe/unsubscribe a chat.
