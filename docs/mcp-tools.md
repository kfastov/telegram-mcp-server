# Target MCP Tool Schema (vNext)

This document defines the consolidated MCP tool surface. The goal is fewer tools, consistent filters, and a single API for archive/live/both.

## Shared types
- channelId: string | number (numeric ID or @username).
- userId: string | number (numeric user ID or @username).
- topicId: number (forum topic ID).
- source: "archive" | "live" | "both" (default: "archive").
- isoDate: ISO-8601 string (UTC preferred).
- limit: integer (tool-specific defaults).

## Auth / Health
### authStatus
- Purpose: report auth/session status.
- Params: none.
- Output: { authenticated, userId?, phone?, sessionPath?, lastLoginAt? }.

### serverStatus
- Purpose: diagnostics summary (realtime, queue, db, fts).
- Params: none.
- Output: { realtimeActive, queueSize, jobsInProgress, ftsEnabled, lastSyncAt }.

## Sync
### syncJobsList
- Params: status? (pending|in_progress|idle|error), channelId?, limit?
- Output: list of jobs.

### syncJobsAdd
- Params: channelId (required), depth? (default 1000), minDate? (ISO), enableRealtime? (default true)
- Output: job record.

### syncJobsRetry
- Params: jobId? | channelId? | allErrors? (boolean)
- Output: { updated, jobIds }.

### syncJobsCancel
- Params: jobId? | channelId?
- Output: { canceled, jobIds }.

### syncRealtimeSet
- Params: enabled (boolean)
- Output: { realtimeActive }.

## Channels
### channelsList
- Params: limit? (default 50), includeInactive? (default false)
- Output: list of local channel records.

### channelsSearch
- Params: query (string, required), limit? (default 100)
- Output: list of matching dialogs (live search).

### channelsGet
- Params: channelId (required)
- Output: channel record + sync fields.

### channelsSetSync
- Params: channelId (required), enabled (boolean)
- Output: { channelId, syncEnabled }.

## Metadata + Tags
### channelsMetadataGet
- Params: channelId (required)
- Output: { channelId, peerTitle, username, about, metadataUpdatedAt }.

### channelsMetadataRefresh
- Params: channelIds? (list), limit? (default 20), force? (boolean), onlyMissing? (boolean)
- Output: list of refreshed records.

### channelsTagsSet
- Params: channelId (required), tags (array, required), source? (default manual)
- Output: { channelId, tags }.

### channelsTagsList
- Params: channelId (required), source?
- Output: list of tags with confidence/source.

### channelsTagsSearch
- Params: tag (required), source?, limit? (default 100)
- Output: list of channels with that tag.

### channelsTagsAuto
- Params: channelIds? (list), limit? (default 50), source? (default auto), refreshMetadata? (default true)
- Output: list of channels + auto tags.

## Topics (Telegram forums)
### topicsList
- Params: channelId (required), limit? (default 100)
- Output: list of topics.

### topicsSearch
- Params: channelId (required), query (required), limit? (default 100)
- Output: list of topics.

## Messages
### messagesList
- Params:
  - channelId? (optional)
  - topicId? (optional)
  - source? (archive|live|both, default archive)
  - fromDate? (ISO)
  - toDate? (ISO)
  - limit? (default 50)
- Output: list of messages.

### messagesGet
- Params: channelId (required), messageId (required), source? (default archive)
- Output: message object.

### messagesContext
- Params: channelId (required), messageId (required), before? (default 20), after? (default 20), source? (default archive)
- Output: { before: [], target, after: [] }.

### messagesSearch
- Params:
  - query? (FTS query string)
  - regex? (optional regex filter)
  - source? (archive|live|both, default archive)
  - channelIds? (list)
  - topicId? (optional)
  - tags? (list of channel tags)
  - fromDate? (ISO)
  - toDate? (ISO)
  - limit? (default 100)
  - caseInsensitive? (boolean, default true)
- Output: list of messages + match/snippet when available.

### messagesSend
- Params: channelId (required), text (required), topicId?, replyToMessageId?
- Output: { messageId }.

### messagesSendFile
- Params: channelId (required), filePath (required), caption?, filename?, topicId?
- Output: { messageId }.

## Media
### mediaDownload
- Params: channelId (required), messageId (required), outputPath? (file or directory)
- Output: { path, bytes, mimeType, downloadedAt }.

## Contacts / Users
### contactsSearch
- Params: query (required), limit? (default 50)
- Output: list of contacts/users.

### contactsGet
- Params: userId (required)
- Output: contact record.

### contactsAliasSet
- Params: userId (required), alias (required)
- Output: { userId, alias }.

### contactsAliasRemove
- Params: userId (required)
- Output: { userId, removed: true }.

### contactsTagsAdd
- Params: userId (required), tags (array, required)
- Output: { userId, tags }.

### contactsTagsRemove
- Params: userId (required), tags (array, required)
- Output: { userId, tags }.

### contactsNotesSet
- Params: userId (required), notes (string)
- Output: { userId, notes }.

## Groups
### groupsList
- Params: query? (optional), limit? (default 100)
- Output: list of groups.

### groupsInfo
- Params: channelId (required)
- Output: group metadata and membership info.

### groupsRename
- Params: channelId (required), name (required)
- Output: { channelId, name }.

### groupsMembersAdd
- Params: channelId (required), userIds (array, required)
- Output: { channelId, failed }.

### groupsMembersRemove
- Params: channelId (required), userIds (array, required)
- Output: { channelId, removed, failed }.

### groupsMembersList
- Params: channelId (required), limit (optional, default 200), search (optional)
- Output: array of { userId, username, name, isBot, status }.

### groupsInviteLinkGet
- Params: channelId (required)
- Output: invite link metadata.

### groupsInviteLinkRevoke
- Params: channelId (required)
- Output: invite link metadata.

### groupsJoin
- Params: invite (required)
- Output: group summary.

### groupsLeave
- Params: channelId (required)
- Output: { channelId, left: true }.
