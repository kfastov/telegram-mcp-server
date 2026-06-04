// Tests for the shared operation registry and the runOperation seam. The server
// is the single warm backend: runOperation auto-starts it (ensureServer) and asks
// it to run OPERATIONS[op] against its warm services (invoke). Both control-client
// entry points are stubbed — no network, filesystem, process, or real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  telegramClient: null,
  messageSyncService: null,
  ensureServer: null,
  invoke: null,
}));

class ServerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

vi.mock('../core/control-client.js', () => ({
  ensureServer: (...args) => hooks.ensureServer(...args),
  invoke: (...args) => hooks.invoke(...args),
  ServerUnavailableError,
}));

// command-context.js still imports services.js for the retained withCommand seam;
// stub it so the test never pulls in the real TelegramClient module.
vi.mock('../core/services.js', () => ({
  createTelegramClient: vi.fn(),
  createMessageSyncService: vi.fn(),
  resolveValidatedConfig: vi.fn(() => ({})),
}));

vi.mock('../store-lock.js', () => ({
  acquireReadLock: vi.fn(() => vi.fn()),
  acquireStoreLock: vi.fn(() => vi.fn()),
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: vi.fn(() => '/tmp/tgcli-seam-store'),
}));

const { OPERATIONS } = await import('../core/operations.js');
const { runOperation } = await import('../core/command-context.js');

beforeEach(() => {
  hooks.telegramClient = {
    isAuthorized: vi.fn().mockResolvedValue(true),
    listDialogs: vi.fn().mockResolvedValue([{ id: '1', title: 'Warm' }]),
    searchDialogs: vi.fn().mockResolvedValue([{ id: '2', title: 'WarmSearch' }]),
    getGroupInviteLink: vi.fn().mockResolvedValue({ link: 'https://t.me/+warm' }),
    markChannelRead: vi.fn().mockResolvedValue({ channelId: '1', messageId: 9 }),
  };
  hooks.messageSyncService = {
    setChannelSync: vi.fn(() => ({ channel_id: '1', sync_enabled: 1 })),
    listJobs: vi.fn(() => []),
    addJob: vi.fn(() => ({ id: 7, status: 'pending' })),
    processQueue: vi.fn(),
  };
  hooks.ensureServer = vi.fn().mockResolvedValue({ ok: true });
  hooks.invoke = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OPERATIONS registry', () => {
  const ctx = () => ({
    telegramClient: hooks.telegramClient,
    messageSyncService: hooks.messageSyncService,
  });

  it('listChannels lists dialogs and applies the default limit', async () => {
    const result = await OPERATIONS.listChannels(ctx(), {});
    expect(hooks.telegramClient.listDialogs).toHaveBeenCalledWith(50);
    expect(result).toEqual([{ id: '1', title: 'Warm' }]);
  });

  it('listChannels searches when a query is given', async () => {
    const result = await OPERATIONS.listChannels(ctx(), { query: 'foo', limit: 7 });
    expect(hooks.telegramClient.searchDialogs).toHaveBeenCalledWith('foo', 7);
    expect(result).toEqual([{ id: '2', title: 'WarmSearch' }]);
  });

  it('getGroupInviteLink returns the link descriptor', async () => {
    const result = await OPERATIONS.getGroupInviteLink(ctx(), { chat: '@g' });
    expect(hooks.telegramClient.getGroupInviteLink).toHaveBeenCalledWith('@g');
    expect(result).toEqual({ link: 'https://t.me/+warm' });
  });

  it('channelSetSync enables sync and queues a backfill job when none exists', async () => {
    const result = await OPERATIONS.channelSetSync(ctx(), { chat: '@g', enable: true });
    expect(hooks.messageSyncService.setChannelSync).toHaveBeenCalledWith('@g', true);
    expect(hooks.messageSyncService.addJob).toHaveBeenCalledWith('@g');
    expect(hooks.messageSyncService.processQueue).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ channelId: '1', syncEnabled: true, jobId: 7, jobQueued: true });
  });

  it('channelMarkRead marks the channel read via the warm client', async () => {
    const result = await OPERATIONS.channelMarkRead(ctx(), { chat: '@g', messageId: 9 });
    expect(hooks.telegramClient.markChannelRead).toHaveBeenCalledWith('@g', 9);
    expect(result).toEqual({ channelId: '1', messageId: 9 });
  });

  it('exposes a fixed allowlist covering the migrated surface', () => {
    for (const op of [
      'listChannels', 'channelShow', 'channelSetSync', 'channelMarkRead',
      'messagesList', 'messagesSearch', 'messagesGet', 'messagesContext',
      'sendText', 'sendPhoto', 'sendFile', 'mediaDownload',
      'topicsList', 'tagsSet', 'tagsList', 'tagsSearch', 'tagsAuto',
      'metadataGet', 'metadataRefresh',
      'contactsSearch', 'contactsShow', 'contactsAliasSet', 'contactsAliasRemove',
      'contactsTagsAdd', 'contactsTagsRemove', 'contactsNotesSet',
      'groupsList', 'groupsInfo', 'groupsRename', 'groupMembersAdd', 'groupMembersRemove',
      'getGroupInviteLink', 'revokeGroupInviteLink', 'groupsJoin', 'groupsLeave',
      'foldersList', 'foldersShow', 'foldersCreate', 'foldersEdit', 'foldersDelete',
      'foldersReorder', 'foldersChatsAdd', 'foldersChatsRemove', 'foldersJoin',
    ]) {
      expect(typeof OPERATIONS[op]).toBe('function');
    }
  });
});

