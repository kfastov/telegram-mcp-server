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
import { createServices, createTelegramClient } from './core/services.js';
import { withCommand, runWithTimeout, runOperation } from './core/command-context.js';
import {
  buildSendErrorPayload,
  buildSendSuccessPayload,
  classifySendError,
  formatSendErrorMessage,
  parseRetryBackoff,
  SendCommandError,
} from './core/send-utils.js';
import { resolveStoreDir } from './core/store.js';
import { parseDuration } from './core/duration.js';
import { PEER_SIGN_RETRY_PATTERN } from './core/peer-hints.js';
import {
  cancelBackfill,
  enqueueBackfill,
  ensureServer,
  pingServer,
  retryBackfill,
} from './core/control-client.js';

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

  // A bare negative chat id (`--chat -100123` works, but a stray `-100123`
  // parses as a flag) trips commander's unknown-option error; append the exact
  // workaround. Subcommands share this output configuration by reference, so
  // one root-level hook covers the whole command tree.
  program.configureOutput({
    outputError: (str, write) => {
      write(str);
      const match = /unknown option '(-\d+)'/.exec(str);
      if (match) {
        write(`${negativeChatIdWorkaround(match[1])}\n`);
      }
    },
  });

  const auth = program.command('auth').description('Authentication and session setup');
  auth
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
    // `--chat` enqueues a single-chat backfill on the always-on server
    // (auto-starting it) and follows progress.
    .option('--chat <id|username>', 'Backfill a single chat via the control server')
    .option('--depth <n>', 'Maximum messages to backfill (with --chat)')
    .option('--min-date <iso>', 'Earliest date to backfill (with --chat)')
    .option('--background', 'Enqueue and return immediately (with --chat)')
    // Without --chat: drain the server's queue. --follow tracks progress to the
    // foreground; --once is a deprecated alias of `backfill wait`.
    .option('--follow', 'Track the backfill queue until it drains, then exit')
    .addOption(new Option('--once', 'Deprecated alias of `backfill wait`').hideHelp())
    .action(withGlobalOptions((globalFlags, options) => runBackfill(globalFlags, options)));
  sync
    .command('status')
    .description('Show backfill progress and server status')
    .action(withGlobalOptions((globalFlags) => runSyncStatus(globalFlags)));
  sync
    .command('count')
    .description('Print the number of in-progress backfills')
    .action(withGlobalOptions((globalFlags) => runBackfillCount(globalFlags)));
  sync
    .command('wait')
    .description('Start the server if needed and wait for backfills to drain')
    .action(withGlobalOptions((globalFlags) => runBackfillWait(globalFlags)));
  sync
    .command('cancel')
    .description('Cancel backfills for a chat')
    .option('--chat <id|username>', 'Channel identifier')
    // --chat is also declared on the parent `backfill`; commander binds the
    // duplicated flag to the parent, so merge via optsWithGlobals (and validate
    // presence inside the handler rather than with requiredOption).
    .action(withGlobalOptions((globalFlags, options, command) =>
      runBackfillCancel(globalFlags, command.optsWithGlobals()),
    ));
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
    // optsWithGlobals merges in the parent `backfill` options. The parent now
    // declares --chat/--depth/--min-date too (for `backfill --chat`), and
    // commander binds those duplicated flags to the parent scope; merging here
    // keeps `backfill jobs add --chat X` working.
    .action(withGlobalOptions((globalFlags, options, command) =>
      runSyncJobsAdd(globalFlags, command.optsWithGlobals()),
    ));
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

// The exact flag-quoting workaround for a negative chat id. Shared by the
// parser's unknown-option hook and writeError so both surfaces phrase it the
// same way.
function negativeChatIdWorkaround(id) {
  return `Negative chat ids must be quoted or attached with '=': --chat="${id}" or --chat=${id}`;
}

// The client layer suggests retrying with the negative id in frontend-neutral
// wording; restate it in this CLI's flag syntax, including the quoting trap a
// bare negative value falls into.
function writeSignRetryHint(message) {
  const signRetry = PEER_SIGN_RETRY_PATTERN.exec(message ?? '');
  if (signRetry) {
    process.stderr.write(`${negativeChatIdWorkaround(signRetry[1])}\n`);
  }
}

function writeError(error, asJson) {
  if (error instanceof SendCommandError) {
    if (asJson) {
      process.stderr.write(`${JSON.stringify(buildSendErrorPayload(error.details), null, 2)}\n`);
    } else {
      // Send failures carry the underlying message in details; a failed peer
      // resolution surfaces its sign-retry suggestion through there.
      process.stderr.write(`${formatSendErrorMessage(error.details)}\n`);
      writeSignRetryHint(error.details?.message);
    }
    return;
  }
  const message = error?.message ?? String(error);
  if (asJson) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    return;
  }
  process.stderr.write(`${message}\n`);
  writeSignRetryHint(message);
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
      await messageSyncService.close();
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
      await messageSyncService.close();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

