// Tests for the shared operation registry and the server-first / local-fallback
// seam. The same OPERATIONS[op] runs on both paths, so the result a caller renders
// is identical whether a warm server served it or the local fallback did.
//
// pingServer/invoke (server path) and the withCommand service factories / lock
// helpers (local path) are all stubbed — no network, filesystem, or real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  telegramClient: null,
  messageSyncService: null,
  pingServer: null,
  invoke: null,
}));

vi.mock('../core/control-client.js', () => ({
  pingServer: (...args) => hooks.pingServer(...args),
  invoke: (...args) => hooks.invoke(...args),
}));

vi.mock('../core/services.js', () => ({
  createTelegramClient: () => ({ telegramClient: hooks.telegramClient }),
  createMessageSyncService: () => ({ messageSyncService: hooks.messageSyncService }),
  resolveValidatedConfig: () => ({}),
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
    destroy: vi.fn().mockResolvedValue(undefined),
    isAuthorized: vi.fn().mockResolvedValue(true),
    listDialogs: vi.fn().mockResolvedValue([{ id: '1', title: 'Local' }]),
    searchDialogs: vi.fn().mockResolvedValue([{ id: '2', title: 'LocalSearch' }]),
    getGroupInviteLink: vi.fn().mockResolvedValue({ link: 'https://t.me/+local' }),
  };
  hooks.messageSyncService = {
    close: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  hooks.pingServer = vi.fn();
  hooks.invoke = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OPERATIONS registry', () => {
  it('listChannels lists dialogs and applies the default limit', async () => {
    const ctx = { telegramClient: hooks.telegramClient };
    const result = await OPERATIONS.listChannels(ctx, {});
    expect(hooks.telegramClient.listDialogs).toHaveBeenCalledWith(50);
    expect(result).toEqual([{ id: '1', title: 'Local' }]);
  });

  it('listChannels searches when a query is given', async () => {
    const ctx = { telegramClient: hooks.telegramClient };
    const result = await OPERATIONS.listChannels(ctx, { query: 'foo', limit: 7 });
    expect(hooks.telegramClient.searchDialogs).toHaveBeenCalledWith('foo', 7);
    expect(result).toEqual([{ id: '2', title: 'LocalSearch' }]);
  });

  it('getGroupInviteLink returns the link descriptor', async () => {
    const ctx = { telegramClient: hooks.telegramClient };
    const result = await OPERATIONS.getGroupInviteLink(ctx, { chat: '@g' });
    expect(hooks.telegramClient.getGroupInviteLink).toHaveBeenCalledWith('@g');
    expect(result).toEqual({ link: 'https://t.me/+local' });
  });
});

describe('runOperation seam', () => {
  it('routes to the server via invoke when a server is reachable', async () => {
    hooks.pingServer.mockResolvedValue({ ok: true });
    hooks.invoke.mockResolvedValue([{ id: 'warm' }]);

    const result = await runOperation(
      {},
      { op: 'listChannels', args: { limit: 3 }, need: 'full', lock: 'read', requireAuth: true },
    );

    expect(hooks.invoke).toHaveBeenCalledWith('/tmp/tgcli-seam-store', {
      op: 'listChannels',
      args: { limit: 3 },
    });
    expect(result).toEqual([{ id: 'warm' }]);
    // Server path runs nothing locally.
    expect(hooks.telegramClient.listDialogs).not.toHaveBeenCalled();
  });

  it('falls back to local withCommand + OPERATIONS[op] when no server is reachable', async () => {
    hooks.pingServer.mockResolvedValue(null);

    const result = await runOperation(
      {},
      { op: 'listChannels', args: { limit: 3 }, need: 'full', lock: 'read', requireAuth: true },
    );

    expect(hooks.invoke).not.toHaveBeenCalled();
    expect(hooks.telegramClient.isAuthorized).toHaveBeenCalled();
    expect(hooks.telegramClient.listDialogs).toHaveBeenCalledWith(3);
    expect(result).toEqual([{ id: '1', title: 'Local' }]);
  });

  it('enforces the local auth check before running the op', async () => {
    hooks.pingServer.mockResolvedValue(null);
    hooks.telegramClient.isAuthorized.mockResolvedValue(false);

    await expect(
      runOperation(
        {},
        { op: 'listChannels', args: {}, need: 'full', lock: 'read', requireAuth: true },
      ),
    ).rejects.toThrow('Not authenticated');
    expect(hooks.telegramClient.listDialogs).not.toHaveBeenCalled();
  });

  it('produces identical results via the server path and the local path', async () => {
    // Local result.
    hooks.pingServer.mockResolvedValue(null);
    const local = await runOperation(
      {},
      { op: 'getGroupInviteLink', args: { chat: '@g' }, need: 'telegram', lock: 'read', requireAuth: true },
    );

    // Server path returns whatever the warm OPERATIONS[op] produced — model that
    // with the same shape the local client returns.
    hooks.pingServer.mockResolvedValue({ ok: true });
    hooks.invoke.mockResolvedValue({ link: 'https://t.me/+local' });
    const served = await runOperation(
      {},
      { op: 'getGroupInviteLink', args: { chat: '@g' }, need: 'telegram', lock: 'read', requireAuth: true },
    );

    expect(served).toEqual(local);
  });
});
