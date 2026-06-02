#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import readline from 'readline';
import { Command, Option } from 'commander';

import { acquireStoreLock, acquireReadLock, readStoreLock } from './store-lock.js';
import { loadConfig, normalizeConfig, saveConfig, validateConfig } from './core/config.js';
import { createMessageSyncService, createServices, createTelegramClient } from './core/services.js';
import {
  buildSendErrorPayload,
  buildSendSuccessPayload,
  classifySendError,
  executeSendWithRetries,
  formatSendErrorMessage,
  parseRetryBackoff,
  SendCommandError,
} from './core/send-utils.js';
import { resolveStoreDir } from './core/store.js';

const CLI_PATH = fileURLToPath(import.meta.url);
const SERVICE_STATE_FILE = 'service-state.json';
const LAUNCHD_LABEL = 'com.kfastov.tgcli';
const SYSTEMD_SERVICE_NAME = 'tgcli';
const AUTH_SYNC_HINT = 'Run `tgcli backfill --once` or `tgcli backfill --follow` when you need archive data.';
const CONFIG_SPECS = [
  { key: 'apiId', path: ['apiId'], type: 'number' },
  { key: 'apiHash', path: ['apiHash'], type: 'string', secret: true },
  { key: 'phoneNumber', path: ['phoneNumber'], type: 'string' },
  { key: 'feedback.chatId', path: ['feedback', 'chatId'], type: 'string' },
  { key: 'mcp.enabled', path: ['mcp', 'enabled'], type: 'boolean' },
  { key: 'mcp.host', path: ['mcp', 'host'], type: 'string' },
  { key: 'mcp.port', path: ['mcp', 'port'], type: 'number' },
  { key: 'control.enabled', path: ['control', 'enabled'], type: 'boolean' },
  { key: 'control.host', path: ['control', 'host'], type: 'string' },
  { key: 'control.port', path: ['control', 'port'], type: 'number' },
];

const SEND_PARSE_MODES = ['markdown', 'html', 'none'];
const DEFAULT_SEND_RETRIES = 2;
// Send commands target AI agents and scripts that must not block forever on a
// hung MTProto connection, so they get a bounded default timeout. Other commands
// (sync, --follow, server, ...) legitimately run for minutes/hours and stay
// unbounded unless an explicit --timeout is passed.
const DEFAULT_SEND_TIMEOUT_MS = 30000;
const FEEDBACK_LAST_FILE = 'feedback-last.json';
const FEEDBACK_COOLDOWN_MS = 60 * 1000;
const FEEDBACK_DEFAULT_CHAT_ID = '@kfastov';

const CLI_PROGRAM = buildProgram();