// Interactive login + session bootstrap only: write the session and exit. Archive
// sync and the queue run in the always-on server, which auto-starts on the next
// command that needs it (or via `tgcli server`).
export async function runAuthLogin(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  let release = null;
  let telegramClient = null;
  const cleanup = async () => {
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
        disableUpdates: true,
      }));
      const loginSuccess = await telegramClient.login();
      if (!loginSuccess) {
        throw new Error('Failed to login to Telegram.');
      }

      if (globalFlags.json) {
        writeJson({ authenticated: true });
      } else {
        console.log(`Authenticated. ${AUTH_SYNC_HINT}`);
      }
    } finally {
      await cleanup();
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
        await messageSyncService.close();
      }
      if (telegramClient) {
        await telegramClient.destroy();
      }
      release();
    }
  }, timeoutMs);
}

// A backfill job is terminal once the worker stops touching it: `idle` means the
// backfill reached its target/exhausted history; `error` means it failed.
const TERMINAL_JOB_STATUSES = new Set(['idle', 'error']);

// Briefly take a read lock, read job state, then release — never held across a
// poll loop. Holding it for the whole wait would block CLI writers like `send`,
// which need the write lock. Returns whatever the reader produces.
//
// We deliberately close the DB handle directly rather than calling
// service.shutdown(): shutdown() rewrites in_progress jobs back to pending, which
// would corrupt the job state owned by the running server we are merely observing.
function withReadSnapshot(storeDir, reader) {
  const release = acquireReadLock(storeDir);
  let service;
  let telegramClient;
  try {
    ({ telegramClient, messageSyncService: service } = createServices({ storeDir }));
    return reader(service);
  } finally {
    if (service?.db?.open) {
      service.db.close();
    }
    if (telegramClient) {
      void telegramClient.destroy?.();
    }
    release();
  }
}

function jobProgressLine(job) {
  const label = job.peer_title || job.channel_id;
  const done = job.message_count ?? 0;
  const target = job.target_message_count ?? 0;
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  return `Backfilling ${label}: ${done}/${target} (${pct}%)`;
}

function writeProgress(globalFlags, line) {
  if (!globalFlags.quiet) {
    process.stderr.write(`${line}\n`);
  }
}

// With `--chat`, enqueue a single-chat backfill on the always-on control server
// (auto-starting it) and either return the job id (`--background`) or follow
// progress in the foreground. Without `--chat`, delegate to the queue-draining
// path (`--follow`/`--once`/bare usage).
async function runBackfill(globalFlags, options = {}) {
  if (!options.chat) {
    return runSync(globalFlags, options);
  }

  // Long-running command: do NOT apply the send default timeout. A user-supplied
  // --timeout is still honored via runWithTimeout below.
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const depth = parsePositiveInt(options.depth, '--depth');
    const minDate = options.minDate ?? null;

    await ensureServer(storeDir, { idleExit: '60s' });
    const enqueued = await enqueueBackfill(storeDir, {
      chatId: options.chat,
      depth,
      minDate,
    });
    const channelId = enqueued?.channelId ?? null;
    const jobId = enqueued?.jobId ?? null;

    if (options.background) {
      if (globalFlags.json) {
        writeJson({ jobId, channelId, status: enqueued?.status ?? null });
      } else {
        console.log(`Queued backfill for ${channelId} (job #${jobId}).`);
      }
      return;
    }

    // Ctrl-C detaches instead of cancelling: the server keeps draining the queue.
    let detached = false;
    const onSigint = () => {
      detached = true;
      writeProgress(globalFlags, 'Still running in the background — check `tgcli backfill status`');
      process.exit(0);
    };
    process.on('SIGINT', onSigint);

    try {
      let job = null;
      while (!detached) {
        job = withReadSnapshot(storeDir, (service) => {
          const jobs = service.listJobs({ channelId, limit: 1 });
          return jobs[0] ?? null;
        });
        if (!job) {
          // Job already gone (cancelled or never persisted) — nothing to follow.
          break;
        }
        writeProgress(globalFlags, jobProgressLine(job));
        if (TERMINAL_JOB_STATUSES.has(job.status)) {
          break;
        }
        await delay(1000);
      }

      if (detached) {
        return;
      }

      if (job && job.status === 'error') {
        if (globalFlags.json) {
          writeJson({ ok: false, jobId: job.id, channelId, status: job.status, error: job.error ?? null });
        } else {
          console.error(`Backfill failed for ${channelId}: ${job.error ?? 'unknown error'}`);
        }
        process.exitCode = 1;
        return;
      }

      if (globalFlags.json) {
        writeJson({
          ok: true,
          jobId: job?.id ?? jobId,
          channelId,
          status: job?.status ?? null,
          messageCount: job?.message_count ?? 0,
          targetMessageCount: job?.target_message_count ?? 0,
        });
      } else if (job) {
        console.log(`Backfill complete for ${channelId}: ${job.message_count ?? 0} message(s) archived.`);
      } else {
        console.log(`Backfill for ${channelId} is no longer queued.`);
      }
    } finally {
      process.off('SIGINT', onSigint);
    }
  }, globalFlags.timeoutMs);
}

// Snapshot of in-progress + pending backfills plus whether the server is up.
async function runBackfillCount(globalFlags) {
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const count = withReadSnapshot(storeDir, (service) => service.getJobCounts().inProgress);
    if (globalFlags.json) {
      writeJson({ inProgress: count });
    } else {
      console.log(String(count));
    }
  }, globalFlags.timeoutMs);
}