describe('generic passthrough ops', () => {
  it('foldersShow forwards args to the warm client method and returns the result', async () => {
    const showFolder = vi.fn().mockResolvedValue({ id: 4, title: 'Work' });
    const result = await OPERATIONS.foldersShow(
      { telegramClient: { showFolder } },
      { folder: 'Work', resolve: true },
    );
    expect(showFolder).toHaveBeenCalledWith('Work', { resolve: true });
    expect(result).toEqual({ id: 4, title: 'Work' });
  });

  it('tagsSearch forwards to the archive service with the default limit', async () => {
    const listTaggedChannels = vi.fn().mockReturnValue([{ channelId: '1' }]);
    const result = await OPERATIONS.tagsSearch(
      { messageSyncService: { listTaggedChannels } },
      { tag: 'news', source: 'user' },
    );
    expect(listTaggedChannels).toHaveBeenCalledWith('news', { source: 'user', limit: 100 });
    expect(result).toEqual([{ channelId: '1' }]);
  });

  it('groupsInfo forwards the chat through unchanged', async () => {
    const getGroupInfo = vi.fn().mockResolvedValue({ id: '-100', title: 'G' });
    const result = await OPERATIONS.groupsInfo({ telegramClient: { getGroupInfo } }, { chat: '@g' });
    expect(getGroupInfo).toHaveBeenCalledWith('@g');
    expect(result).toEqual({ id: '-100', title: 'G' });
  });
});

describe('messagesGet source resolution', () => {
  function buildCtx({ archived = null, live = null } = {}) {
    return {
      telegramClient: {
        getMessageById: vi.fn().mockResolvedValue(live),
        getPeerMetadata: vi.fn().mockResolvedValue({ peerTitle: 'Live Title', username: 'liveuser' }),
      },
      messageSyncService: {
        getArchivedMessage: vi.fn().mockReturnValue(archived),
        getChannelMetadata: vi.fn().mockReturnValue(null),
      },
    };
  }

  it('source live returns only the live message', async () => {
    const ctx = buildCtx({ live: { id: 5, message: 'live text', date: 1 } });
    const result = await OPERATIONS.messagesGet(ctx, { channelId: '-100', messageId: 5, source: 'live' });
    expect(result.source).toBe('live');
    expect(result.message.source).toBe('live');
    expect(result.usedLiveFallback).toBe(false);
    expect(ctx.messageSyncService.getArchivedMessage).not.toHaveBeenCalled();
  });

  it('source archive returns only the archived message (no live call)', async () => {
    const ctx = buildCtx({ archived: { messageId: 5, text: 'archived', date: '2026-01-01' } });
    const result = await OPERATIONS.messagesGet(ctx, { channelId: '-100', messageId: 5, source: 'archive' });
    expect(result.source).toBe('archive');
    expect(result.message.source).toBe('archive');
    expect(result.usedLiveFallback).toBe(false);
    expect(ctx.telegramClient.getMessageById).not.toHaveBeenCalled();
  });

  it('source archive falls back to live and flags usedLiveFallback when absent in archive', async () => {
    const ctx = buildCtx({ archived: null, live: { id: 5, message: 'live text', date: 1 } });
    const result = await OPERATIONS.messagesGet(ctx, { channelId: '-100', messageId: 5, source: 'archive' });
    expect(result.source).toBe('live');
    expect(result.message.source).toBe('live');
    expect(result.usedLiveFallback).toBe(true);
  });

  it('source both prefers live and never mixes sources', async () => {
    const ctx = buildCtx({
      archived: { messageId: 5, text: 'archived', date: '2026-01-01' },
      live: { id: 5, message: 'live text', date: 1 },
    });
    const result = await OPERATIONS.messagesGet(ctx, { channelId: '-100', messageId: 5, source: 'both' });
    expect(result.source).toBe('live');
    expect(result.message.source).toBe('live');
    expect(ctx.messageSyncService.getArchivedMessage).not.toHaveBeenCalled();
  });

  it('throws when the message is absent everywhere', async () => {
    const ctx = buildCtx({ archived: null, live: null });
    await expect(
      OPERATIONS.messagesGet(ctx, { channelId: '-100', messageId: 5, source: 'archive' }),
    ).rejects.toThrow('Message not found.');
  });
});