function buildProgram() {
  const program = new Command();
  program
    .name('tgcli')
    .description('Telegram CLI + MCP server')
    .usage('[options] <command>')
    .option('--json', 'Machine-readable output')
    .option('--timeout <duration>', 'Wall-clock timeout (e.g. 30s, 5m)')
    .option('--quiet', 'Suppress progress/status output on stderr')
    .version(readVersion(), '--version', 'Print version and exit')
    .showHelpAfterError(true);

  const auth = program.command('auth').description('Authentication and session setup');
  auth
    .option('--follow', 'Continue syncing after login')
    .option('--force-sms', 'Force SMS code delivery instead of in-app')
    .option('--qr', 'Use QR-code login flow instead of confirmation code')
    .option('--qr-file <path>', 'Save QR code as PNG image file')
    .action(withGlobalOptions((globalFlags, options) =>
      runAuthLogin(globalFlags, options),
    ));
  auth
    .command('status')
    .description('Show auth status')
    .action(withGlobalOptions((globalFlags) => runAuthStatus(globalFlags)));
  auth
    .command('logout')
    .description('Log out of Telegram')
    .action(withGlobalOptions((globalFlags) => runAuthLogout(globalFlags)));

  const config = program.command('config').description('View and edit config');
  config
    .command('list')
    .description('List config values')
    .action(withGlobalOptions((globalFlags) => runConfigList(globalFlags)));
  config
    .command('get')
    .description('Get a config value')
    .argument('<key>', 'Config key')
    .action(withGlobalOptions((globalFlags, key) => runConfigGet(globalFlags, key)));
  config
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .action(withGlobalOptions((globalFlags, key, value) => runConfigSet(globalFlags, key, value)));
  config
    .command('unset')
    .description('Unset a config value')
    .argument('<key>', 'Config key')
    .action(withGlobalOptions((globalFlags, key) => runConfigUnset(globalFlags, key)));

  program
    .command('feedback')
    .description('Send feedback to the maintainer')
    .argument('<message...>', 'Feedback message')

    .action(withGlobalOptions((globalFlags, messageParts, options) =>
      runFeedback(globalFlags, messageParts, options),
    ));

  // `backfill` is the canonical name; `sync` stays as a silent alias so existing
  // invocations (and the subcommands below) keep working unchanged. Commander's
  // `.alias()` makes the alias resolve to the same command tree, so every nested
  // subcommand (`backfill jobs add`, `backfill status`, ...) is reachable under
  // both `backfill <...>` and `sync <...>`.
  const sync = program
    .command('backfill')
    .alias('sync')
    .description('Archive backfill and realtime sync');
  sync
    .option('--once', 'Run once and exit')
    .option('--follow', 'Keep syncing realtime updates')
    .option('--idle-exit <duration>', 'Exit after idle period')
    .action(withGlobalOptions((globalFlags, options) => runSync(globalFlags, options)));
  sync
    .command('status')
    .description('Show sync status')
    .action(withGlobalOptions((globalFlags) => runSyncStatus(globalFlags)));
  const syncJobs = sync.command('jobs').description('Manage sync jobs');
  syncJobs
    .command('list')
    .description('List sync jobs')
    .option('--status <status>', 'Filter by status (pending|in_progress|idle|error)')
    .option('--limit <n>', 'Limit results')
    .option('--channel <id|username>', 'Filter by channel')
    .action(withGlobalOptions((globalFlags, options) => runSyncJobsList(globalFlags, options)));
  syncJobs
    .command('add')
    .description('Add a sync job')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--depth <n>', 'Maximum messages to backfill')
    .option('--min-date <iso>', 'Earliest date to backfill')
    .action(withGlobalOptions((globalFlags, options) => runSyncJobsAdd(globalFlags, options)));
  syncJobs
    .command('retry')
    .description('Retry failed jobs')
    .option('--job-id <n>', 'Retry by job id')
    .option('--channel <id|username>', 'Retry by channel')
    .option('--all-errors', 'Retry all error jobs')
    .action(withGlobalOptions((globalFlags, options) => runSyncJobsRetry(globalFlags, options)));
  syncJobs
    .command('cancel')
    .description('Cancel jobs')
    .option('--job-id <n>', 'Cancel by job id')
    .option('--channel <id|username>', 'Cancel by channel')
    .action(withGlobalOptions((globalFlags, options) => runSyncJobsCancel(globalFlags, options)));

  program
    .command('server')
    .description('Run background sync service (MCP optional)')
    .option('--idle-exit <duration>', 'Exit after this idle period with no jobs or watched channels')
    .action(withGlobalOptions((globalFlags, options) => runServer(globalFlags, options)));

  const service = program.command('service').description('Manage background service');
  service
    .command('install')
    .description('Install service definition')
    .action(withGlobalOptions((globalFlags) => runServiceInstall(globalFlags)));
  service
    .command('start')
    .description('Start service')
    .action(withGlobalOptions((globalFlags) => runServiceStart(globalFlags)));
  service
    .command('stop')
    .description('Stop service')
    .action(withGlobalOptions((globalFlags) => runServiceStop(globalFlags)));
  service
    .command('status')
    .description('Show service status')
    .action(withGlobalOptions((globalFlags) => runServiceStatus(globalFlags)));
  service
    .command('logs')
    .description('Show service logs')
    .action(withGlobalOptions((globalFlags) => runServiceLogs(globalFlags)));

  program
    .command('doctor')
    .description('Diagnostics and sanity checks')
    .option('--connect', 'Connect to Telegram for live checks')
    .action(withGlobalOptions((globalFlags, options) => runDoctor(globalFlags, options)));

  const channels = program.command('channels').description('Channel discovery and settings');
  channels
    .command('list')
    .description('List channels')
    .option('--query <text>', 'Search by title or username')
    .option('--limit <n>', 'Limit results')
    .action(withGlobalOptions((globalFlags, options) => runChannelsList(globalFlags, options)));
  channels
    .command('show')
    .description('Show channel info')
    .option('--chat <id|username>', 'Channel identifier')
    .action(withGlobalOptions((globalFlags, options) => runChannelsShow(globalFlags, options)));
  // `watch`/`unwatch` are the canonical per-chat archive subscription commands.
  // They delegate to the same handler as the legacy `channels sync --enable/--disable`
  // by pre-setting the enable/disable flag, so `watch` also queues a backfill job
  // when none exists (parity with the old enable behavior).
  channels
    .command('watch')
    .description('Subscribe a chat for archiving (enable sync, queue a backfill)')
    .option('--chat <id|username>', 'Channel identifier')
    .action(withGlobalOptions((globalFlags, options) =>
      runChannelsSync(globalFlags, { ...options, enable: true }),
    ));
  channels
    .command('unwatch')
    .description('Unsubscribe a chat from archiving (disable sync)')
    .option('--chat <id|username>', 'Channel identifier')
    .action(withGlobalOptions((globalFlags, options) =>
      runChannelsSync(globalFlags, { ...options, disable: true }),
    ));
  // Hidden back-compat alias of watch/unwatch via explicit --enable/--disable.
  channels
    .command('sync', { hidden: true })
    .description('Enable or disable sync (alias of watch/unwatch)')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--enable', 'Enable sync')
    .option('--disable', 'Disable sync')
    .action(withGlobalOptions((globalFlags, options) => runChannelsSync(globalFlags, options)));
  channels
    .command('mark-read')
    .description('Mark channel as read up to a message')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--message-id <n>', 'Mark as read up to this message ID')
    .action(withGlobalOptions((globalFlags, options) => runChannelsMarkRead(globalFlags, options)));

  const messages = program.command('messages').description('List and search messages');
  messages
    .command('list')
    .description('List messages')
    .option('--chat <id|username>', 'Channel identifier', collectList)
    .option('--topic <id>', 'Forum topic id')
    .option('--source <source>', 'archive|live|both')
    .option('--after <iso>', 'Filter messages after date')
    .option('--before <iso>', 'Filter messages before date')
    .option('--limit <n>', 'Limit results')
    .option('--before-id <id>', 'Only messages older than this message ID')
    .option('--after-id <id>', 'Only messages newer than this message ID')
    .addOption(new Option('--offset-id <id>', 'Deprecated alias for --before-id').hideHelp())
    .action(withGlobalOptions((globalFlags, options) => runMessagesList(globalFlags, options)));
  messages
    .command('search')
    .description('Search messages')
    .argument('[query...]')
    .option('--query <text>', 'Search query')
    .option('--chat <id|username>', 'Channel identifier', collectList)
    .option('--topic <id>', 'Forum topic id')
    .option('--source <source>', 'archive|live|both')
    .option('--after <iso>', 'Filter messages after date')
    .option('--before <iso>', 'Filter messages before date')
    .option('--limit <n>', 'Limit results')
    .option('--before-id <id>', 'Only messages older than this message ID')
    .option('--after-id <id>', 'Only messages newer than this message ID')
    .option('--regex <pattern>', 'Regex pattern')
    .option('--tag <tag>', 'Filter by tag', collectList)
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--case-sensitive', 'Disable case-insensitive search')
    .action(withGlobalOptions((globalFlags, queryParts, options) =>
      runMessagesSearch(globalFlags, queryParts, options),
    ));
  messages
    .command('show')
    .description('Show a message')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--id <msgId>', 'Message id')
    .option('--source <source>', 'archive|live|both')
    .action(withGlobalOptions((globalFlags, options) => runMessagesShow(globalFlags, options)));
  messages
    .command('context')
    .description('Show message context')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--id <msgId>', 'Message id')
    .option('--source <source>', 'archive|live|both')
    .option('--before <n>', 'Messages before')
    .option('--after <n>', 'Messages after')
    .action(withGlobalOptions((globalFlags, options) => runMessagesContext(globalFlags, options)));

  const send = program.command('send').description('Send text, photos, or files');
  send
    .command('text')
    .description('Send a text message')
    .option('--to <id|username>', 'Recipient id or username')
    .addOption(new Option('--chat <id|username>', 'Alias for --to').hideHelp())
    .option('--message <text>', 'Message text')
    .addOption(new Option('--text <text>', 'Alias for --message').hideHelp())
    .option('--parse-mode <mode>', 'Parse mode: markdown|html|none')
    .option('--topic <id>', 'Forum topic id')
    .option('--reply-to <id>', 'Reply to message id')
    .option('--no-preview', 'Disable link preview')
    .option('--silent', 'Send without notification sound')
    .option('--no-forwards', 'Protect message from forwarding')
    .option('--schedule <iso>', 'Schedule message (ISO 8601 datetime)')
    .option('--retries <n>', 'Max retries on failure', String(DEFAULT_SEND_RETRIES))
    .option('--retry-backoff <value>', 'Retry backoff in ms or strategy: constant|linear|exponential')
    .action(withGlobalOptions((globalFlags, options) => runSendText(globalFlags, options)));
  send
    .command('photo')
    .description('Send a photo with preview')
    .option('--to <id|username>', 'Recipient id or username')
    .addOption(new Option('--chat <id|username>', 'Alias for --to').hideHelp())
    .option('--photo <path>', 'Photo path')
    .option('--caption <text>', 'Optional caption')
    .option('--parse-mode <mode>', 'Parse mode for caption: markdown|html|none')
    .option('--topic <id>', 'Forum topic id')
    .option('--reply-to <id>', 'Reply to message id')
    .option('--silent', 'Send without notification sound')
    .option('--no-forwards', 'Protect message from forwarding')
    .option('--caption-above', 'Show caption above media')
    .option('--spoiler', 'Blur media until tapped')
    .option('--schedule <iso>', 'Schedule message (ISO 8601 datetime)')
    .option('--retries <n>', 'Max retries on failure', String(DEFAULT_SEND_RETRIES))
    .option('--retry-backoff <value>', 'Retry backoff in ms or strategy: constant|linear|exponential')
    .action(withGlobalOptions((globalFlags, options) => runSendPhoto(globalFlags, options)));
  send
    .command('file')
    .description('Send a file')
    .option('--to <id|username>', 'Recipient id or username')
    .addOption(new Option('--chat <id|username>', 'Alias for --to').hideHelp())
    .option('--file <path>', 'File path')
    .option('--caption <text>', 'Optional caption')
    .option('--parse-mode <mode>', 'Parse mode for caption: markdown|html|none')
    .option('--filename <name>', 'Override filename')
    .option('--topic <id>', 'Forum topic id')
    .option('--reply-to <id>', 'Reply to message id')
    .option('--silent', 'Send without notification sound')
    .option('--no-forwards', 'Protect message from forwarding')
    .option('--caption-above', 'Show caption above media')
    .option('--spoiler', 'Blur media until tapped')
    .option('--schedule <iso>', 'Schedule message (ISO 8601 datetime)')
    .option('--force-document', 'Send as uncompressed document')
    .option('--retries <n>', 'Max retries on failure', String(DEFAULT_SEND_RETRIES))
    .option('--retry-backoff <value>', 'Retry backoff in ms or strategy: constant|linear|exponential')
    .action(withGlobalOptions((globalFlags, options) => runSendFile(globalFlags, options)));

  const media = program.command('media').description('Download media');
  media
    .command('download')
    .description('Download message media')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--id <msgId>', 'Message id')
    .option('--output <path>', 'Output file path')
    .action(withGlobalOptions((globalFlags, options) => runMediaDownload(globalFlags, options)));

  const topics = program.command('topics').description('Forum topics');
  topics
    .command('list')
    .description('List topics')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--limit <n>', 'Limit results')
    .action(withGlobalOptions((globalFlags, options) => runTopicsList(globalFlags, options)));
  topics
    .command('search')
    .description('Search topics')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--query <text>', 'Search query')
    .option('--limit <n>', 'Limit results')
    .action(withGlobalOptions((globalFlags, options) => runTopicsSearch(globalFlags, options)));

  const tags = program.command('tags').description('Channel tags');
  tags
    .command('set')
    .description('Set channel tags')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--tag <tag>', 'Tag', collectList)
    .option('--source <source>', 'Tag source')
    .action(withGlobalOptions((globalFlags, options) => runTagsSet(globalFlags, options)));
  tags
    .command('list')
    .description('List channel tags')
    .option('--chat <id|username>', 'Channel identifier')
    .option('--source <source>', 'Tag source')
    .action(withGlobalOptions((globalFlags, options) => runTagsList(globalFlags, options)));
  tags
    .command('search')
    .description('Search channels by tag')
    .option('--tag <tag>', 'Tag to search')
    .option('--source <source>', 'Tag source')
    .option('--limit <n>', 'Limit results')
    .action(withGlobalOptions((globalFlags, options) => runTagsSearch(globalFlags, options)));
  tags
    .command('auto')
    .description('Auto-tag channels')
    .option('--chat <id|username>', 'Channel identifier', collectList)
    .option('--limit <n>', 'Limit channels')
    .option('--source <source>', 'Tag source')
    .option('--no-refresh-metadata', 'Skip metadata refresh')
    .action(withGlobalOptions((globalFlags, options) => runTagsAuto(globalFlags, options)));

  const metadata = program.command('metadata').description('Channel metadata cache');
  metadata
    .command('get')
    .description('Show cached metadata')
    .option('--chat <id|username>', 'Channel identifier')
    .action(withGlobalOptions((globalFlags, options) => runMetadataGet(globalFlags, options)));
  metadata
    .command('refresh')
    .description('Refresh cached metadata')
    .option('--chat <id|username>', 'Channel identifier', collectList)
    .option('--limit <n>', 'Limit channels')
    .option('--force', 'Force refresh')
    .option('--only-missing', 'Only refresh missing metadata')
    .action(withGlobalOptions((globalFlags, options) => runMetadataRefresh(globalFlags, options)));

  const contacts = program.command('contacts').description('Contacts and people');
  contacts
    .command('search')
    .description('Search contacts')
    .argument('<query...>')
    .option('--limit <n>', 'Limit results')
    .action(withGlobalOptions((globalFlags, queryParts, options) =>
      runContactsSearch(globalFlags, queryParts, options),
    ));
  contacts
    .command('show')
    .description('Show contact profile')
    .option('--user <id>', 'User id')
    .action(withGlobalOptions((globalFlags, options) => runContactsShow(globalFlags, options)));
  const contactAlias = contacts.command('alias').description('Manage contact aliases');
  contactAlias
    .command('set')
    .description('Set contact alias')
    .option('--user <id>', 'User id')
    .option('--alias <name>', 'Alias')
    .action(withGlobalOptions((globalFlags, options) => runContactsAliasSet(globalFlags, options)));
  contactAlias
    .command('rm')
    .description('Remove contact alias')
    .option('--user <id>', 'User id')
    .action(withGlobalOptions((globalFlags, options) => runContactsAliasRm(globalFlags, options)));
  const contactTags = contacts.command('tags').description('Manage contact tags');
  contactTags
    .command('add')
    .description('Add contact tags')
    .option('--user <id>', 'User id')
    .option('--tag <tag>', 'Tag', collectList)
    .action(withGlobalOptions((globalFlags, options) => runContactsTagsAdd(globalFlags, options)));
  contactTags
    .command('rm')
    .description('Remove contact tags')
    .option('--user <id>', 'User id')
    .option('--tag <tag>', 'Tag', collectList)
    .action(withGlobalOptions((globalFlags, options) => runContactsTagsRm(globalFlags, options)));
  const contactNotes = contacts.command('notes').description('Manage contact notes');
  contactNotes
    .command('set')
    .description('Set contact notes')
    .option('--user <id>', 'User id')
    .option('--notes <text>', 'Notes')
    .action(withGlobalOptions((globalFlags, options) => runContactsNotesSet(globalFlags, options)));

  const groups = program.command('groups').description('Group management');
  groups
    .command('list')
    .description('List groups')
    .option('--query <text>', 'Search by title')
    .option('--limit <n>', 'Limit results')
    .action(withGlobalOptions((globalFlags, options) => runGroupsList(globalFlags, options)));
  groups
    .command('info')
    .description('Show group info')
    .option('--chat <id|username>', 'Group identifier')
    .action(withGlobalOptions((globalFlags, options) => runGroupsInfo(globalFlags, options)));
  groups
    .command('rename')
    .description('Rename group')
    .option('--chat <id|username>', 'Group identifier')
    .option('--name <text>', 'New name')
    .action(withGlobalOptions((globalFlags, options) => runGroupsRename(globalFlags, options)));
  const groupMembers = groups.command('members').description('Manage group members');
  groupMembers
    .command('add')
    .description('Add members')
    .option('--chat <id|username>', 'Group identifier')
    .option('--user <id>', 'User id', collectList)
    .action(withGlobalOptions((globalFlags, options) => runGroupMembersAdd(globalFlags, options)));
  groupMembers
    .command('remove')
    .description('Remove members')
    .option('--chat <id|username>', 'Group identifier')
    .option('--user <id>', 'User id', collectList)
    .action(withGlobalOptions((globalFlags, options) => runGroupMembersRemove(globalFlags, options)));
  const groupInvite = groups.command('invite').description('Manage invite links');
  groupInvite
    .command('get')
    .description('Get invite link')
    .option('--chat <id|username>', 'Group identifier')
    .action(withGlobalOptions((globalFlags, options) => runGroupInviteLinkGet(globalFlags, options)));
  groupInvite
    .command('revoke')
    .description('Revoke invite link')
    .option('--chat <id|username>', 'Group identifier')
    .action(withGlobalOptions((globalFlags, options) => runGroupInviteLinkRevoke(globalFlags, options)));
  groups
    .command('join')
    .description('Join via invite code')
    .option('--code <invite-code>', 'Invite code')
    .action(withGlobalOptions((globalFlags, options) => runGroupsJoin(globalFlags, options)));
  groups
    .command('leave')
    .description('Leave group')
    .option('--chat <id|username>', 'Group identifier')
    .action(withGlobalOptions((globalFlags, options) => runGroupsLeave(globalFlags, options)));

  // --- Folders ---
  const folders = program.command('folders').description('Chat folder management');
  folders
    .command('list')
    .description('List all folders')
    .action(withGlobalOptions((globalFlags) => runFoldersList(globalFlags)));
  folders
    .command('show')
    .description('Show folder details')
    .argument('<folder>', 'Folder ID or title')
    .option('--resolve', 'Resolve peer IDs to names (slower, requires API calls)')
    .action(withGlobalOptions((globalFlags, folder, opts) => runFoldersShow(globalFlags, folder, opts)));
  folders
    .command('create')
    .description('Create a new folder')
    .requiredOption('--title <name>', 'Folder name (max 12 chars)')
    .option('--emoji <emoji>', 'Emoji icon')
    .option('--include-contacts', 'Include contacts')
    .option('--include-non-contacts', 'Include non-contacts')
    .option('--include-groups', 'Include groups')
    .option('--include-channels', 'Include channels')
    .option('--include-bots', 'Include bots')
    .option('--exclude-muted', 'Exclude muted')
    .option('--exclude-read', 'Exclude read')
    .option('--exclude-archived', 'Exclude archived')
    .option('--chat <id>', 'Chat to include (repeatable)', collectOption, [])
    .option('--exclude-chat <id>', 'Chat to exclude (repeatable)', collectOption, [])
    .option('--pin-chat <id>', 'Pin chat in folder (repeatable)', collectOption, [])
    .action(withGlobalOptions((globalFlags, options) => runFoldersCreate(globalFlags, options)));
  folders
    .command('edit')
    .description('Edit an existing folder')
    .argument('<folder>', 'Folder ID or title')
    .option('--title <name>', 'Folder name (max 12 chars)')
    .option('--emoji <emoji>', 'Emoji icon')
    .option('--include-contacts', 'Include contacts')
    .option('--no-include-contacts', 'Do not include contacts')
    .option('--include-non-contacts', 'Include non-contacts')
    .option('--no-include-non-contacts', 'Do not include non-contacts')
    .option('--include-groups', 'Include groups')
    .option('--no-include-groups', 'Do not include groups')
    .option('--include-channels', 'Include channels')
    .option('--no-include-channels', 'Do not include channels')
    .option('--include-bots', 'Include bots')
    .option('--no-include-bots', 'Do not include bots')
    .option('--exclude-muted', 'Exclude muted')
    .option('--no-exclude-muted', 'Do not exclude muted')
    .option('--exclude-read', 'Exclude read')
    .option('--no-exclude-read', 'Do not exclude read')
    .option('--exclude-archived', 'Exclude archived')
    .option('--no-exclude-archived', 'Do not exclude archived')
    .option('--chat <id>', 'Chat to include (repeatable)', collectOption, [])
    .option('--exclude-chat <id>', 'Chat to exclude (repeatable)', collectOption, [])
    .option('--pin-chat <id>', 'Pin chat in folder (repeatable)', collectOption, [])
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersEdit(globalFlags, folder, options)));
  folders
    .command('delete')
    .description('Delete a folder')
    .argument('<folder>', 'Folder ID or title')
    .action(withGlobalOptions((globalFlags, folder) => runFoldersDelete(globalFlags, folder)));
  folders
    .command('reorder')
    .description('Reorder folders')
    .requiredOption('--ids <id1,id2,...>', 'Comma-separated folder IDs in desired order')
    .action(withGlobalOptions((globalFlags, options) => runFoldersReorder(globalFlags, options)));
  const foldersChats = folders.command('chats').description('Manage chats in a folder');
  foldersChats
    .command('add')
    .description('Add chat to folder')
    .argument('<folder>', 'Folder ID or title')
    .requiredOption('--chat <chatId>', 'Chat identifier')
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersChatsAdd(globalFlags, folder, options)));
  foldersChats
    .command('remove')
    .description('Remove chat from folder')
    .argument('<folder>', 'Folder ID or title')
    .requiredOption('--chat <chatId>', 'Chat identifier')
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersChatsRemove(globalFlags, folder, options)));
  folders
    .command('join')
    .description('Join shared folder via invite link')
    .argument('<link>', 'Shared folder invite link')
    .action(withGlobalOptions((globalFlags, link) => runFoldersJoin(globalFlags, link)));

  disableHelpCommand(program);
  program.addHelpText('after', '\nUse "tgcli [command] --help" for more information about a command.');
  program.action(() => {
    program.help();
  });
  return program;
}

function collectOption(value, previous) {
  return previous.concat([value]);
}

function disableHelpCommand(command) {
  command.addHelpCommand(false);
  for (const subcommand of command.commands) {
    disableHelpCommand(subcommand);
  }
}