// Start the server if needed (so the queue actually drains) and poll under brief
// read snapshots until no pending/in-progress backfills remain, writing per-chat
// progress to stderr along the way. The server keeps running on its own (realtime
// continues while it is up / has watched chats); this only tracks the queue.
async function drainBackfillQueue(globalFlags, storeDir) {
  await ensureServer(storeDir, { idleExit: '60s' });
  while (true) {
    const { active, jobs } = withReadSnapshot(storeDir, (service) => {
      const counts = service.getJobCounts();
      const inFlight = service.listJobs({ status: 'in_progress', limit: 50 });
      return { active: counts.pending + counts.inProgress, jobs: inFlight };
    });
    for (const job of jobs) {
      writeProgress(globalFlags, jobProgressLine(job));
    }
    if (active === 0) {
      break;
    }
    await delay(1000);
  }
}

// `backfill wait`: start the server if needed and track the queue to completion.
async function runBackfillWait(globalFlags) {
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    await drainBackfillQueue(globalFlags, storeDir);
    if (globalFlags.json) {
      writeJson({ ok: true, drained: true });
    } else if (!globalFlags.quiet) {
      console.log('Backfill queue drained.');
    }
  }, globalFlags.timeoutMs);
}

// Cancel backfills for a chat. Prefer the control server (so an in-flight job is
// stopped by the worker); fall back to a direct DB delete when no server is up.
async function runBackfillCancel(globalFlags, options = {}) {
  return runWithTimeout(async () => {
    if (!options.chat) {
      throw new Error('--chat is required');
    }
    const storeDir = resolveStoreDir();
    const ping = await pingServer(storeDir);
    let result;
    if (ping) {
      result = await cancelBackfill(storeDir, { chatId: options.chat });
    } else {
      // No server running: same direct path as `backfill jobs cancel --channel`.
      const release = acquireStoreLock(storeDir);
      const { telegramClient, messageSyncService } = createServices({ storeDir });
      try {
        result = messageSyncService.cancelJobs({ channelId: options.chat });
      } finally {
        await messageSyncService.close();
        await telegramClient.destroy();
        release();
      }
    }
    if (globalFlags.json) {
      writeJson(result);
    } else {
      console.log(`Canceled ${result.canceled} job(s).`);
    }
  }, globalFlags.timeoutMs);
}

// Bare `backfill`/`sync` (no --chat). Archiving runs in the always-on server; this
// only tracks its queue. `--follow` and `--once` both drain the queue and exit —
// they never run a worker or hold the store write lock. With no flag, there is
// nothing to track, so show usage.
async function runSync(globalFlags, options = {}) {
  if (!options.follow && !options.once) {
    const backfill = CLI_PROGRAM.commands.find((command) => command.name() === 'backfill');
    if (backfill) {
      process.stderr.write(backfill.helpInformation());
    }
    return;
  }
  // `--once` is a deprecated alias of `backfill wait`: drain quietly and exit.
  return runBackfillWait(globalFlags);
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
    // Snapshot the queue + active backfills under a brief read lock so a running
    // server keeps its write lock free.
    const { queue, jobs } = withReadSnapshot(storeDir, (service) => ({
      queue: service.getQueueStats(),
      jobs: service.listJobs({ limit: 100 }),
    }));
    // in_progress first, then pending — the chats actively/imminently backfilling.
    const active = jobs.filter((job) => job.status === 'in_progress' || job.status === 'pending');
    const ping = await pingServer(storeDir);

    if (globalFlags.json) {
      writeJson({
        server: ping ? { up: true, pid: ping.pid, version: ping.version, startedAt: ping.startedAt } : { up: false },
        queue,
        backfills: active.map((job) => ({
          jobId: job.id,
          channelId: job.channel_id,
          title: job.peer_title ?? null,
          status: job.status,
          messageCount: job.message_count ?? 0,
          targetMessageCount: job.target_message_count ?? 0,
          cursorDate: job.cursor_message_date ?? null,
          updatedAt: job.updated_at ?? null,
        })),
      });
      return;
    }

    console.log(`QUEUE: pending=${queue.pending} in_progress=${queue.in_progress} idle=${queue.idle} error=${queue.error}`);
    console.log(`SERVER: ${ping ? `up (pid ${ping.pid})` : 'down'}`);
    if (active.length === 0) {
      console.log('No active backfills.');
    } else {
      for (const job of active) {
        const label = job.peer_title || job.channel_id;
        const done = job.message_count ?? 0;
        const target = job.target_message_count ?? 0;
        const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
        const cursor = job.cursor_message_date ? ` cursor=${job.cursor_message_date}` : '';
        const updated = job.updated_at ? ` updated=${job.updated_at}` : '';
        console.log(`  ${label} [${job.status}] ${done}/${target} (${pct}%)${cursor}${updated}`);
      }
    }
  }, timeoutMs);
}

async function runSyncJobsList(globalFlags, options = {}) {
  const status = options.status ? String(options.status) : null;
  if (status && !['pending', 'in_progress', 'idle', 'error'].includes(status)) {
    throw new Error(`Unknown status: ${status}`);
  }
  const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
  return withCommand(globalFlags, { need: 'archive', lock: null }, async ({ messageSyncService }) => {
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
  });
}

