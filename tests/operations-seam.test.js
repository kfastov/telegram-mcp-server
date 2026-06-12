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

vi.mock('../core/control-client.js', () => ({
  ensureServer: (...args) => hooks.ensureServer(...args),
  invoke: (...args) => hooks.invoke(...args),
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
    canonicalizeChannelId: vi.fn(async (id) => String(id)),
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

describe('runOperation seam', () => {
  it('auto-starts the server then invokes the op, returning its result', async () => {
    hooks.invoke.mockResolvedValue([{ id: 'warm' }]);

    const result = await runOperation({}, { op: 'listChannels', args: { limit: 3 } });

    expect(hooks.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-seam-store', { idleExit: '60s' });
    expect(hooks.invoke).toHaveBeenCalledWith('/tmp/tgcli-seam-store', {
      op: 'listChannels',
      args: { limit: 3 },
      timeoutMs: undefined,
    });
    expect(result).toEqual([{ id: 'warm' }]);
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
    hooks.ensureServer.mockRejectedValue(new Error('Timed out waiting for the control server to start.'));
    await expect(
      runOperation({}, { op: 'listChannels', args: {} }),
    ).rejects.toThrow('Timed out waiting for the control server to start.');
    expect(hooks.invoke).not.toHaveBeenCalled();
  });
});