function getGlobalFlags(command) {
  const options = command.optsWithGlobals();
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : null;
  return {
    json: Boolean(options.json),
    quiet: Boolean(options.quiet),
    timeout: options.timeout ?? null,
    timeoutMs,
  };
}

function withGlobalOptions(handler) {
  return async (...args) => {
    let globalFlags;
    try {
      const command = args[args.length - 1];
      globalFlags = getGlobalFlags(command);
      await handler(globalFlags, ...args);
    } catch (error) {
      writeError(error, globalFlags?.json ?? process.argv.includes('--json'));
      process.exitCode = 1;
    }
  };
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeError(error, asJson) {
  if (error instanceof SendCommandError) {
    if (asJson) {
      process.stderr.write(`${JSON.stringify(buildSendErrorPayload(error.details), null, 2)}\n`);
    } else {
      process.stderr.write(`${formatSendErrorMessage(error.details)}\n`);
    }
    return;
  }
  const message = error?.message ?? String(error);
  if (asJson) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
}

function supportsColorOutput() {
  if (process.env.NO_COLOR) {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

function colorizeNote(message) {
  if (!supportsColorOutput()) {
    return message;
  }
  return `\x1b[33m${message}\x1b[0m`;
}

function printArchiveFallbackNote(channelIds) {
  if (!channelIds?.length) {
    return;
  }
  const prefix = 'Note:';
  if (channelIds.length === 1) {
    const id = channelIds[0];
    const message = `${prefix} no archived messages for ${id}. Showing live results. ` +
      `To archive: tgcli channels watch --chat ${id}; ` +
      'tgcli backfill --once (or --follow).';
    console.log(colorizeNote(message));
    return;
  }
  const message = `${prefix} no archived messages for chats: ${channelIds.join(', ')}. ` +
    'Showing live results. To archive: tgcli channels watch --chat <id>; ' +
    'tgcli backfill --once (or --follow).';
  console.log(colorizeNote(message));
}

function parseDuration(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 1000;
}

// Resolve the effective timeout for a send command.
//   null/undefined (no --timeout)  -> default 30s
//   0 (--timeout 0)                -> 0, meaning disabled/unbounded
//   any positive value             -> honored as given
function resolveSendTimeoutMs(timeoutMs) {
  return timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
}

function formatTimeoutDuration(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return `${timeoutMs}ms`;
  }
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}

// Clear, actionable message used when a send exceeds its timeout budget, so the
// failure reads as a real timeout rather than a generic empty error.
function formatSendTimeoutMessage(timeoutMs) {
  return `Send timed out after ${formatTimeoutDuration(timeoutMs)} (no response from Telegram). `
    + 'Pass --timeout <duration> to extend, or --timeout 0 to disable.';
}

function resolveConfigSpec(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('Config key is required.');
  }
  const normalized = key.trim().toLowerCase();
  const spec = CONFIG_SPECS.find((entry) => entry.key.toLowerCase() === normalized);
  if (!spec) {
    const allowed = CONFIG_SPECS.map((entry) => entry.key).join(', ');
    throw new Error(`Unknown config key "${key}". Supported keys: ${allowed}.`);
  }
  return spec;
}

function normalizeOutputValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && !value.trim()) {
    return null;
  }
  return value;
}