// Enqueue a job on the always-on server (auto-starting it); the server's queue
// processes it. Returns immediately after enqueue.
async function runSyncJobsAdd(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const depth = parsePositiveInt(options.depth, '--depth');
    await ensureServer(storeDir, { idleExit: '60s' });
    const job = await enqueueBackfill(storeDir, {
      chatId: options.chat,
      depth,
      minDate: options.minDate ?? null,
    });
    if (globalFlags.json) {
      writeJson(job);
    } else {
      console.log(`Job scheduled for ${job.channelId} (#${job.jobId}).`);
    }
  }, globalFlags.timeoutMs);
}

// Reset errored job(s) to pending on the always-on server (auto-starting it); the
// server's queue reprocesses them.
async function runSyncJobsRetry(globalFlags, options = {}) {
  const jobId = parsePositiveInt(options.jobId, '--job-id');
  const channelId = options.channel ?? null;
  const allErrors = Boolean(options.allErrors);
  if (!jobId && !channelId && !allErrors) {
    throw new Error('--job-id, --channel, or --all-errors is required');
  }
  if (allErrors && (jobId || channelId)) {
    throw new Error('Use --all-errors without --job-id/--channel');
  }
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    await ensureServer(storeDir, { idleExit: '60s' });
    const result = await retryBackfill(storeDir, { jobId, channelId, allErrors });
    if (globalFlags.json) {
      writeJson(result);
    } else {
      console.log(`Re-queued ${result.updated} job(s).`);
    }
  }, globalFlags.timeoutMs);
}

async function runSyncJobsCancel(globalFlags, options = {}) {
  const jobId = parsePositiveInt(options.jobId, '--job-id');
  const channelId = options.channel ?? null;
  if (!jobId && !channelId) {
    throw new Error('--job-id or --channel is required');
  }
  if (jobId && channelId) {
    throw new Error('Use --job-id or --channel, not both');
  }
  return withCommand(globalFlags, { need: 'archive', lock: 'write' }, async ({ messageSyncService }) => {
    const result = messageSyncService.cancelJobs({
      jobId,
      channelId,
    });
    if (globalFlags.json) {
      writeJson(result);
    } else {
      console.log(`Canceled ${result.canceled} job(s).`);
    }
  });
}

async function runDoctor(globalFlags, options = {}) {
  return withCommand(globalFlags, { need: 'full', lock: null }, async ({ storeDir, telegramClient, messageSyncService }) => {
    const lock = readStoreLock(storeDir);
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
  });
}

async function runChannelsList(globalFlags, options = {}) {
  const limit = parsePositiveInt(options.limit, '--limit') ?? 50;
  const dialogs = await runOperation(globalFlags, {
    op: 'listChannels',
    args: { query: options.query, limit },
  });

  if (globalFlags.json) {
    writeJson(dialogs);
  } else {
    for (const dialog of dialogs) {
      const label = dialog.title || dialog.username || dialog.id;
      console.log(`${label} (${dialog.id})`);
    }
  }
}