describe('runOperation seam', () => {
  it('invokes the op directly when a server is already up (no spawn)', async () => {
    hooks.invoke.mockResolvedValue([{ id: 'warm' }]);

    const result = await runOperation({}, { op: 'listChannels', args: { limit: 3 } });

    // The warm path costs a single round-trip: invoke, no ensureServer.
    expect(hooks.ensureServer).not.toHaveBeenCalled();
    expect(hooks.invoke).toHaveBeenCalledTimes(1);
    expect(hooks.invoke).toHaveBeenCalledWith('/tmp/tgcli-seam-store', {
      op: 'listChannels',
      args: { limit: 3 },
      timeoutMs: undefined,
    });
    expect(result).toEqual([{ id: 'warm' }]);
  });

  it('starts a server and retries once when the first invoke finds none running', async () => {
    hooks.invoke
      .mockRejectedValueOnce(new ServerUnavailableError('No control server is running.'))
      .mockResolvedValueOnce([{ id: 'warm' }]);

    const result = await runOperation({}, { op: 'listChannels', args: { limit: 3 } });

    expect(hooks.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-seam-store', { idleExit: '60s' });
    expect(hooks.invoke).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ id: 'warm' }]);
  });

  it('does NOT start a server when the op runs and fails (a 4xx/5xx)', async () => {
    // A live server ran the op and it failed; that is not a connection failure,
    // so we surface the error without spawning a second server.
    hooks.invoke.mockRejectedValue(new Error('Operation failed (HTTP 500)'));

    await expect(
      runOperation({}, { op: 'listChannels', args: {} }),
    ).rejects.toThrow('Operation failed (HTTP 500)');
    expect(hooks.ensureServer).not.toHaveBeenCalled();
    expect(hooks.invoke).toHaveBeenCalledTimes(1);
  });

  it('forwards invokeTimeoutMs as the invoke wait budget', async () => {
    hooks.invoke.mockResolvedValue({ ok: true });

    await runOperation({}, { op: 'sendText', args: { chat: '@g' }, invokeTimeoutMs: 30000 });

    expect(hooks.invoke).toHaveBeenCalledWith('/tmp/tgcli-seam-store', {
      op: 'sendText',
      args: { chat: '@g' },
      timeoutMs: 30000,
    });
  });

  it('rejects an unknown operation before reaching the server', async () => {
    await expect(runOperation({}, { op: 'nope', args: {} })).rejects.toThrow(/unknown operation/);
    expect(hooks.ensureServer).not.toHaveBeenCalled();
    expect(hooks.invoke).not.toHaveBeenCalled();
  });

  it('surfaces a server start failure as a clear error', async () => {
    hooks.invoke.mockRejectedValue(new ServerUnavailableError('No control server is running.'));
    hooks.ensureServer.mockRejectedValue(new Error('Timed out waiting for the control server to start.'));
    await expect(
      runOperation({}, { op: 'listChannels', args: {} }),
    ).rejects.toThrow('Timed out waiting for the control server to start.');
    // Only the initial invoke ran; the retry never happened because start failed.
    expect(hooks.invoke).toHaveBeenCalledTimes(1);
  });
});