function maskSecret(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value);
  if (str.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(str.length - 4)}${str.slice(-4)}`;
}

function formatConfigValue(value) {
  if (value === null || value === undefined) {
    return 'unset';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function getValueAtPath(target, pathParts) {
  let current = target;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setValueAtPath(target, pathParts, value) {
  let current = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  current[pathParts[pathParts.length - 1]] = value;
}

function deleteValueAtPath(target, pathParts) {
  let current = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    if (!current || typeof current !== 'object') {
      return;
    }
    current = current[part];
  }
  if (current && typeof current === 'object') {
    delete current[pathParts[pathParts.length - 1]];
  }
}

function parseBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  throw new Error('Value must be boolean (true/false).');
}

function parseNumberValue(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function parseStringValue(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`${label} is required.`);
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  return trimmed;
}

function parseConfigValue(spec, rawValue) {
  if (spec.type === 'boolean') {
    return parseBooleanValue(rawValue);
  }
  if (spec.type === 'number') {
    return parseNumberValue(rawValue, spec.key);
  }
  return parseStringValue(rawValue, spec.key);
}



function getFeedbackRateLimitPath(storeDir) {
  return path.join(storeDir, FEEDBACK_LAST_FILE);
}

function readFeedbackLastSentAt(storeDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(getFeedbackRateLimitPath(storeDir), 'utf8'));
    const timestamp = Number(raw?.lastFeedbackAt);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function getFeedbackCooldownRemainingSeconds(storeDir, now = Date.now()) {
  const lastFeedbackAt = readFeedbackLastSentAt(storeDir);
  if (!lastFeedbackAt) {
    return 0;
  }
  const remainingMs = lastFeedbackAt + FEEDBACK_COOLDOWN_MS - now;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function writeFeedbackLastSentAt(storeDir, timestamp = Date.now()) {
  const payload = { lastFeedbackAt: timestamp };
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    getFeedbackRateLimitPath(storeDir),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  return timestamp;
}

function formatFeedbackMessage(messageText, metadata = {}) {
  const version = metadata.version ?? readVersion();
  const platform = metadata.platform ?? process.platform;
  const nodeVersion = metadata.nodeVersion ?? process.version;
  const normalizedMessage = parseStringValue(messageText, 'Feedback message');
  return `💬 tgcli feedback\n\n${normalizedMessage}\n\n---\ntgcli v${version} | ${platform} | ${nodeVersion}`;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function getServiceStatePath(storeDir) {
  return path.join(storeDir, SERVICE_STATE_FILE);
}

function readServiceState(storeDir) {
  try {
    const raw = fs.readFileSync(getServiceStatePath(storeDir), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function getLaunchdPaths() {
  const baseDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  return {
    plistPath: path.join(baseDir, `${LAUNCHD_LABEL}.plist`),
    logPath: path.join(os.homedir(), 'Library', 'Logs', 'tgcli.log'),
    errorLogPath: path.join(os.homedir(), 'Library', 'Logs', 'tgcli.error.log'),
  };
}

function getSystemdPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildLaunchdPlist({ nodePath, cliPath, envVars, logPath, errorLogPath }) {
  const envEntries = Object.entries(envVars || {})
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : '';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(cliPath)}</string>`,
    '    <string>server</string>',
    '  </array>',
    envBlock.trimEnd(),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(errorLogPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildSystemdService({ nodePath, cliPath, envVars }) {
  const envLines = Object.entries(envVars || {}).map(
    ([key, value]) => `Environment=${key}=${JSON.stringify(String(value))}`,
  );
  return [
    '[Unit]',
    'Description=tgcli background service',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${nodePath} ${cliPath} server`,
    'Restart=on-failure',
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function parseBrewServicesList(output) {
  const lines = output.split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [name, status] = line.trim().split(/\s+/);
    if (name === 'tgcli') {
      return { status };
    }
  }
  return null;
}

function detectBrewService() {
  const brewCheck = runCommand('brew', ['--version']);
  if (brewCheck.status !== 0) {
    return { available: false };
  }
  const list = runCommand('brew', ['list', '--formula', 'tgcli']);
  if (list.status !== 0) {
    return { available: true, installed: false };
  }
  const prefixResult = runCommand('brew', ['--prefix', 'tgcli']);
  const brewPrefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : null;
  const cliPath = fs.realpathSync(CLI_PATH);
  const brewCliMatch = brewPrefix ? cliPath.startsWith(path.join(brewPrefix, 'libexec')) : false;

  const servicesResult = runCommand('brew', ['services', 'list']);
  const serviceEntry = servicesResult.status === 0 ? parseBrewServicesList(servicesResult.stdout) : null;
  const serviceAvailable = Boolean(serviceEntry);

  return {
    available: true,
    installed: true,
    brewPrefix,
    brewCliMatch,
    serviceAvailable,
    serviceStatus: serviceEntry?.status ?? null,
  };
}

function resolveServiceManager() {
  const brewInfo = detectBrewService();
  if (brewInfo.available && brewInfo.installed && brewInfo.serviceAvailable) {
    return { manager: 'brew', brewInfo };
  }
  if (process.platform === 'darwin') {
    return { manager: 'launchd', brewInfo };
  }
  if (process.platform === 'linux') {
    const systemctlCheck = runCommand('systemctl', ['--user', '--version']);
    if (systemctlCheck.status !== 0) {
      return { manager: 'unsupported', brewInfo };
    }
    return { manager: 'systemd', brewInfo };
  }
  return { manager: 'unsupported', brewInfo };
}

function runWithTimeout(task, timeoutMs, onTimeout, timeoutMessage = 'Timeout') {
  if (!timeoutMs) {
    return task();
  }
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        if (onTimeout) {
          await onTimeout();
        }
      } finally {
        reject(new Error(timeoutMessage));
      }
    }, timeoutMs);
  });
  return Promise.race([task(), timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function readVersion() {
  try {
    const pkgPath = new URL('./package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch (error) {
    return '0.0.0';
  }
}

function promptInput(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getStoreConfig(storeDir) {
  const { config } = loadConfig(storeDir);
  const normalized = normalizeConfig(config ?? {});
  const missing = validateConfig(normalized);
  return { config: normalized, missing };
}

async function ensureStoreConfig(storeDir) {
  const { config, missing } = getStoreConfig(storeDir);
  if (missing.length === 0) {
    return config;
  }

  const updated = { ...config };
  if (!updated.apiId) {
    updated.apiId = await promptInput('Telegram API ID: ');
  }
  if (!updated.apiHash) {
    updated.apiHash = await promptInput('Telegram API hash: ');
  }
  if (!updated.phoneNumber) {
    updated.phoneNumber = await promptInput('Telegram phone number (+...): ');
  }

  const normalized = normalizeConfig(updated);
  const remaining = validateConfig(normalized);
  if (remaining.length > 0) {
    throw new Error('Missing tgcli configuration. Run "tgcli auth" to set credentials.');
  }
  saveConfig(storeDir, normalized);
  return normalized;
}

function parsePositiveInt(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parseMessageIdWindow(options = {}, { allowOffsetAlias = false } = {}) {
  const beforeId = parsePositiveInt(options.beforeId, '--before-id');
  const afterId = parsePositiveInt(options.afterId, '--after-id');
  const offsetId = allowOffsetAlias
    ? parsePositiveInt(options.offsetId, '--offset-id')
    : null;

  if (beforeId && offsetId && beforeId !== offsetId) {
    throw new Error('--before-id and --offset-id must match when both are provided');
  }

  const resolvedBeforeId = beforeId ?? offsetId ?? null;
  if (resolvedBeforeId && afterId && afterId >= resolvedBeforeId) {
    throw new Error('--after-id must be lower than --before-id');
  }

  return {
    beforeId: resolvedBeforeId,
    afterId,
  };
}

function parseNonNegativeInt(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function collectList(value, previous) {
  const list = previous ?? [];
  list.push(value);
  return list;
}

function parseListValues(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveSource(source) {
  const resolved = source ? String(source).toLowerCase() : 'archive';
  if (!['archive', 'live', 'both'].includes(resolved)) {
    throw new Error(`Invalid source: ${source}`);
  }
  return resolved;
}

function parseDateMs(value, label) {
  if (!value) {
    return null;
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return ts;
}

function filterLiveMessagesByDate(messages, fromDate, toDate) {
  const fromMs = parseDateMs(fromDate, 'after');
  const toMs = parseDateMs(toDate, 'before');
  if (!fromMs && !toMs) {
    return messages;
  }
  return messages.filter((message) => {
    const ts = typeof message.date === 'number' ? message.date * 1000 : null;
    if (!ts) {
      return false;
    }
    if (fromMs && ts < fromMs) {
      return false;
    }
    if (toMs && ts > toMs) {
      return false;
    }
    return true;
  });
}

function getMessageIdValue(message) {
  const value = message?.messageId ?? message?.id;
  return Number.isFinite(value) ? value : null;
}

function filterMessagesById(messages, beforeId, afterId) {
  if (!beforeId && !afterId) {
    return messages;
  }
  return messages.filter((message) => {
    const messageId = getMessageIdValue(message);
    if (!messageId) {
      return false;
    }
    if (beforeId && messageId >= beforeId) {
      return false;
    }
    if (afterId && messageId <= afterId) {
      return false;
    }
    return true;
  });
}

function formatLiveMessage(message, context) {
  const dateIso = message.date ? new Date(message.date * 1000).toISOString() : null;
  return {
    channelId: context.channelId ?? message.peer_id ?? null,
    peerTitle: context.peerTitle ?? null,
    username: context.username ?? null,
    messageId: message.id,
    date: dateIso,
    fromId: message.from_id ?? null,
    fromUsername: message.from_username ?? null,
    fromDisplayName: message.from_display_name ?? null,
    fromPeerType: message.from_peer_type ?? null,
    fromIsBot: typeof message.from_is_bot === 'boolean' ? message.from_is_bot : null,
    text: message.text ?? message.message ?? '',
    urls: message.urls ?? null,
    media: message.media ?? null,
    topicId: message.topic_id ?? null,
  };
}

function getMessageSenderLabel(message) {
  return message.fromDisplayName || message.fromUsername || message.fromId || null;
}

function groupMessagesByChannel(messages) {
  const groups = new Map();
  for (const message of messages) {
    const channelId = message.channelId ?? 'unknown';
    const key = String(channelId);
    let group = groups.get(key);
    if (!group) {
      group = {
        channelId: key,
        peerTitle: message.peerTitle ?? null,
        username: message.username ?? null,
        messages: [],
      };
      groups.set(key, group);
    } else {
      if (!group.peerTitle && message.peerTitle) {
        group.peerTitle = message.peerTitle;
      }
      if (!group.username && message.username) {
        group.username = message.username;
      }
    }
    group.messages.push(message);
  }
  return Array.from(groups.values());
}

function formatPeerHeaderLabel(group) {
  const title = typeof group.peerTitle === 'string' ? group.peerTitle.trim() : '';
  let username = typeof group.username === 'string' ? group.username.trim() : '';
  if (username.startsWith('@')) {
    username = username.slice(1);
  }
  const handle = username ? `@${username}` : '';
  if (title) {
    if (handle && !title.includes(handle)) {
      return `"${title}" (${handle})`;
    }
    return `"${title}"`;
  }
  if (handle) {
    return `${handle}`;
  }
  return group.channelId || 'unknown';
}

function messageDateMs(message) {
  const ts = Date.parse(message.date ?? '');
  return Number.isNaN(ts) ? 0 : ts;
}

function mergeMessageSets(sets, limit) {
  const map = new Map();
  for (const list of sets) {
    for (const message of list) {
      const channelId = message.channelId ?? '';
      const messageId = message.messageId ?? message.id;
      const key = `${String(channelId)}:${String(messageId)}`;
      if (!map.has(key) || message.source === 'live') {
        map.set(key, message);
      }
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => messageDateMs(b) - messageDateMs(a));
  return limit && limit > 0 ? merged.slice(0, limit) : merged;
}

function buildMessageListJsonPayload(source, messages, requestedLimit) {
  const hasMore = messages.length === requestedLimit;
  const payload = {
    source,
    returned: messages.length,
    hasMore,
    messages,
  };

  if (hasMore) {
    const lastMessage = messages[messages.length - 1];
    const nextBeforeId = getMessageIdValue(lastMessage);
    if (nextBeforeId) {
      payload.nextBeforeId = nextBeforeId;
    }
  }

  return payload;
}

function normalizeInviteCode(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('t.me/')) {
    return `https://${trimmed}`;
  }
  if (trimmed.startsWith('+')) {
    return `https://t.me/${trimmed}`;
  }
  if (trimmed.startsWith('@')) {
    return trimmed;
  }
  return `https://t.me/joinchat/${trimmed}`;
}

async function withShutdown(handler) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await handler();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

async function waitForIdle(service, idleExitMs) {
  let idleStart = null;
  while (true) {
    const stats = service.getQueueStats();
    const active = stats.pending + stats.in_progress;
    if (!stats.processing && active === 0) {
      if (!idleStart) {
        idleStart = Date.now();
      }
      if (Date.now() - idleStart >= idleExitMs) {
        return;
      }
    } else {
      idleStart = null;
    }
    await delay(500);
  }
}

async function runAuthStatus(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const { config, missing } = getStoreConfig(storeDir);
    if (missing.length > 0) {
      if (globalFlags.json) {
        writeJson({ authenticated: false, configured: false });
      } else {
        console.log('Not authenticated. Run `tgcli auth`.');
      }
      return;
    }
    const { telegramClient, messageSyncService } = createServices({ storeDir, config });
    try {
      const me = await telegramClient.getCurrentUser();
      const authenticated = Boolean(me);
      const search = messageSyncService.getSearchStatus();
      const username = me?.username ? `@${me.username}` : null;
      const payload = {
        authenticated,
        configured: true,
        phoneNumber: config.phoneNumber || null,
        username: me?.username ?? null,
        ftsEnabled: search.enabled,
      };
      if (globalFlags.json) {
        writeJson(payload);
      } else {
        if (!authenticated) {
          console.log('Not authenticated. Run `tgcli auth`.');
        } else if (username) {
          console.log(`Authenticated as ${config.phoneNumber} (${username}).`);
        } else {
          console.log(`Authenticated as ${config.phoneNumber}.`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
    }
  }, timeoutMs);
}

async function runAuthLogout(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const { missing } = getStoreConfig(storeDir);
    if (missing.length > 0) {
      if (globalFlags.json) {
        writeJson({ loggedOut: false, configured: false });
      } else {
        console.log('Not authenticated.');
      }
      return;
    }
    const release = acquireStoreLock(storeDir);
    const config = await ensureStoreConfig(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir, config });
    try {
      await telegramClient.login();
      await telegramClient.client.logout();
      if (globalFlags.json) {
        writeJson({ loggedOut: true });
      } else {
        console.log('Logged out.');
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

export async function runAuthLogin(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  let release = null;
  let telegramClient = null;
  let messageSyncService = null;
  let keepRunning = false;
  const cleanup = async () => {
    if (messageSyncService) {
      const currentService = messageSyncService;
      messageSyncService = null;
      await currentService.shutdown();
    }
    if (telegramClient) {
      const currentClient = telegramClient;
      telegramClient = null;
      await currentClient.destroy();
    }
    if (release) {
      const currentRelease = release;
      release = null;
      currentRelease();
    }
  };
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const config = await ensureStoreConfig(storeDir);
    release = acquireStoreLock(storeDir);
    try {
      ({ telegramClient } = createTelegramClient({
        storeDir,
        config,
        forceSms: options.forceSms,
        useQr: options.qr,
        qrFilePath: options.qrFile,
        json: globalFlags.json,
        disableUpdates: !options.follow,
      }));
      const loginSuccess = await telegramClient.login();
      if (!loginSuccess) {
        throw new Error('Failed to login to Telegram.');
      }
      if (options.follow) {
        ({ messageSyncService } = createMessageSyncService(telegramClient, { storeDir }));
        await messageSyncService.refreshChannelsFromDialogs();
        await telegramClient.startUpdates();
        messageSyncService.startRealtimeSync();
        messageSyncService.resumePendingJobs();
        await withShutdown(async () => {
          await cleanup();
        });
        keepRunning = true;
        return;
      }

      if (globalFlags.json) {
        writeJson({ authenticated: true });
      } else {
        console.log(`Authenticated. ${AUTH_SYNC_HINT}`);
      }
    } finally {
      if (!keepRunning) {
        await cleanup();
      }
    }
  }, timeoutMs, cleanup);
}

async function runConfigList(globalFlags) {
  const storeDir = resolveStoreDir();
  const { config } = loadConfig(storeDir);
  const normalized = normalizeConfig(config ?? {});
  const payload = {};
  for (const spec of CONFIG_SPECS) {
    let value = normalizeOutputValue(getValueAtPath(normalized, spec.path));
    if (spec.secret) {
      value = maskSecret(value);
    }
    payload[spec.key] = value;
  }
  if (globalFlags.json) {
    writeJson(payload);
    return;
  }
  for (const [key, value] of Object.entries(payload)) {
    console.log(`${key}: ${formatConfigValue(value)}`);
  }
}

async function runConfigGet(globalFlags, key) {
  const storeDir = resolveStoreDir();
  const spec = resolveConfigSpec(key);
  const { config } = loadConfig(storeDir);
  const normalized = normalizeConfig(config ?? {});
  const value = normalizeOutputValue(getValueAtPath(normalized, spec.path));
  if (globalFlags.json) {
    writeJson({ key: spec.key, value });
    return;
  }
  console.log(`${spec.key}: ${formatConfigValue(value)}`);
}

async function runConfigSet(globalFlags, key, value) {
  const storeDir = resolveStoreDir();
  const spec = resolveConfigSpec(key);
  const parsedValue = parseConfigValue(spec, value);
  const { config } = loadConfig(storeDir);
  const next = normalizeConfig(config ?? {});
  setValueAtPath(next, spec.path, parsedValue);
  const { config: saved } = saveConfig(storeDir, next);
  const storedValue = normalizeOutputValue(getValueAtPath(saved, spec.path));
  if (globalFlags.json) {
    writeJson({ ok: true, key: spec.key, value: storedValue });
    return;
  }
  console.log(`Updated ${spec.key}: ${formatConfigValue(storedValue)}`);
}

async function runConfigUnset(globalFlags, key) {
  const storeDir = resolveStoreDir();
  const spec = resolveConfigSpec(key);
  const { config } = loadConfig(storeDir);
  if (!config) {
    if (globalFlags.json) {
      writeJson({ ok: true, key: spec.key, value: null });
    } else {
      console.log(`${spec.key} already unset.`);
    }
    return;
  }
  const next = normalizeConfig(config ?? {});
  deleteValueAtPath(next, spec.path);
  const { config: saved } = saveConfig(storeDir, next);
  const storedValue = normalizeOutputValue(getValueAtPath(saved, spec.path));
  if (globalFlags.json) {
    writeJson({ ok: true, key: spec.key, value: storedValue });
    return;
  }
  console.log(`Cleared ${spec.key}.`);
}

async function runFeedback(globalFlags, messageParts, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    let telegramClient = null;
    let messageSyncService = null;

    try {
      const { config } = loadConfig(storeDir);
      const normalizedConfig = normalizeConfig(config ?? {});
      const chatId = normalizedConfig.feedback?.chatId || FEEDBACK_DEFAULT_CHAT_ID;

            const remainingSeconds = getFeedbackCooldownRemainingSeconds(storeDir);
      if (remainingSeconds > 0) {
        throw new Error(`Please wait ${remainingSeconds} seconds before sending another feedback.`);
      }

      ({ telegramClient, messageSyncService } = createServices({
        storeDir,
        config: normalizedConfig,
      }));

      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }

      const feedbackText = formatFeedbackMessage(
        Array.isArray(messageParts) ? messageParts.join(' ') : String(messageParts ?? ''),
      );
      const result = await telegramClient.sendTextMessage(chatId, feedbackText, {
        parseMode: 'none',
      });
      writeFeedbackLastSentAt(storeDir);

      if (globalFlags.json) {
        writeJson({
          ok: true,
          messageId: result?.messageId ?? null,
        });
      } else {
        console.log(`Feedback sent (${result?.messageId ?? 'unknown'}).`);
      }
    } finally {
      if (messageSyncService) {
        await messageSyncService.shutdown();
      }
      if (telegramClient) {
        await telegramClient.destroy();
      }
      release();
    }
  }, timeoutMs);
}

async function runSync(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    const idleExitMs = parseDuration(options.idleExit || '30s');
    const follow = options.follow || !options.once;

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }

      await messageSyncService.refreshChannelsFromDialogs();
      messageSyncService.resumePendingJobs();

      if (follow) {
        await telegramClient.startUpdates();
        messageSyncService.startRealtimeSync();
        if (!globalFlags.json) {
          console.log('Sync running. Press Ctrl+C to stop.');
        }
        await withShutdown(async () => {
          await messageSyncService.shutdown();
          await telegramClient.destroy();
          release();
        });
        return;
      }

      await waitForIdle(messageSyncService, idleExitMs);
      const stats = messageSyncService.getQueueStats();
      if (globalFlags.json) {
        writeJson({ ok: true, mode: 'once', queue: stats });
      } else {
        console.log('Sync complete.');
      }
    } finally {
      if (!follow) {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
        release();
      }
    }
  }, timeoutMs);
}

async function runServer(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  // When no --idle-exit is passed the server stays up forever (manual server is
  // always-on). Validate the duration here so a bad value fails fast in the CLI.
  const idleExitMs = options.idleExit ? parseDuration(options.idleExit) : null;
  let child = null;

  const runChild = () => new Promise((resolve, reject) => {
    const serverPath = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
    const handleSignal = (signal) => {
      if (child && !child.killed) {
        child.kill(signal);
      }
    };
    const cleanup = () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    const childArgs = [serverPath];
    if (Number.isFinite(idleExitMs) && idleExitMs > 0) {
      childArgs.push('--idle-exit', String(idleExitMs));
    }

    child = spawn(process.execPath, childArgs, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('exit', (code, signal) => {
      cleanup();
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
        resolve();
        return;
      }
      reject(new Error(`Server exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`));
    });
  });

  const { missing } = getStoreConfig(resolveStoreDir());
  if (missing.length > 0) {
    throw new Error('Not authenticated. Run "tgcli auth" to configure credentials.');
  }

  return runWithTimeout(runChild, timeoutMs, () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  });
}

async function runServiceInstall(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { manager, brewInfo } = resolveServiceManager();
    const envVars = {
      TGCLI_SERVICE_MANAGER: manager,
    };
    if (process.env.TGCLI_STORE) {
      envVars.TGCLI_STORE = process.env.TGCLI_STORE;
    }

    if (manager === 'brew') {
      const note = brewInfo?.brewCliMatch
        ? 'Brew service available. Use `tgcli service start`.'
        : 'Brew service available, but current tgcli is not from brew.';
      if (globalFlags.json) {
        writeJson({ manager, installed: true, note });
      } else {
        console.log(note);
      }
      return;
    }

    if (manager === 'unsupported') {
      throw new Error('Service install is supported only on macOS and Linux.');
    }

    if (manager === 'launchd') {
      const { plistPath, logPath, errorLogPath } = getLaunchdPaths();
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      const content = buildLaunchdPlist({
        nodePath: process.execPath,
        cliPath: CLI_PATH,
        envVars,
        logPath,
        errorLogPath,
      });
      fs.writeFileSync(plistPath, content, 'utf8');
      if (globalFlags.json) {
        writeJson({ manager, installed: true, path: plistPath });
      } else {
        console.log(`Service installed at ${plistPath}. Run \`tgcli service start\` to launch.`);
      }
      return;
    }

    if (manager === 'systemd') {
      const servicePath = getSystemdPath();
      fs.mkdirSync(path.dirname(servicePath), { recursive: true });
      const content = buildSystemdService({
        nodePath: process.execPath,
        cliPath: CLI_PATH,
        envVars,
      });
      fs.writeFileSync(servicePath, content, 'utf8');
      runCommand('systemctl', ['--user', 'daemon-reload']);
      if (globalFlags.json) {
        writeJson({ manager, installed: true, path: servicePath });
      } else {
        console.log(`Service installed at ${servicePath}. Run \`tgcli service start\` to launch.`);
      }
      return;
    }
  }, timeoutMs);
}