async function runChannelsShow(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const channel = await runOperation(globalFlags, {
    op: 'channelShow',
    args: { chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson(channel);
  } else {
    console.log(JSON.stringify(channel, null, 2));
  }
}

async function runChannelsSync(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  if (options.enable && options.disable) {
    throw new Error('Use either --enable or --disable');
  }
  if (!options.enable && !options.disable) {
    throw new Error('--enable or --disable is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'channelSetSync',
    args: { chat: options.chat, enable: Boolean(options.enable) },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else if (result.syncEnabled) {
    const jobMessage = result.jobId
      ? result.jobQueued
        ? ` Backfill job queued (#${result.jobId}).`
        : ` Backfill job exists (#${result.jobId}, ${result.jobStatus}).`
      : '';
    console.log(
      `Sync enabled for ${result.channelId}.${jobMessage} ` +
        'Run `tgcli backfill --once` (or `tgcli backfill --follow`/`tgcli server`) to process.',
    );
  } else {
    console.log(`Sync disabled for ${result.channelId}`);
  }
}

async function runChannelsMarkRead(globalFlags, options = {}) {
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
  const result = await runOperation(globalFlags, {
    op: 'channelMarkRead',
    args: { chat: options.chat, messageId },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Marked channel ${result.channelId} as read up to message ${result.messageId}.`);
  }
}

function renderMessageGroups(messages, outputSource) {
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
}

async function runMessagesList(globalFlags, options = {}) {
  const channelIds = parseListValues(options.chat);
  const topicId = parsePositiveInt(options.topic, '--topic');
  const finalLimit = parsePositiveInt(options.limit, '--limit') ?? 50;
  const { beforeId, afterId } = parseMessageIdWindow(options, { allowOffsetAlias: true });
  const result = await runOperation(globalFlags, {
    op: 'messagesList',
    args: {
      channelIds: channelIds.length ? channelIds : null,
      topicId,
      source: options.source,
      fromDate: options.after,
      toDate: options.before,
      beforeId,
      afterId,
      limit: finalLimit,
    },
  });
  const { usedLiveFallback, ...payload } = result;

  if (globalFlags.json) {
    writeJson(payload);
  } else {
    renderMessageGroups(payload.messages, payload.source);
    if (usedLiveFallback) {
      printArchiveFallbackNote(channelIds);
    }
  }
}

async function runMessagesSearch(globalFlags, queryParts, options = {}) {
  const query = options.query || (queryParts || []).join(' ').trim();
  const channelIds = parseListValues(options.chat);
  const tagList = [
    ...parseListValues(options.tag),
    ...parseListValues(options.tags),
  ];
  const topicId = parsePositiveInt(options.topic, '--topic');
  const finalLimit = parsePositiveInt(options.limit, '--limit') ?? 100;
  const { beforeId, afterId } = parseMessageIdWindow(options);

  if (!query && !options.regex && tagList.length === 0) {
    throw new Error('Provide query, regex, or tag for messages search.');
  }

  const result = await runOperation(globalFlags, {
    op: 'messagesSearch',
    args: {
      query,
      regex: options.regex,
      source: options.source,
      channelIds: channelIds.length ? channelIds : null,
      tags: tagList.length ? tagList : null,
      topicId,
      fromDate: options.after,
      toDate: options.before,
      beforeId,
      afterId,
      limit: finalLimit,
      caseInsensitive: !options.caseSensitive,
    },
  });
  const { usedLiveFallback, source, returned, messages } = result;

  if (globalFlags.json) {
    writeJson({ source, returned, messages });
  } else {
    renderMessageGroups(messages, source);
    if (usedLiveFallback) {
      // Fallback hint targets whatever channels the search resolved against.
      const hintChannels = channelIds.length ? channelIds : tagList;
      printArchiveFallbackNote(hintChannels);
    }
  }
}

async function runMessagesShow(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  if (!options.id) {
    throw new Error('--id is required');
  }
  const messageId = parsePositiveInt(options.id, '--id');
  const result = await runOperation(globalFlags, {
    op: 'messagesGet',
    args: { channelId: options.chat, messageId, source: options.source },
  });
  const { usedLiveFallback, source, message } = result;
  const payload = { source, message };
  if (globalFlags.json) {
    writeJson(payload);
  } else {
    console.log(JSON.stringify(payload, null, 2));
    if (usedLiveFallback) {
      printArchiveFallbackNote([options.chat]);
    }
  }
}

async function runMessagesContext(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  if (!options.id) {
    throw new Error('--id is required');
  }
  const messageId = parsePositiveInt(options.id, '--id');
  const safeBefore = parseNonNegativeInt(options.before, '--before') ?? 20;
  const safeAfter = parseNonNegativeInt(options.after, '--after') ?? 20;
  const result = await runOperation(globalFlags, {
    op: 'messagesContext',
    args: {
      channelId: options.chat,
      messageId,
      before: safeBefore,
      after: safeAfter,
      source: options.source,
    },
  });
  const { usedLiveFallback, source, target, before, after } = result;
  const payload = { source, target, before, after };
  if (globalFlags.json) {
    writeJson(payload);
  } else {
    console.log(JSON.stringify(payload, null, 2));
    if (usedLiveFallback) {
      printArchiveFallbackNote([options.chat]);
    }
  }
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

// Map a client-side invoke timeout (AbortSignal.timeout fires a TimeoutError, an
// aborted request fires an AbortError) to the clear send-timeout SendCommandError.
function isInvokeTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

// Run a send op through the warm server and surface its result. invokeTimeoutMs
// bounds the CLI's wait; the server runs the existing retry/flood logic against
// the warm client, so retry/FLOOD_WAIT/rate-limit behavior is preserved there.
async function runSendOperation(globalFlags, { op, method, retries, args, invokeTimeoutMs }) {
  try {
    return await runOperation(globalFlags, { op, args, invokeTimeoutMs });
  } catch (error) {
    if (isInvokeTimeoutError(error)) {
      throw new SendCommandError({
        type: 'timeout',
        method,
        message: formatSendTimeoutMessage(invokeTimeoutMs),
        code: null,
        attempt: 1,
        retries,
        retryable: false,
      });
    }
    throw normalizeSendCommandError(error, { method, retries });
  }
}

async function runSendText(globalFlags, options = {}) {
  resolveSendAliases(options);
  const timeoutMs = resolveSendTimeoutMs(globalFlags.timeoutMs);
  const method = 'sendText';
  let retries = DEFAULT_SEND_RETRIES;

  try {
    if (!options.to) throw new Error('--to is required');
    if (!options.message) throw new Error('--message is required');
    const parseMode = parseSendParseMode(options.parseMode);
    retries = parseNonNegativeInt(options.retries, '--retries') ?? DEFAULT_SEND_RETRIES;
    const retryBackoff = parseRetryBackoff(options.retryBackoff);
    const topicId = parsePositiveInt(options.topic, '--topic');
    const replyToMessageId = parsePositiveInt(options.replyTo, '--reply-to');
    const scheduleDate = parseScheduleDate(options.schedule);
    const { result, attempts } = await runSendOperation(globalFlags, {
      op: 'sendText',
      method,
      retries,
      invokeTimeoutMs: timeoutMs,
      args: {
        chat: options.to,
        text: options.message,
        topicId,
        replyToMessageId,
        parseMode,
        noPreview: options.noPreview,
        silent: options.silent || false,
        noforwards: options.forwards === false,
        scheduleDate,
        retries,
        retryBackoff,
        timeoutMs,
      },
    });
    const payload = { channelId: options.to, ...result };
    if (attempts > 1) {
      payload.attempts = attempts;
    }
    if (globalFlags.json) {
      writeJson(payload);
    } else {
      console.log(`Message sent (${result.messageId}).`);
    }
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
    if (!options.to) throw new Error('--to is required');
    if (!options.photo) throw new Error('--photo is required');
    const parseMode = parseSendParseMode(options.parseMode);
    if (parseMode && !(typeof options.caption === 'string' && options.caption.trim())) {
      throw new Error('--parse-mode requires --caption for send photo');
    }
    retries = parseNonNegativeInt(options.retries, '--retries') ?? DEFAULT_SEND_RETRIES;
    const retryBackoff = parseRetryBackoff(options.retryBackoff);
    const topicId = parsePositiveInt(options.topic, '--topic');
    const replyToMessageId = parsePositiveInt(options.replyTo, '--reply-to');
    const scheduleDate = parseScheduleDate(options.schedule);
    const { result, attempts } = await runSendOperation(globalFlags, {
      op: 'sendPhoto',
      method,
      retries,
      invokeTimeoutMs: timeoutMs,
      args: {
        chat: options.to,
        photo: options.photo,
        caption: options.caption,
        topicId,
        replyToMessageId,
        parseMode,
        silent: options.silent || false,
        noforwards: options.forwards === false,
        captionAbove: options.captionAbove || false,
        spoiler: options.spoiler || false,
        scheduleDate,
        retries,
        retryBackoff,
        timeoutMs,
      },
    });
    if (globalFlags.json) {
      writeJson(buildSendPhotoSuccessPayload({ method, inputChatId: options.to, result, attempts }));
    } else {
      console.log(`Photo sent (${result.messageId}).`);
    }
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
    if (!options.to) throw new Error('--to is required');
    if (!options.file) throw new Error('--file is required');
    const parseMode = parseSendParseMode(options.parseMode);
    if (parseMode && !(typeof options.caption === 'string' && options.caption.trim())) {
      throw new Error('--parse-mode requires --caption for send file');
    }
    retries = parseNonNegativeInt(options.retries, '--retries') ?? DEFAULT_SEND_RETRIES;
    const retryBackoff = parseRetryBackoff(options.retryBackoff);
    const topicId = parsePositiveInt(options.topic, '--topic');
    const replyToMessageId = parsePositiveInt(options.replyTo, '--reply-to');
    const scheduleDate = parseScheduleDate(options.schedule);
    const { result, attempts } = await runSendOperation(globalFlags, {
      op: 'sendFile',
      method,
      retries,
      invokeTimeoutMs: timeoutMs,
      args: {
        chat: options.to,
        file: options.file,
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
        retries,
        retryBackoff,
        timeoutMs,
      },
    });
    const payload = { channelId: options.to, ...result };
    if (attempts > 1) {
      payload.attempts = attempts;
    }
    if (globalFlags.json) {
      writeJson(payload);
    } else {
      console.log(`File sent (${result.messageId}).`);
    }
  } catch (error) {
    throw normalizeSendCommandError(error, { method, retries });
  }
}

async function runMediaDownload(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  if (!options.id) {
    throw new Error('--id is required');
  }
  const messageId = parsePositiveInt(options.id, '--id');
  const result = await runOperation(globalFlags, {
    op: 'mediaDownload',
    args: { channelId: options.chat, messageId, outputPath: options.output },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Downloaded to ${result.path} (${result.bytes} bytes).`);
  }
}

async function runTopicsList(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
  const result = await runOperation(globalFlags, {
    op: 'topicsList',
    args: { channelId: options.chat, limit },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    for (const topic of result.topics) {
      console.log(`#${topic.id} ${topic.title ?? ''}`.trim());
    }
  }
}

async function runTopicsSearch(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  if (!options.query) {
    throw new Error('--query is required');
  }
  const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
  const result = await runOperation(globalFlags, {
    op: 'topicsList',
    args: { channelId: options.chat, query: options.query, limit },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    for (const topic of result.topics) {
      console.log(`#${topic.id} ${topic.title ?? ''}`.trim());
    }
  }
}

async function runTagsSet(globalFlags, options = {}) {
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
  const result = await runOperation(globalFlags, {
    op: 'tagsSet',
    args: { chat: options.chat, tags: tagValues, source: options.source },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Tags set for ${options.chat}: ${result.tags.join(', ')}`);
  }
}

async function runTagsList(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const tags = await runOperation(globalFlags, {
    op: 'tagsList',
    args: { chat: options.chat, source: options.source },
  });
  if (globalFlags.json) {
    writeJson(tags);
  } else {
    console.log(tags.map((tag) => tag.tag).join(', '));
  }
}

async function runTagsSearch(globalFlags, options = {}) {
  if (!options.tag) {
    throw new Error('--tag is required');
  }
  const limit = parsePositiveInt(options.limit, '--limit') ?? 100;
  const channels = await runOperation(globalFlags, {
    op: 'tagsSearch',
    args: { tag: options.tag, source: options.source, limit },
  });
  if (globalFlags.json) {
    writeJson(channels);
  } else {
    for (const channel of channels) {
      const label = channel.peerTitle || channel.username || channel.channelId;
      console.log(`${label} (${channel.channelId})`);
    }
  }
}

async function runTagsAuto(globalFlags, options = {}) {
  const channelIds = parseListValues(options.chat);
  const limit = parsePositiveInt(options.limit, '--limit') ?? 50;
  const results = await runOperation(globalFlags, {
    op: 'tagsAuto',
    args: {
      channelIds: channelIds.length ? channelIds : null,
      limit,
      source: options.source,
      refreshMetadata: options.refreshMetadata !== false,
    },
  });
  if (globalFlags.json) {
    writeJson(results);
  } else {
    for (const entry of results) {
      console.log(`${entry.channelId}: ${entry.tags.map((tag) => tag.tag).join(', ')}`);
    }
  }
}

async function runMetadataGet(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const metadata = await runOperation(globalFlags, {
    op: 'metadataGet',
    args: { chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson(metadata);
  } else {
    console.log(JSON.stringify(metadata, null, 2));
  }
}

async function runMetadataRefresh(globalFlags, options = {}) {
  const channelIds = parseListValues(options.chat);
  const limit = parsePositiveInt(options.limit, '--limit') ?? 20;
  const results = await runOperation(globalFlags, {
    op: 'metadataRefresh',
    args: {
      channelIds: channelIds.length ? channelIds : null,
      limit,
      force: Boolean(options.force),
      onlyMissing: Boolean(options.onlyMissing),
    },
  });
  if (globalFlags.json) {
    writeJson(results);
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

async function runContactsSearch(globalFlags, queryParts, options = {}) {
  const query = (queryParts || []).join(' ').trim();
  if (!query) {
    throw new Error('search requires a query');
  }
  const contacts = await runOperation(globalFlags, {
    op: 'contactsSearch',
    args: { query, limit: parsePositiveInt(options.limit, '--limit') ?? 50 },
  });
  if (globalFlags.json) {
    writeJson(contacts);
  } else {
    for (const contact of contacts) {
      const label = contact.alias || contact.displayName || contact.username || contact.userId;
      console.log(`${label} (${contact.userId})`);
    }
  }
}

async function runContactsShow(globalFlags, options = {}) {
  if (!options.user) {
    throw new Error('--user is required');
  }
  const contact = await runOperation(globalFlags, {
    op: 'contactsShow',
    args: { userId: options.user },
  });
  if (globalFlags.json) {
    writeJson(contact);
  } else {
    console.log(JSON.stringify(contact, null, 2));
  }
}

async function runContactsAliasSet(globalFlags, options = {}) {
  if (!options.user) {
    throw new Error('--user is required');
  }
  if (!options.alias) {
    throw new Error('--alias is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'contactsAliasSet',
    args: { userId: options.user, alias: options.alias },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Alias set for ${result.userId}: ${result.alias}`);
  }
}

async function runContactsAliasRm(globalFlags, options = {}) {
  if (!options.user) {
    throw new Error('--user is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'contactsAliasRemove',
    args: { userId: options.user },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Alias removed for ${result.userId}`);
  }
}

async function runContactsTagsAdd(globalFlags, options = {}) {
  if (!options.user) {
    throw new Error('--user is required');
  }
  const tags = parseListValues(options.tag);
  if (!tags.length) {
    throw new Error('--tag is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'contactsTagsAdd',
    args: { userId: options.user, tags },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Tags updated for ${result.userId}: ${result.tags.join(', ')}`);
  }
}

async function runContactsTagsRm(globalFlags, options = {}) {
  if (!options.user) {
    throw new Error('--user is required');
  }
  const tags = parseListValues(options.tag);
  if (!tags.length) {
    throw new Error('--tag is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'contactsTagsRemove',
    args: { userId: options.user, tags },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Tags updated for ${result.userId}: ${result.tags.join(', ')}`);
  }
}

async function runContactsNotesSet(globalFlags, options = {}) {
  if (!options.user) {
    throw new Error('--user is required');
  }
  if (options.notes === undefined) {
    throw new Error('--notes is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'contactsNotesSet',
    args: { userId: options.user, notes: options.notes },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Notes updated for ${result.userId}.`);
  }
}

async function runGroupsList(globalFlags, options = {}) {
  const groups = await runOperation(globalFlags, {
    op: 'groupsList',
    args: { query: options.query, limit: parsePositiveInt(options.limit, '--limit') ?? 100 },
  });
  if (globalFlags.json) {
    writeJson(groups);
  } else {
    for (const group of groups) {
      console.log(`${group.title} (${group.id})`);
    }
  }
}

async function runGroupsInfo(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const info = await runOperation(globalFlags, {
    op: 'groupsInfo',
    args: { chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson(info);
  } else {
    console.log(JSON.stringify(info, null, 2));
  }
}

async function runGroupsRename(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  if (!options.name) {
    throw new Error('--name is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'groupsRename',
    args: { chat: options.chat, name: options.name },
  });
  if (globalFlags.json) {
    writeJson({ channelId: result.channelId, name: result.name });
  } else {
    console.log(`Group renamed: ${result.name}`);
  }
}

async function runGroupMembersAdd(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const users = parseListValues(options.user);
  if (!users.length) {
    throw new Error('--user is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'groupMembersAdd',
    args: { chat: options.chat, userIds: users },
  });
  if (globalFlags.json) {
    writeJson({ channelId: result.channelId, failed: result.failed });
  } else if (result.failed.length) {
    console.log(`Some members failed: ${JSON.stringify(result.failed, null, 2)}`);
  } else {
    console.log('Members added.');
  }
}

async function runGroupMembersRemove(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const users = parseListValues(options.user);
  if (!users.length) {
    throw new Error('--user is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'groupMembersRemove',
    args: { chat: options.chat, userIds: users },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Removed: ${result.removed.join(', ')}`);
    if (result.failed.length) {
      console.log(`Failed: ${JSON.stringify(result.failed, null, 2)}`);
    }
  }
}

async function runGroupInviteLinkGet(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const link = await runOperation(globalFlags, {
    op: 'getGroupInviteLink',
    args: { chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson({ link: link.link });
  } else {
    console.log(link.link);
  }
}

async function runGroupInviteLinkRevoke(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const link = await runOperation(globalFlags, {
    op: 'revokeGroupInviteLink',
    args: { chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson({ link: link.link });
  } else {
    console.log(link.link);
  }
}

async function runGroupsJoin(globalFlags, options = {}) {
  if (!options.code) {
    throw new Error('--code is required');
  }
  const invite = normalizeInviteCode(options.code);
  if (!invite) {
    throw new Error('Invalid invite code.');
  }
  const chat = await runOperation(globalFlags, {
    op: 'groupsJoin',
    args: { invite },
  });
  if (globalFlags.json) {
    writeJson({
      id: chat.id?.toString?.() ?? null,
      title: chat.displayName || chat.title || 'Unknown',
      username: chat.username ?? null,
    });
  } else {
    console.log(`Joined: ${chat.displayName || chat.title || 'Unknown'}`);
  }
}

async function runGroupsLeave(globalFlags, options = {}) {
  if (!options.chat) {
    throw new Error('--chat is required');
  }
  const result = await runOperation(globalFlags, {
    op: 'groupsLeave',
    args: { chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson({ channelId: result.channelId, left: true });
  } else {
    console.log(`Left ${options.chat}`);
  }
}

// --- Folders handlers ---

async function runFoldersList(globalFlags) {
  const folders = await runOperation(globalFlags, { op: 'foldersList', args: {} });
  if (globalFlags.json) {
    writeJson(folders);
  } else {
    for (const f of folders) {
      console.log(`${f.title} (id=${f.id}, type=${f.type})`);
    }
  }
}

async function runFoldersShow(globalFlags, folder, opts = {}) {
  const info = await runOperation(globalFlags, {
    op: 'foldersShow',
    args: { folder, resolve: opts.resolve },
  });
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
}

async function runFoldersCreate(globalFlags, options) {
  if (!options.title || options.title.length > 12) throw new Error('Folder title must be 1-12 characters');
  const result = await runOperation(globalFlags, {
    op: 'foldersCreate',
    args: {
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
    },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Created folder: ${result.title} (id=${result.id})`);
  }
}

async function runFoldersEdit(globalFlags, folder, options) {
  if (options.title !== undefined && (options.title.length === 0 || options.title.length > 12)) throw new Error('Folder title must be 1-12 characters');
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
  const result = await runOperation(globalFlags, {
    op: 'foldersEdit',
    args: { folder, modification },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Updated folder: ${result.title} (id=${result.id})`);
  }
}

async function runFoldersDelete(globalFlags, folder) {
  const result = await runOperation(globalFlags, {
    op: 'foldersDelete',
    args: { folder },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Deleted folder id=${result.id}`);
  }
}

async function runFoldersReorder(globalFlags, options) {
  const ids = options.ids.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
  const result = await runOperation(globalFlags, {
    op: 'foldersReorder',
    args: { ids },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log('Folders reordered');
  }
}

async function runFoldersChatsAdd(globalFlags, folder, options) {
  if (!options.chat) throw new Error('--chat is required');
  const result = await runOperation(globalFlags, {
    op: 'foldersChatsAdd',
    args: { folder, chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Chat added to folder id=${result.folderId}`);
  }
}

async function runFoldersChatsRemove(globalFlags, folder, options) {
  if (!options.chat) throw new Error('--chat is required');
  const result = await runOperation(globalFlags, {
    op: 'foldersChatsRemove',
    args: { folder, chat: options.chat },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Chat removed from folder id=${result.folderId}`);
  }
}

async function runFoldersJoin(globalFlags, link) {
  const result = await runOperation(globalFlags, {
    op: 'foldersJoin',
    args: { link },
  });
  if (globalFlags.json) {
    writeJson(result);
  } else {
    console.log(`Joined folder: ${result.title} (id=${result.id})`);
  }
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