async function runServiceStart(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { manager, brewInfo } = resolveServiceManager();

    if (manager === 'brew') {
      const result = runCommand('brew', ['services', 'start', 'tgcli'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Failed to start brew service.');
      }
      if (globalFlags.json) {
        writeJson({ manager, started: true });
      }
      if (!brewInfo?.brewCliMatch && !globalFlags.json) {
        console.log('Warning: brew-managed service may not match this tgcli binary.');
      }
      return;
    }

    if (manager === 'unsupported') {
      throw new Error('Service start is supported only on macOS and Linux.');
    }

    if (manager === 'launchd') {
      const { plistPath } = getLaunchdPaths();
      if (!fs.existsSync(plistPath)) {
        throw new Error(`Service not installed. Run \`tgcli service install\` first.`);
      }
      const domain = `gui/${process.getuid()}`;
      const result = runCommand('launchctl', ['bootstrap', domain, plistPath]);
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Failed to start launchd service.');
      }
      if (globalFlags.json) {
        writeJson({ manager, started: true });
      } else {
        console.log('Service started.');
      }
      return;
    }

    if (manager === 'systemd') {
      const servicePath = getSystemdPath();
      if (!fs.existsSync(servicePath)) {
        throw new Error(`Service not installed. Run \`tgcli service install\` first.`);
      }
      const result = runCommand('systemctl', ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME]);
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Failed to start systemd service.');
      }
      if (globalFlags.json) {
        writeJson({ manager, started: true });
      } else {
        console.log('Service started.');
      }
    }
  }, timeoutMs);
}

async function runServiceStop(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { manager } = resolveServiceManager();

    if (manager === 'brew') {
      const result = runCommand('brew', ['services', 'stop', 'tgcli'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Failed to stop brew service.');
      }
      if (globalFlags.json) {
        writeJson({ manager, stopped: true });
      }
      return;
    }

    if (manager === 'unsupported') {
      throw new Error('Service stop is supported only on macOS and Linux.');
    }

    if (manager === 'launchd') {
      const { plistPath } = getLaunchdPaths();
      if (!fs.existsSync(plistPath)) {
        throw new Error(`Service not installed. Run \`tgcli service install\` first.`);
      }
      const domain = `gui/${process.getuid()}`;
      const result = runCommand('launchctl', ['bootout', domain, plistPath]);
      if (result.status !== 0 && result.stderr.trim()) {
        throw new Error(result.stderr || 'Failed to stop launchd service.');
      }
      if (globalFlags.json) {
        writeJson({ manager, stopped: true });
      } else {
        console.log('Service stopped.');
      }
      return;
    }

    if (manager === 'systemd') {
      const result = runCommand('systemctl', ['--user', 'stop', SYSTEMD_SERVICE_NAME]);
      if (result.status !== 0) {
        throw new Error(result.stderr || 'Failed to stop systemd service.');
      }
      if (globalFlags.json) {
        writeJson({ manager, stopped: true });
      } else {
        console.log('Service stopped.');
      }
    }
  }, timeoutMs);
}

async function runServiceStatus(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { manager, brewInfo } = resolveServiceManager();
    const storeDir = resolveStoreDir();
    const serviceState = readServiceState(storeDir);
    const cliVersion = readVersion();

    let installed = false;
    let running = false;
    let pid = null;
    let statusLabel = null;

    if (manager === 'brew') {
      installed = Boolean(brewInfo?.installed && brewInfo.serviceAvailable);
      if (brewInfo?.serviceStatus) {
        statusLabel = brewInfo.serviceStatus;
        running = brewInfo.serviceStatus === 'started';
      }
    } else if (manager === 'launchd') {
      const { plistPath } = getLaunchdPaths();
      installed = fs.existsSync(plistPath);
      const list = runCommand('launchctl', ['list']);
      if (list.status === 0) {
        const lines = list.stdout.split('\n');
        for (const line of lines) {
          if (!line.includes(LAUNCHD_LABEL)) continue;
          const parts = line.trim().split(/\s+/);
          const pidValue = parts[0];
          pid = pidValue && pidValue !== '-' ? Number(pidValue) : null;
          running = Boolean(pid);
          statusLabel = running ? 'started' : 'stopped';
          break;
        }
      }
    } else if (manager === 'systemd') {
      const servicePath = getSystemdPath();
      installed = fs.existsSync(servicePath);
      const active = runCommand('systemctl', ['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
      running = active.status === 0 && active.stdout.trim() === 'active';
      statusLabel = active.stdout.trim();
    } else {
      statusLabel = 'unsupported';
    }

    const serviceVersion = serviceState?.version ?? null;
    const versionMismatch = serviceVersion && cliVersion && serviceVersion !== cliVersion;
    const resolvedPid = running ? (pid ?? serviceState?.pid ?? null) : null;
    const output = {
      manager,
      installed,
      running,
      status: statusLabel,
      pid: resolvedPid,
      serviceVersion,
      cliVersion,
      storeDir,
      mcpEnabled: serviceState?.mcpEnabled ?? null,
    };

    if (globalFlags.json) {
      writeJson({
        ...output,
        versionMismatch,
        brewCliMatch: brewInfo?.brewCliMatch ?? null,
      });
      return;
    }

    console.log(`Manager: ${manager}`);
    console.log(`Installed: ${installed ? 'yes' : 'no'}`);
    console.log(`Running: ${running ? 'yes' : 'no'}`);
    if (statusLabel) {
      console.log(`Status: ${statusLabel}`);
    }
    if (output.pid) {
      console.log(`PID: ${output.pid}`);
    }
    if (serviceVersion) {
      console.log(`Service version: ${serviceVersion}`);
    }
    console.log(`CLI version: ${cliVersion}`);
    console.log(`Store: ${storeDir}`);
    if (serviceState && serviceState.mcpEnabled !== null && serviceState.mcpEnabled !== undefined) {
      console.log(`MCP enabled: ${serviceState.mcpEnabled ? 'yes' : 'no'}`);
    }
    if (versionMismatch) {
      console.log('Warning: service version differs from CLI. Run `tgcli doctor`.');
    }
    if (manager === 'brew' && brewInfo && brewInfo.brewCliMatch === false) {
      console.log('Warning: brew-managed service may not match this tgcli binary.');
    }
  }, timeoutMs);
}

async function runServiceLogs(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { manager } = resolveServiceManager();

    if (manager === 'brew') {
      const info = runCommand('brew', ['services', 'info', 'tgcli']);
      if (info.status !== 0) {
        throw new Error(info.stderr || 'Failed to read brew service info.');
      }
      const match = info.stdout.match(/Log:\s+(.+)/i);
      const logPath = match ? match[1].trim() : null;
      if (globalFlags.json) {
        writeJson({ manager, logPath });
        return;
      }
      if (logPath && fs.existsSync(logPath)) {
        runCommand('tail', ['-n', '200', logPath], { stdio: 'inherit' });
      } else {
        process.stdout.write(info.stdout);
      }
      return;
    }

    if (manager === 'launchd') {
      const { logPath, errorLogPath } = getLaunchdPaths();
      if (globalFlags.json) {
        writeJson({ manager, logPath, errorLogPath });
        return;
      }
      if (fs.existsSync(logPath)) {
        runCommand('tail', ['-n', '200', logPath], { stdio: 'inherit' });
      } else if (fs.existsSync(errorLogPath)) {
        runCommand('tail', ['-n', '200', errorLogPath], { stdio: 'inherit' });
      } else {
        console.log('No log file found.');
      }
      return;
    }

    if (manager === 'systemd') {
      if (globalFlags.json) {
        writeJson({ manager, journal: true });
        return;
      }
      runCommand('journalctl', ['--user', '-u', SYSTEMD_SERVICE_NAME, '-n', '200', '--no-pager'], {
        stdio: 'inherit',
      });
      return;
    }

    throw new Error('Service logs are supported only on macOS and Linux.');
  }, timeoutMs);
}

async function runSyncStatus(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const queue = messageSyncService.getQueueStats();
      if (globalFlags.json) {
        writeJson({ queue });
      } else {
        console.log(`QUEUE: pending=${queue.pending} in_progress=${queue.in_progress} idle=${queue.idle} error=${queue.error}`);
        console.log(`PROCESSING: ${queue.processing}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
    }
  }, timeoutMs);
}

async function runSyncJobsList(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const status = options.status ? String(options.status) : null;
    if (status && !['pending', 'in_progress', 'idle', 'error'].includes(status)) {
      throw new Error(`Unknown status: ${status}`);
    }
    const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const jobs = messageSyncService.listJobs({
        status,
        channelId: options.channel ?? null,
        limit,
      });
      if (globalFlags.json) {
        writeJson(jobs);
      } else {
        for (const job of jobs) {
          const label = job.peer_title || job.channel_id;
          console.log(`#${job.id} ${label} [${job.status}] ${job.message_count}/${job.target_message_count}`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
    }
  }, timeoutMs);
}

async function runSyncJobsAdd(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const depth = parsePositiveInt(options.depth, '--depth');
      const job = messageSyncService.addJob(options.chat, {
        depth,
        minDate: options.minDate ?? null,
      });
      void messageSyncService.processQueue();
      if (globalFlags.json) {
        writeJson(job);
      } else {
        console.log(`Job scheduled for ${job.channel_id} (#${job.id}).`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runSyncJobsRetry(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const jobId = parsePositiveInt(options.jobId, '--job-id');
    const channelId = options.channel ?? null;
    const allErrors = Boolean(options.allErrors);
    if (!jobId && !channelId && !allErrors) {
      throw new Error('--job-id, --channel, or --all-errors is required');
    }
    if (allErrors && (jobId || channelId)) {
      throw new Error('Use --all-errors without --job-id/--channel');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const result = messageSyncService.retryJobs({
        jobId,
        channelId,
        allErrors,
      });
      const authed = await telegramClient.isAuthorized().catch(() => false);
      if (authed && result.updated > 0) {
        void messageSyncService.processQueue();
      }
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Re-queued ${result.updated} job(s).`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runSyncJobsCancel(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const jobId = parsePositiveInt(options.jobId, '--job-id');
    const channelId = options.channel ?? null;
    if (!jobId && !channelId) {
      throw new Error('--job-id or --channel is required');
    }
    if (jobId && channelId) {
      throw new Error('Use --job-id or --channel, not both');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const result = messageSyncService.cancelJobs({
        jobId,
        channelId,
      });
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Canceled ${result.canceled} job(s).`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runDoctor(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const lock = readStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      let authenticated = false;
      let connected = false;
      try {
        authenticated = await telegramClient.isAuthorized();
        if (options.connect && authenticated) {
          await telegramClient.startUpdates();
          connected = true;
        }
      } catch (error) {
        authenticated = false;
      }

      const search = messageSyncService.getSearchStatus();
      const queue = messageSyncService.getQueueStats();

      const payload = {
        storeDir,
        lockHeld: lock.exists,
        lockInfo: lock.info,
        authenticated,
        connected,
        ftsEnabled: search.enabled,
        ftsVersion: search.version,
        queue,
      };

      if (globalFlags.json) {
        writeJson(payload);
        return;
      }

      console.log(`STORE: ${payload.storeDir}`);
      console.log(`LOCKED: ${payload.lockHeld}${payload.lockInfo ? ` (${payload.lockInfo})` : ''}`);
      console.log(`AUTHENTICATED: ${payload.authenticated}`);
      console.log(`CONNECTED: ${payload.connected}`);
      console.log(`FTS: ${payload.ftsEnabled}${payload.ftsVersion ? ` (v${payload.ftsVersion})` : ''}`);
      console.log(`QUEUE: pending=${queue.pending} in_progress=${queue.in_progress} idle=${queue.idle} error=${queue.error}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
    }
  }, timeoutMs);
}

async function runChannelsList(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const limit = parsePositiveInt(options.limit, '--limit') ?? 50;
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const dialogs = options.query
        ? await telegramClient.searchDialogs(options.query, limit)
        : await telegramClient.listDialogs(limit);

      if (globalFlags.json) {
        writeJson(dialogs);
      } else {
        for (const dialog of dialogs) {
          const label = dialog.title || dialog.username || dialog.id;
          console.log(`${label} (${dialog.id})`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runChannelsShow(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      let channel = messageSyncService.getChannel(options.chat);
      if (!channel) {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const meta = await telegramClient.getPeerMetadata(options.chat);
        channel = {
          channelId: String(options.chat),
          peerTitle: meta?.peerTitle ?? null,
          peerType: meta?.peerType ?? null,
          chatType: meta?.chatType ?? null,
          isForum: meta?.isForum ?? null,
          username: meta?.username ?? null,
          syncEnabled: null,
          lastMessageId: null,
          lastMessageDate: null,
          oldestMessageId: null,
          oldestMessageDate: null,
          about: meta?.about ?? null,
          metadataUpdatedAt: null,
          createdAt: null,
          updatedAt: null,
          source: 'live',
        };
      }

      if (globalFlags.json) {
        writeJson(channel);
      } else {
        console.log(JSON.stringify(channel, null, 2));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runChannelsSync(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (options.enable && options.disable) {
      throw new Error('Use either --enable or --disable');
    }
    if (!options.enable && !options.disable) {
      throw new Error('--enable or --disable is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const result = messageSyncService.setChannelSync(options.chat, Boolean(options.enable));
      let job = null;
      let jobQueued = false;
      if (options.enable) {
        const existing = messageSyncService.listJobs({ channelId: options.chat, limit: 1 });
        if (existing.length > 0) {
          job = existing[0];
        } else {
          job = messageSyncService.addJob(options.chat);
          jobQueued = true;
        }
      }
      if (globalFlags.json) {
        writeJson({
          channelId: result.channel_id,
          syncEnabled: Boolean(result.sync_enabled),
          jobId: job?.id ?? null,
          jobStatus: job?.status ?? null,
          jobQueued,
        });
      } else {
        if (result.sync_enabled) {
          const jobMessage = job
            ? jobQueued
              ? ` Backfill job queued (#${job.id}).`
              : ` Backfill job exists (#${job.id}, ${job.status}).`
            : '';
          console.log(
            `Sync enabled for ${result.channel_id}.${jobMessage} ` +
              'Run `tgcli backfill --once` (or `tgcli backfill --follow`/`tgcli server`) to process.',
          );
        } else {
          console.log(`Sync disabled for ${result.channel_id}`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runChannelsMarkRead(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (!options.messageId) {
      throw new Error('--message-id is required');
    }
    const messageId = parsePositiveInt(options.messageId, '--message-id');
    if (messageId === null) {
      throw new Error('--message-id must be a positive integer');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.markChannelRead(options.chat, messageId);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Marked channel ${result.channelId} as read up to message ${result.messageId}.`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

function createLiveMetadataResolver(messageSyncService, telegramClient) {
  return async (channelId, fallback = {}) => {
    const meta = messageSyncService.getChannelMetadata(channelId);
    let peerTitle = meta?.peerTitle ?? fallback.peerTitle ?? null;
    let username = meta?.username ?? fallback.username ?? null;
    if (!peerTitle || !username) {
      const live = await telegramClient.getPeerMetadata(channelId);
      peerTitle = peerTitle ?? live?.peerTitle ?? null;
      username = username ?? live?.username ?? null;
    }
    return { peerTitle, username };
  };
}

async function runMessagesList(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    const resolveLiveMetadata = createLiveMetadataResolver(messageSyncService, telegramClient);
    try {
      const resolvedSource = resolveSource(options.source);
      const channelIds = parseListValues(options.chat);
      const topicId = parsePositiveInt(options.topic, '--topic');
      const finalLimit = parsePositiveInt(options.limit, '--limit') ?? 50;
      const { beforeId, afterId } = parseMessageIdWindow(options, { allowOffsetAlias: true });
      let archivedResults = [];
      let liveResults = [];
      let usedLiveFallback = false;
      let authChecked = false;

      const ensureAuthorized = async () => {
        if (authChecked) {
          return;
        }
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        authChecked = true;
      };

      const fetchLiveMessages = async (liveChannelIds) => {
        await ensureAuthorized();
        const results = [];
        for (const id of liveChannelIds) {
          let peerTitle = null;
          let username = null;
          let liveMessages = [];

          if (topicId) {
            const response = await telegramClient.getTopicMessages(id, topicId, finalLimit, {
              beforeId,
              afterId,
            });
            liveMessages = filterMessagesById(response.messages, beforeId, afterId);
          } else {
            const fetchOptions = {};
            if (beforeId) {
              fetchOptions.beforeId = beforeId;
            }
            if (afterId) {
              fetchOptions.afterId = afterId;
            }
            const response = await telegramClient.getMessagesByChannelId(id, finalLimit, fetchOptions);
            liveMessages = filterMessagesById(response.messages, beforeId, afterId);
            peerTitle = response.peerTitle ?? null;
          }

          const meta = await resolveLiveMetadata(id, { peerTitle, username });
          peerTitle = meta.peerTitle;
          username = meta.username;

          const filtered = filterLiveMessagesByDate(liveMessages, options.after, options.before);
          const formatted = filtered.map((message) => ({
            ...formatLiveMessage(message, { channelId: String(id), peerTitle, username }),
            source: 'live',
          }));
          results.push(...formatted);
        }
        return results;
      };

      if (resolvedSource === 'archive' || resolvedSource === 'both') {
        const archived = messageSyncService.listArchivedMessages({
          channelIds: channelIds.length ? channelIds : null,
          topicId,
          fromDate: options.after,
          toDate: options.before,
          beforeId,
          afterId,
          limit: finalLimit,
        });
        archivedResults = archived.map((message) => ({ ...message, source: 'archive' }));
      }

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        if (!channelIds.length) {
          throw new Error('--chat is required for live source.');
        }
        liveResults = await fetchLiveMessages(channelIds);
      }

      if (resolvedSource === 'archive' && archivedResults.length === 0 && channelIds.length) {
        liveResults = await fetchLiveMessages(channelIds);
        usedLiveFallback = true;
      }

      let messages = [];
      let outputSource = resolvedSource;
      if (resolvedSource === 'both') {
        messages = mergeMessageSets([archivedResults, liveResults], finalLimit);
      } else if (resolvedSource === 'live' || usedLiveFallback) {
        messages = liveResults;
        outputSource = 'live';
      } else {
        messages = archivedResults;
      }

      if (globalFlags.json) {
        writeJson(buildMessageListJsonPayload(outputSource, messages, finalLimit));
      } else {
        const groups = groupMessagesByChannel(messages);
        for (const group of groups) {
          const label = formatPeerHeaderLabel(group);
          const count = group.messages.length;
          console.log(`Showing ${count} message${count === 1 ? '' : 's'} for ${label}:`);
          for (const message of group.messages) {
            const sender = getMessageSenderLabel(message) || 'unknown';
            const text = (message.text || '').replace(/\s+/g, ' ').trim();
            const prefix = outputSource === 'both' ? `[${message.source}] ` : '';
            console.log(`${prefix}${message.date ?? ''} ${sender} #${message.messageId}: ${text}`);
          }
          if (groups.length > 1) {
            console.log('');
          }
        }
        if (usedLiveFallback) {
          printArchiveFallbackNote(channelIds);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMessagesSearch(globalFlags, queryParts, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    const resolveLiveMetadata = createLiveMetadataResolver(messageSyncService, telegramClient);
    try {
      const query = options.query || (queryParts || []).join(' ').trim();
      const resolvedSource = resolveSource(options.source);
      const channelIds = parseListValues(options.chat);
      const tagList = [
        ...parseListValues(options.tag),
        ...parseListValues(options.tags),
      ];
      const topicId = parsePositiveInt(options.topic, '--topic');
      const finalLimit = parsePositiveInt(options.limit, '--limit') ?? 100;
      const { beforeId, afterId } = parseMessageIdWindow(options);
      const caseInsensitive = !options.caseSensitive;

      if (!query && !options.regex && tagList.length === 0) {
        throw new Error('Provide query, regex, or tag for messages search.');
      }

      let archivedResults = [];
      let liveResults = [];
      let usedLiveFallback = false;
      let authChecked = false;

      const ensureAuthorized = async () => {
        if (authChecked) {
          return;
        }
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        authChecked = true;
      };

      const buildLiveChannelIds = () => {
        let liveChannelIds = channelIds;
        if (!liveChannelIds.length && tagList.length) {
          const tagged = new Map();
          for (const tag of tagList) {
            const channels = messageSyncService.listTaggedChannels(tag, { limit: 200 });
            for (const channel of channels) {
              tagged.set(channel.channelId, channel);
            }
          }
          liveChannelIds = Array.from(tagged.keys());
        }
        return liveChannelIds;
      };

      const fetchLiveResults = async (liveChannelIds) => {
        await ensureAuthorized();
        let liveRegex = null;
        if (options.regex) {
          try {
            liveRegex = new RegExp(options.regex, caseInsensitive ? 'i' : '');
          } catch (error) {
            throw new Error(`Invalid regex: ${error.message}`);
          }
        }

        const results = [];
        for (const id of liveChannelIds) {
          let peerTitle = null;
          let username = null;
          let liveMessages = [];

          if (query) {
            const response = await telegramClient.searchChannelMessages(id, {
              query,
              limit: finalLimit,
              topicId,
              beforeId,
              afterId,
            });
            liveMessages = response.messages;
            peerTitle = response.peerTitle ?? null;
          } else if (topicId) {
            const response = await telegramClient.getTopicMessages(id, topicId, finalLimit, {
              beforeId,
              afterId,
            });
            liveMessages = response.messages;
          } else {
            const response = await telegramClient.getMessagesByChannelId(id, finalLimit, {
              beforeId,
              afterId,
            });
            liveMessages = response.messages;
            peerTitle = response.peerTitle ?? null;
          }

          const meta = await resolveLiveMetadata(id, { peerTitle, username });
          peerTitle = meta.peerTitle;
          username = meta.username;

          let filtered = filterLiveMessagesByDate(liveMessages, options.after, options.before);
          filtered = filterMessagesById(filtered, beforeId, afterId);
          if (liveRegex) {
            filtered = filtered.filter((message) =>
              liveRegex.test(message.text ?? message.message ?? ''),
            );
          }

          const formatted = filtered.map((message) => ({
            ...formatLiveMessage(message, { channelId: String(id), peerTitle, username }),
            source: 'live',
          }));
          results.push(...formatted);
        }
        return results;
      };

      if (resolvedSource === 'archive' || resolvedSource === 'both') {
        const archived = messageSyncService.searchArchiveMessages({
          query,
          regex: options.regex,
          tags: tagList.length ? tagList : null,
          channelIds: channelIds.length ? channelIds : null,
          topicId,
          fromDate: options.after,
          toDate: options.before,
          beforeId,
          afterId,
          limit: finalLimit,
          caseInsensitive,
        });
        archivedResults = archived.map((message) => ({ ...message, source: 'archive' }));
      }

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        const liveChannelIds = buildLiveChannelIds();
        if (!liveChannelIds.length) {
          throw new Error('--chat is required for live search.');
        }
        liveResults = await fetchLiveResults(liveChannelIds);
      }

      if (resolvedSource === 'archive' && archivedResults.length === 0) {
        const liveChannelIds = buildLiveChannelIds();
        if (liveChannelIds.length) {
          liveResults = await fetchLiveResults(liveChannelIds);
          usedLiveFallback = true;
        }
      }

      let messages = [];
      let outputSource = resolvedSource;
      if (resolvedSource === 'both') {
        messages = mergeMessageSets([archivedResults, liveResults], finalLimit);
      } else if (resolvedSource === 'live' || usedLiveFallback) {
        messages = liveResults;
        outputSource = 'live';
      } else {
        messages = archivedResults;
      }

      if (globalFlags.json) {
        writeJson({ source: outputSource, returned: messages.length, messages });
      } else {
        const groups = groupMessagesByChannel(messages);
        for (const group of groups) {
          const label = formatPeerHeaderLabel(group);
          const count = group.messages.length;
          console.log(`Showing ${count} message${count === 1 ? '' : 's'} for ${label}:`);
          for (const message of group.messages) {
            const sender = getMessageSenderLabel(message) || 'unknown';
            const text = (message.text || '').replace(/\s+/g, ' ').trim();
            const prefix = outputSource === 'both' ? `[${message.source}] ` : '';
            console.log(`${prefix}${message.date ?? ''} ${sender} #${message.messageId}: ${text}`);
          }
          if (groups.length > 1) {
            console.log('');
          }
        }
        if (usedLiveFallback) {
          printArchiveFallbackNote(buildLiveChannelIds());
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMessagesShow(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (!options.id) {
      throw new Error('--id is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    const resolveLiveMetadata = createLiveMetadataResolver(messageSyncService, telegramClient);
    try {
      const messageId = parsePositiveInt(options.id, '--id');
      const resolvedSource = resolveSource(options.source);
      let message = null;
      let resolvedFrom = null;
      let usedLiveFallback = false;

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const live = await telegramClient.getMessageById(options.chat, messageId);
        if (live) {
          const meta = await resolveLiveMetadata(options.chat);
          message = {
            ...formatLiveMessage(live, { channelId: String(options.chat), ...meta }),
            source: 'live',
          };
          resolvedFrom = 'live';
        }
      }

      if (!message && (resolvedSource === 'archive' || resolvedSource === 'both')) {
        const archived = messageSyncService.getArchivedMessage({
          channelId: options.chat,
          messageId,
        });
        if (archived) {
          message = { ...archived, source: 'archive' };
          resolvedFrom = 'archive';
        }
      }

      if (!message && resolvedSource === 'archive') {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const live = await telegramClient.getMessageById(options.chat, messageId);
        if (live) {
          const meta = await resolveLiveMetadata(options.chat);
          message = {
            ...formatLiveMessage(live, { channelId: String(options.chat), ...meta }),
            source: 'live',
          };
          resolvedFrom = 'live';
          usedLiveFallback = true;
        }
      }

      if (!message) {
        throw new Error('Message not found.');
      }

      const payload = { source: resolvedFrom ?? resolvedSource, message };
      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(JSON.stringify(payload, null, 2));
        if (usedLiveFallback) {
          printArchiveFallbackNote([options.chat]);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMessagesContext(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (!options.id) {
      throw new Error('--id is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    const resolveLiveMetadata = createLiveMetadataResolver(messageSyncService, telegramClient);
    try {
      const messageId = parsePositiveInt(options.id, '--id');
      const resolvedSource = resolveSource(options.source);
      const safeBefore = parseNonNegativeInt(options.before, '--before') ?? 20;
      const safeAfter = parseNonNegativeInt(options.after, '--after') ?? 20;
      let context = null;
      let resolvedFrom = null;
      let usedLiveFallback = false;

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const liveContext = await telegramClient.getMessageContext(options.chat, messageId, {
          before: safeBefore,
          after: safeAfter,
        });
        if (liveContext.target) {
          const meta = await resolveLiveMetadata(options.chat);
          context = {
            target: {
              ...formatLiveMessage(liveContext.target, { channelId: String(options.chat), ...meta }),
              source: 'live',
            },
            before: liveContext.before.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(options.chat), ...meta }),
              source: 'live',
            })),
            after: liveContext.after.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(options.chat), ...meta }),
              source: 'live',
            })),
          };
          resolvedFrom = 'live';
        }
      }

      if (!context && (resolvedSource === 'archive' || resolvedSource === 'both')) {
        const archiveContext = messageSyncService.getArchivedMessageContext({
          channelId: options.chat,
          messageId,
          before: safeBefore,
          after: safeAfter,
        });
        if (archiveContext.target) {
          context = {
            target: { ...archiveContext.target, source: 'archive' },
            before: archiveContext.before.map((message) => ({ ...message, source: 'archive' })),
            after: archiveContext.after.map((message) => ({ ...message, source: 'archive' })),
          };
          resolvedFrom = 'archive';
        }
      }

      if (!context && resolvedSource === 'archive') {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const liveContext = await telegramClient.getMessageContext(options.chat, messageId, {
          before: safeBefore,
          after: safeAfter,
        });
        if (liveContext.target) {
          const meta = await resolveLiveMetadata(options.chat);
          context = {
            target: {
              ...formatLiveMessage(liveContext.target, { channelId: String(options.chat), ...meta }),
              source: 'live',
            },
            before: liveContext.before.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(options.chat), ...meta }),
              source: 'live',
            })),
            after: liveContext.after.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(options.chat), ...meta }),
              source: 'live',
            })),
          };
          resolvedFrom = 'live';
          usedLiveFallback = true;
        }
      }

      if (!context) {
        throw new Error('Message not found.');
      }

      const payload = { source: resolvedFrom ?? resolvedSource, ...context };
      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(JSON.stringify(payload, null, 2));
        if (usedLiveFallback) {
          printArchiveFallbackNote([options.chat]);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

function parseSendParseMode(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!SEND_PARSE_MODES.includes(normalized)) {
    throw new Error(`--parse-mode must be one of: ${SEND_PARSE_MODES.join(', ')}`);
  }
  return normalized;
}

function parseScheduleDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) throw new Error('--schedule must be a valid ISO 8601 datetime');
  const now = Date.now();
  if (date.getTime() < now) throw new Error('--schedule must be in the future');
  if (date.getTime() > now + 365 * 24 * 60 * 60 * 1000) throw new Error('--schedule must be within 365 days from now');
  return Math.floor(date.getTime() / 1000);
}

function resolveSendAliases(options) {
  if (!options.to && options.chat) options.to = options.chat;
  if (!options.message && options.text) options.message = options.text;
}

function normalizeSendCommandError(error, { method, retries, attempt = 1 } = {}) {
  if (error instanceof SendCommandError) return error;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError) return error;
  return new SendCommandError(classifySendError(error, { method, retries, attempt }));
}

// Brief progress note on stderr so users/agents see the command is alive while
// the MTProto connection is established. stderr keeps stdout --json output clean.
// Suppressed by the global --quiet flag.
function printSendStatus(message, globalFlags) {
  if (globalFlags?.quiet) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function logSendRetry(details, globalFlags) {
  if (globalFlags.json) {
    process.stderr.write(`${JSON.stringify({ event: 'retry', type: details.type, method: details.method, message: details.message, attempt: details.attempt, retries: details.retries })}\n`);
    return;
  }
  const totalAttempts = (details.retries ?? 0) + 1;
  const codeSuffix = details.code !== undefined && details.code !== null && details.code !== ''
    ? ` (${details.code})` : '';
  process.stderr.write(
    `${details.method} transient ${details.type} error on attempt ${details.attempt}/${totalAttempts}${codeSuffix}; retrying...\n`,
  );
}

function buildSendPhotoSuccessPayload({ method, inputChatId, result, attempts }) {
  return buildSendSuccessPayload({
    method,
    chatId: result?.chatId ?? inputChatId,
    messageId: result?.messageId,
    media: result?.media ?? { type: 'photo' },
    attempts,
    warning: result?.warning,
  });
}

async function runSendText(globalFlags, options = {}) {
  resolveSendAliases(options);
  const timeoutMs = resolveSendTimeoutMs(globalFlags.timeoutMs);
  const method = 'sendText';
  let retries = DEFAULT_SEND_RETRIES;

  try {
    return await runWithTimeout(async () => {
      if (!options.to) throw new Error('--to is required');
      if (!options.message) throw new Error('--message is required');
      const parseMode = parseSendParseMode(options.parseMode);
      retries = parseNonNegativeInt(options.retries, '--retries') ?? DEFAULT_SEND_RETRIES;
      const retryBackoff = parseRetryBackoff(options.retryBackoff);
      const storeDir = resolveStoreDir();
      const release = acquireStoreLock(storeDir);
      printSendStatus('Connecting to Telegram…', globalFlags);
      const { telegramClient, messageSyncService } = createServices({ storeDir });
      try {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const topicId = parsePositiveInt(options.topic, '--topic');
        const replyToMessageId = parsePositiveInt(options.replyTo, '--reply-to');
        const scheduleDate = parseScheduleDate(options.schedule);
        const { result, attempts } = await executeSendWithRetries(
          () => telegramClient.sendTextMessage(options.to, options.message, {
            topicId,
            replyToMessageId,
            parseMode,
            noPreview: options.noPreview,
            silent: options.silent || false,
            noforwards: options.forwards === false,
            scheduleDate,
          }),
          {
            method,
            retries,
            retryBackoff,
            timeoutMs,
            sleep: (ms) => delay(ms),
          },
        );
        const payload = { channelId: options.to, ...result };
        if (attempts > 1) {
          payload.attempts = attempts;
        }
        if (globalFlags.json) {
          writeJson(payload);
        } else {
          console.log(`Message sent (${result.messageId}).`);
        }
      } finally {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
        release();
      }
    }, timeoutMs, undefined, formatSendTimeoutMessage(timeoutMs));
  } catch (error) {
    throw normalizeSendCommandError(error, { method, retries });
  }
}

async function runSendPhoto(globalFlags, options = {}) {
  resolveSendAliases(options);
  const timeoutMs = resolveSendTimeoutMs(globalFlags.timeoutMs);
  const method = 'sendPhoto';
  let retries = DEFAULT_SEND_RETRIES;

  try {
    return await runWithTimeout(async () => {
      if (!options.to) throw new Error('--to is required');
      if (!options.photo) throw new Error('--photo is required');
      const parseMode = parseSendParseMode(options.parseMode);
      if (parseMode && !(typeof options.caption === 'string' && options.caption.trim())) {
        throw new Error('--parse-mode requires --caption for send photo');
      }
      retries = parseNonNegativeInt(options.retries, '--retries') ?? DEFAULT_SEND_RETRIES;
      const retryBackoff = parseRetryBackoff(options.retryBackoff);
      const storeDir = resolveStoreDir();
      const release = acquireStoreLock(storeDir);
      printSendStatus('Connecting to Telegram…', globalFlags);
      const { telegramClient, messageSyncService } = createServices({ storeDir });
      try {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const topicId = parsePositiveInt(options.topic, '--topic');
        const replyToMessageId = parsePositiveInt(options.replyTo, '--reply-to');
        const scheduleDate = parseScheduleDate(options.schedule);
        const sendOptions = {
          caption: options.caption,
          topicId,
          replyToMessageId,
          parseMode,
          silent: options.silent || false,
          noforwards: options.forwards === false,
          captionAbove: options.captionAbove || false,
          spoiler: options.spoiler || false,
          scheduleDate,
        };
        const prepared = await telegramClient.preparePhotoMessage(options.to, options.photo, sendOptions);
        const { result, attempts } = await executeSendWithRetries(
          () => telegramClient.sendPreparedPhotoMessage(prepared),
          {
            method,
            retries,
            retryBackoff,
            timeoutMs,
            sleep: (ms) => delay(ms),
            onRetry: (details) => logSendRetry(details, globalFlags),
          },
        );
        if (globalFlags.json) {
          writeJson(buildSendPhotoSuccessPayload({ method, inputChatId: options.to, result, attempts }));
        } else {
          console.log(`Photo sent (${result.messageId}).`);
        }
      } finally {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
        release();
      }
    }, timeoutMs, undefined, formatSendTimeoutMessage(timeoutMs));
  } catch (error) {
    throw normalizeSendCommandError(error, { method, retries });
  }
}

async function runSendFile(globalFlags, options = {}) {
  resolveSendAliases(options);
  const timeoutMs = resolveSendTimeoutMs(globalFlags.timeoutMs);
  const method = 'sendFile';
  let retries = DEFAULT_SEND_RETRIES;

  try {
    return await runWithTimeout(async () => {
      if (!options.to) throw new Error('--to is required');
      if (!options.file) throw new Error('--file is required');
      const parseMode = parseSendParseMode(options.parseMode);
      if (parseMode && !(typeof options.caption === 'string' && options.caption.trim())) {
        throw new Error('--parse-mode requires --caption for send file');
      }
      retries = parseNonNegativeInt(options.retries, '--retries') ?? DEFAULT_SEND_RETRIES;
      const retryBackoff = parseRetryBackoff(options.retryBackoff);
      const storeDir = resolveStoreDir();
      const release = acquireStoreLock(storeDir);
      printSendStatus('Connecting to Telegram…', globalFlags);
      const { telegramClient, messageSyncService } = createServices({ storeDir });
      try {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const topicId = parsePositiveInt(options.topic, '--topic');
        const replyToMessageId = parsePositiveInt(options.replyTo, '--reply-to');
        const scheduleDate = parseScheduleDate(options.schedule);
        const { result, attempts } = await executeSendWithRetries(
          () => telegramClient.sendFileMessage(options.to, options.file, {
            caption: options.caption,
            filename: options.filename,
            topicId,
            replyToMessageId,
            parseMode,
            silent: options.silent || false,
            noforwards: options.forwards === false,
            captionAbove: options.captionAbove || false,
            spoiler: options.spoiler || false,
            scheduleDate,
            forceDocument: options.forceDocument || false,
          }),
          {
            method,
            retries,
            retryBackoff,
            timeoutMs,
            sleep: (ms) => delay(ms),
          },
        );
        const payload = { channelId: options.to, ...result };
        if (attempts > 1) {
          payload.attempts = attempts;
        }
        if (globalFlags.json) {
          writeJson(payload);
        } else {
          console.log(`File sent (${result.messageId}).`);
        }
      } finally {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
        release();
      }
    }, timeoutMs, undefined, formatSendTimeoutMessage(timeoutMs));
  } catch (error) {
    throw normalizeSendCommandError(error, { method, retries });
  }
}

async function runMediaDownload(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (!options.id) {
      throw new Error('--id is required');
    }
    const messageId = parsePositiveInt(options.id, '--id');

    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const result = await telegramClient.downloadMessageMedia(options.chat, messageId, {
        outputPath: options.output,
      });

      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Downloaded to ${result.path} (${result.bytes} bytes).`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTopicsList(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
      const topics = await telegramClient.listForumTopics(options.chat, { limit });
      messageSyncService.upsertTopics(options.chat, topics);

      if (globalFlags.json) {
        writeJson({ total: topics.total ?? topics.length, topics });
      } else {
        for (const topic of topics) {
          console.log(`#${topic.id} ${topic.title ?? ''}`.trim());
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTopicsSearch(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (!options.query) {
      throw new Error('--query is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
      const topics = await telegramClient.listForumTopics(options.chat, {
        query: options.query,
        limit,
      });
      messageSyncService.upsertTopics(options.chat, topics);

      if (globalFlags.json) {
        writeJson({ total: topics.total ?? topics.length, topics });
      } else {
        for (const topic of topics) {
          console.log(`#${topic.id} ${topic.title ?? ''}`.trim());
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTagsSet(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const hasTagFlag = options.tags !== undefined || options.tag !== undefined;
    const tagValues = [
      ...parseListValues(options.tags),
      ...parseListValues(options.tag),
    ];
    if (!hasTagFlag) {
      throw new Error('--tags or --tag is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const finalTags = messageSyncService.setChannelTags(options.chat, tagValues, {
        source: options.source,
      });
      if (globalFlags.json) {
        writeJson({ channelId: options.chat, tags: finalTags });
      } else {
        console.log(`Tags set for ${options.chat}: ${finalTags.join(', ')}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTagsList(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const tags = messageSyncService.listChannelTags(options.chat, { source: options.source });
      if (globalFlags.json) {
        writeJson(tags);
      } else {
        console.log(tags.map((tag) => tag.tag).join(', '));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTagsSearch(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.tag) {
      throw new Error('--tag is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
      const channels = messageSyncService.listTaggedChannels(options.tag, {
        source: options.source,
        limit,
      });
      if (globalFlags.json) {
        writeJson(channels);
      } else {
        for (const channel of channels) {
          const label = channel.peerTitle || channel.username || channel.channelId;
          console.log(`${label} (${channel.channelId})`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTagsAuto(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const channelIds = parseListValues(options.chat);
      const limit = parsePositiveInt(options.limit, '--limit') ?? 50;
      const results = await messageSyncService.autoTagChannels({
        channelIds: channelIds.length ? channelIds : null,
        limit,
        source: options.source,
        refreshMetadata: options.refreshMetadata !== false,
      });
      if (globalFlags.json) {
        writeJson(results);
      } else {
        for (const entry of results) {
          console.log(`${entry.channelId}: ${entry.tags.map((tag) => tag.tag).join(', ')}`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMetadataGet(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      let metadata = messageSyncService.getChannelMetadata(options.chat);
      if (!metadata) {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const live = await telegramClient.getPeerMetadata(options.chat);
        metadata = {
          channelId: String(options.chat),
          peerTitle: live?.peerTitle ?? null,
          peerType: live?.peerType ?? null,
          chatType: live?.chatType ?? null,
          isForum: live?.isForum ?? null,
          username: live?.username ?? null,
          about: live?.about ?? null,
          metadataUpdatedAt: null,
          source: 'live',
        };
      }
      if (globalFlags.json) {
        writeJson(metadata);
      } else {
        console.log(JSON.stringify(metadata, null, 2));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMetadataRefresh(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const channelIds = parseListValues(options.chat);
      const limit = parsePositiveInt(options.limit, '--limit') ?? 20;
      const results = await messageSyncService.refreshChannelMetadata({
        channelIds: channelIds.length ? channelIds : null,
        limit,
        force: Boolean(options.force),
        onlyMissing: Boolean(options.onlyMissing),
      });
      if (globalFlags.json) {
        writeJson(results);
      } else {
        console.log(JSON.stringify(results, null, 2));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsSearch(globalFlags, queryParts, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const query = (queryParts || []).join(' ').trim();
    if (!query) {
      throw new Error('search requires a query');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      await messageSyncService.refreshContacts();
      const contacts = messageSyncService.searchContacts(query, {
        limit: parsePositiveInt(options.limit, '--limit') ?? 50,
      });

      if (globalFlags.json) {
        writeJson(contacts);
      } else {
        for (const contact of contacts) {
          const label = contact.alias || contact.displayName || contact.username || contact.userId;
          console.log(`${label} (${contact.userId})`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsShow(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.user) {
      throw new Error('--user is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      let contact = messageSyncService.getContact(options.user);
      if (!contact) {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        await messageSyncService.refreshContacts();
        contact = messageSyncService.getContact(options.user);
      }
      if (!contact) {
        throw new Error('Contact not found.');
      }

      if (globalFlags.json) {
        writeJson(contact);
      } else {
        console.log(JSON.stringify(contact, null, 2));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsAliasSet(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.user) {
      throw new Error('--user is required');
    }
    if (!options.alias) {
      throw new Error('--alias is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      const alias = messageSyncService.setContactAlias(options.user, options.alias);
      if (globalFlags.json) {
        writeJson({ userId: options.user, alias });
      } else {
        console.log(`Alias set for ${options.user}: ${alias}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsAliasRm(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.user) {
      throw new Error('--user is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      messageSyncService.removeContactAlias(options.user);
      if (globalFlags.json) {
        writeJson({ userId: options.user, removed: true });
      } else {
        console.log(`Alias removed for ${options.user}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsTagsAdd(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.user) {
      throw new Error('--user is required');
    }
    const tags = parseListValues(options.tag);
    if (!tags.length) {
      throw new Error('--tag is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      const updated = messageSyncService.addContactTags(options.user, tags);
      if (globalFlags.json) {
        writeJson({ userId: options.user, tags: updated });
      } else {
        console.log(`Tags updated for ${options.user}: ${updated.join(', ')}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsTagsRm(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.user) {
      throw new Error('--user is required');
    }
    const tags = parseListValues(options.tag);
    if (!tags.length) {
      throw new Error('--tag is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      const updated = messageSyncService.removeContactTags(options.user, tags);
      if (globalFlags.json) {
        writeJson({ userId: options.user, tags: updated });
      } else {
        console.log(`Tags updated for ${options.user}: ${updated.join(', ')}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContactsNotesSet(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.user) {
      throw new Error('--user is required');
    }
    if (options.notes === undefined) {
      throw new Error('--notes is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      const notes = messageSyncService.setContactNotes(options.user, options.notes);
      if (globalFlags.json) {
        writeJson({ userId: options.user, notes });
      } else {
        console.log(`Notes updated for ${options.user}.`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupsList(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const groups = await telegramClient.listGroups({
        query: options.query,
        limit: parsePositiveInt(options.limit, '--limit') ?? 100,
      });

      if (globalFlags.json) {
        writeJson(groups);
      } else {
        for (const group of groups) {
          console.log(`${group.title} (${group.id})`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupsInfo(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const info = await telegramClient.getGroupInfo(options.chat);
      if (globalFlags.json) {
        writeJson(info);
      } else {
        console.log(JSON.stringify(info, null, 2));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupsRename(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    if (!options.name) {
      throw new Error('--name is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      await telegramClient.renameGroup(options.chat, options.name);
      if (globalFlags.json) {
        writeJson({ channelId: options.chat, name: options.name });
      } else {
        console.log(`Group renamed: ${options.name}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupMembersAdd(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const users = parseListValues(options.user);
    if (!users.length) {
      throw new Error('--user is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const failed = await telegramClient.addGroupMembers(options.chat, users);
      if (globalFlags.json) {
        writeJson({ channelId: options.chat, failed });
      } else if (failed.length) {
        console.log(`Some members failed: ${JSON.stringify(failed, null, 2)}`);
      } else {
        console.log('Members added.');
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupMembersRemove(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const users = parseListValues(options.user);
    if (!users.length) {
      throw new Error('--user is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const result = await telegramClient.removeGroupMembers(options.chat, users);
      if (globalFlags.json) {
        writeJson({ channelId: options.chat, ...result });
      } else {
        console.log(`Removed: ${result.removed.join(', ')}`);
        if (result.failed.length) {
          console.log(`Failed: ${JSON.stringify(result.failed, null, 2)}`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupInviteLinkGet(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const link = await telegramClient.getGroupInviteLink(options.chat);
      if (globalFlags.json) {
        writeJson({ link: link.link });
      } else {
        console.log(link.link);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupInviteLinkRevoke(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const existing = await telegramClient.getGroupInviteLink(options.chat);
      const link = await telegramClient.revokeGroupInviteLink(options.chat, existing);
      if (globalFlags.json) {
        writeJson({ link: link.link });
      } else {
        console.log(link.link);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupsJoin(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.code) {
      throw new Error('--code is required');
    }
    const invite = normalizeInviteCode(options.code);
    if (!invite) {
      throw new Error('Invalid invite code.');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      const chat = await telegramClient.joinGroup(invite);
      if (globalFlags.json) {
        writeJson({
          id: chat.id?.toString?.() ?? null,
          title: chat.displayName || chat.title || 'Unknown',
          username: chat.username ?? null,
        });
      } else {
        console.log(`Joined: ${chat.displayName || chat.title || 'Unknown'}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroupsLeave(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }
      await telegramClient.leaveGroup(options.chat);
      if (globalFlags.json) {
        writeJson({ channelId: options.chat, left: true });
      } else {
        console.log(`Left ${options.chat}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

// --- Folders handlers ---

async function runFoldersList(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const folders = await telegramClient.getFolders();
      if (globalFlags.json) {
        writeJson(folders);
      } else {
        for (const f of folders) {
          console.log(`${f.title} (id=${f.id}, type=${f.type})`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersShow(globalFlags, folder, opts = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const info = await telegramClient.showFolder(folder, { resolve: opts.resolve });
      if (globalFlags.json) {
        writeJson(info);
      } else {
        console.log(`${info.title} (id=${info.id}, type=${info.type})`);
        if (info.emoji) console.log(`  emoji: ${info.emoji}`);
        const flags = ['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots'].filter((f) => info[f]);
        if (flags.length) console.log(`  includes: ${flags.join(', ')}`);
        const excludes = ['excludeMuted', 'excludeRead', 'excludeArchived'].filter((f) => info[f]);
        if (excludes.length) console.log(`  excludes: ${excludes.join(', ')}`);

        if (opts.resolve) {
          const printResolvedPeers = (peers, label) => {
            if (!peers?.length) return;
            if (label) console.log(`  ${label}:`);
            const indent = label ? '    ' : '  ';
            const grouped = {};
            for (const p of peers) {
              const group = p.type + 's';
              if (!grouped[group]) grouped[group] = [];
              const displayName = p.name ?? p.title ?? '(unresolved)';
              grouped[group].push(`${displayName} (${p.id})`);
            }
            for (const [group, items] of Object.entries(grouped)) {
              console.log(`${indent}${group}:`);
              for (const item of items) console.log(`${indent}  - ${item}`);
            }
          };
          printResolvedPeers(info.includePeers);
          printResolvedPeers(info.excludePeers, 'excluded');
          printResolvedPeers(info.pinnedPeers, 'pinned');
        } else {
          const printPeers = (peers, label) => {
            if (!peers?.length) {
              console.log(`  ${label}: (none)`);
              return;
            }
            console.log(`  ${label}:`);
            for (const p of peers) console.log(`    - ${p.type}:${p.id}`);
          };
          printPeers(info.includePeers, 'includePeers');
          printPeers(info.excludePeers, 'excludePeers');
          printPeers(info.pinnedPeers, 'pinnedPeers');
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersCreate(globalFlags, options) {
  if (!options.title || options.title.length > 12) throw new Error('Folder title must be 1-12 characters');
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.createFolder({
        title: options.title,
        emoji: options.emoji,
        contacts: options.includeContacts,
        nonContacts: options.includeNonContacts,
        groups: options.includeGroups,
        broadcasts: options.includeChannels,
        bots: options.includeBots,
        excludeMuted: options.excludeMuted,
        excludeRead: options.excludeRead,
        excludeArchived: options.excludeArchived,
        includePeers: options.chat?.length ? options.chat : undefined,
        excludePeers: options.excludeChat?.length ? options.excludeChat : undefined,
        pinnedPeers: options.pinChat?.length ? options.pinChat : undefined,
      });
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Created folder: ${result.title} (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersEdit(globalFlags, folder, options) {
  if (options.title !== undefined && (options.title.length === 0 || options.title.length > 12)) throw new Error('Folder title must be 1-12 characters');
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const modification = {};
      if (options.title !== undefined) modification.title = options.title;
      if (options.emoji !== undefined) modification.emoji = options.emoji;
      if (options.includeContacts !== undefined) modification.contacts = options.includeContacts;
      if (options.includeNonContacts !== undefined) modification.nonContacts = options.includeNonContacts;
      if (options.includeGroups !== undefined) modification.groups = options.includeGroups;
      if (options.includeChannels !== undefined) modification.broadcasts = options.includeChannels;
      if (options.includeBots !== undefined) modification.bots = options.includeBots;
      if (options.excludeMuted !== undefined) modification.excludeMuted = options.excludeMuted;
      if (options.excludeRead !== undefined) modification.excludeRead = options.excludeRead;
      if (options.excludeArchived !== undefined) modification.excludeArchived = options.excludeArchived;
      if (options.chat?.length) modification.includePeers = options.chat;
      if (options.excludeChat?.length) modification.excludePeers = options.excludeChat;
      if (options.pinChat?.length) modification.pinnedPeers = options.pinChat;
      const result = await telegramClient.editFolder(folder, modification);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Updated folder: ${result.title} (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersDelete(globalFlags, folder) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.deleteFolder(folder);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Deleted folder id=${result.id}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersReorder(globalFlags, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const ids = options.ids.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
      const result = await telegramClient.setFoldersOrder(ids);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log('Folders reordered');
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersChatsAdd(globalFlags, folder, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) throw new Error('--chat is required');
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.addChatToFolder(folder, options.chat);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Chat added to folder id=${result.folderId}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersChatsRemove(globalFlags, folder, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) throw new Error('--chat is required');
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.removeChatFromFolder(folder, options.chat);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Chat removed from folder id=${result.folderId}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersJoin(globalFlags, link) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.joinChatlist(link);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Joined folder: ${result.title} (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

function isCliEntrypoint(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return pathToFileURL(fs.realpathSync(argvPath)).href === import.meta.url;
  } catch (error) {
    return pathToFileURL(path.resolve(argvPath)).href === import.meta.url;
  }
}

function shouldRunMain(entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return fs.realpathSync(entryPath) === CLI_PATH;
  } catch (error) {
    return path.resolve(entryPath) === CLI_PATH;
  }
}

async function main() {
  await CLI_PROGRAM.parseAsync(process.argv);
}

export {
  buildProgram,
  buildSendPhotoSuccessPayload,
  DEFAULT_SEND_TIMEOUT_MS,
  formatFeedbackMessage,
  formatSendTimeoutMessage,
  getFeedbackCooldownRemainingSeconds,
  isCliEntrypoint,
  logSendRetry,
  main,
  normalizeSendCommandError,
  parseNonNegativeInt,
  resolveSendTimeoutMs,
  runFeedback,
  shouldRunMain,
  writeError,
  writeFeedbackLastSentAt,
};

if (isCliEntrypoint()) {
  await main();
}
