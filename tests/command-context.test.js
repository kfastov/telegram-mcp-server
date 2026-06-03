// Unit tests for the withCommand seam: it creates ONLY the services a command's
// `need` calls for, acquires the requested lock, tears down with
// close()/shutdown()+destroy(), returns fn's result, and honors the timeout.
//
// The service factories, lock helpers, and store resolution are all stubbed, so
// these tests touch no network, filesystem, or real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  telegramClient: null,
  messageSyncService: null,
  createTelegramClient: null,
  createMessageSyncService: null,
  acquireReadLock: null,
  acquireStoreLock: null,
  readRelease: null,
  writeRelease: null,
  resolveValidatedConfig: null,
}));

vi.mock('../core/services.js', () => ({
  createTelegramClient: (...args) => hooks.createTelegramClient(...args),
  createMessageSyncService: (...args) => hooks.createMessageSyncService(...args),
  // Archive-only path validates config without building a client; stub it.
  resolveValidatedConfig: (...args) => hooks.resolveValidatedConfig(...args),
}));

vi.mock('../store-lock.js', () => ({
  acquireReadLock: (...args) => hooks.acquireReadLock(...args),
  acquireStoreLock: (...args) => hooks.acquireStoreLock(...args),
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: vi.fn(() => '/tmp/tgcli-withcommand-store'),
}));

const { withCommand } = await import('../core/command-context.js');

beforeEach(() => {
  hooks.telegramClient = { destroy: vi.fn().mockResolvedValue(undefined) };
  hooks.messageSyncService = {
    close: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  hooks.createTelegramClient = vi.fn(() => ({ telegramClient: hooks.telegramClient }));
  hooks.createMessageSyncService = vi.fn(() => ({ messageSyncService: hooks.messageSyncService }));
  hooks.readRelease = vi.fn();
  hooks.writeRelease = vi.fn();
  hooks.acquireReadLock = vi.fn(() => hooks.readRelease);
  hooks.acquireStoreLock = vi.fn(() => hooks.writeRelease);
  hooks.resolveValidatedConfig = vi.fn(() => ({}));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('withCommand need taxonomy — scoped service creation', () => {
  it("need:'telegram' creates ONLY a TelegramClient (no MessageSyncService / DB)", async () => {
    const ctxSeen = {};
    await withCommand({}, { need: 'telegram' }, async (ctx) => {
      Object.assign(ctxSeen, ctx);
    });

    expect(hooks.createTelegramClient).toHaveBeenCalledTimes(1);
    expect(hooks.createMessageSyncService).not.toHaveBeenCalled();
    expect(ctxSeen.telegramClient).toBe(hooks.telegramClient);
    expect(ctxSeen.messageSyncService).toBeUndefined();
    // Teardown: destroy the client only.
    expect(hooks.telegramClient.destroy).toHaveBeenCalledTimes(1);
    expect(hooks.messageSyncService.close).not.toHaveBeenCalled();
  });

  it("need:'archive' creates ONLY the MessageSyncService (no TelegramClient)", async () => {
    const ctxSeen = {};
    await withCommand({}, { need: 'archive' }, async (ctx) => {
      Object.assign(ctxSeen, ctx);
    });

    expect(hooks.createMessageSyncService).toHaveBeenCalledTimes(1);
    expect(hooks.createTelegramClient).not.toHaveBeenCalled();
    // Built without a client so no MTProto is spun up for an archive-only read.
    expect(hooks.createMessageSyncService).toHaveBeenCalledWith(null, expect.any(Object));
    expect(ctxSeen.messageSyncService).toBe(hooks.messageSyncService);
    expect(ctxSeen.telegramClient).toBeUndefined();
    // Teardown: close (non-mutating), no destroy.
    expect(hooks.messageSyncService.close).toHaveBeenCalledTimes(1);
    expect(hooks.messageSyncService.shutdown).not.toHaveBeenCalled();
    expect(hooks.telegramClient.destroy).not.toHaveBeenCalled();
  });

  it("need:'full' creates BOTH and passes the client into the sync service", async () => {
    const ctxSeen = {};
    await withCommand({}, { need: 'full' }, async (ctx) => {
      Object.assign(ctxSeen, ctx);
    });

    expect(hooks.createTelegramClient).toHaveBeenCalledTimes(1);
    expect(hooks.createMessageSyncService).toHaveBeenCalledTimes(1);
    expect(hooks.createMessageSyncService).toHaveBeenCalledWith(hooks.telegramClient, expect.any(Object));
    expect(ctxSeen.telegramClient).toBe(hooks.telegramClient);
    expect(ctxSeen.messageSyncService).toBe(hooks.messageSyncService);
    // Teardown: close() + destroy() for non-worker.
    expect(hooks.messageSyncService.close).toHaveBeenCalledTimes(1);
    expect(hooks.messageSyncService.shutdown).not.toHaveBeenCalled();
    expect(hooks.telegramClient.destroy).toHaveBeenCalledTimes(1);
  });

  it("need:'worker' creates BOTH and tears down with shutdown() + destroy()", async () => {
    await withCommand({}, { need: 'worker' }, async () => {});

    expect(hooks.createTelegramClient).toHaveBeenCalledTimes(1);
    expect(hooks.createMessageSyncService).toHaveBeenCalledTimes(1);
    // Worker requeues via shutdown(), NOT close().
    expect(hooks.messageSyncService.shutdown).toHaveBeenCalledTimes(1);
    expect(hooks.messageSyncService.close).not.toHaveBeenCalled();
    expect(hooks.telegramClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown need without creating anything', async () => {
    await expect(withCommand({}, { need: 'bogus' }, async () => {})).rejects.toThrow(/unknown need/);
    expect(hooks.createTelegramClient).not.toHaveBeenCalled();
    expect(hooks.createMessageSyncService).not.toHaveBeenCalled();
  });

  it("need:'archive' validates config (preserving the legacy missing-config error)", async () => {
    hooks.resolveValidatedConfig.mockImplementation(() => {
      throw new Error('Missing tgcli configuration. Run "tgcli auth" to set credentials.');
    });
    await expect(withCommand({}, { need: 'archive' }, async () => {})).rejects.toThrow(/Missing tgcli configuration/);
    // No client built, and we never opened the archive after the config failure.
    expect(hooks.createTelegramClient).not.toHaveBeenCalled();
    expect(hooks.createMessageSyncService).not.toHaveBeenCalled();
  });

  it("need:'telegram' does NOT double-validate config (createTelegramClient owns it)", async () => {
    await withCommand({}, { need: 'telegram' }, async () => {});
    expect(hooks.resolveValidatedConfig).not.toHaveBeenCalled();
  });
});

describe('withCommand locking — same lock as before, acquired and released', () => {
  it("lock:'read' acquires and releases the read lock", async () => {
    await withCommand({}, { need: 'full', lock: 'read' }, async () => {});
    expect(hooks.acquireReadLock).toHaveBeenCalledTimes(1);
    expect(hooks.acquireStoreLock).not.toHaveBeenCalled();
    expect(hooks.readRelease).toHaveBeenCalledTimes(1);
  });

  it("lock:'write' acquires and releases the store (write) lock", async () => {
    await withCommand({}, { need: 'telegram', lock: 'write' }, async () => {});
    expect(hooks.acquireStoreLock).toHaveBeenCalledTimes(1);
    expect(hooks.acquireReadLock).not.toHaveBeenCalled();
    expect(hooks.writeRelease).toHaveBeenCalledTimes(1);
  });

  it('no lock option takes no lock', async () => {
    await withCommand({}, { need: 'archive' }, async () => {});
    expect(hooks.acquireReadLock).not.toHaveBeenCalled();
    expect(hooks.acquireStoreLock).not.toHaveBeenCalled();
  });

  it('releases the lock and tears down even when fn throws', async () => {
    await expect(
      withCommand({}, { need: 'full', lock: 'write' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(hooks.writeRelease).toHaveBeenCalledTimes(1);
    expect(hooks.messageSyncService.close).toHaveBeenCalledTimes(1);
    expect(hooks.telegramClient.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('withCommand result + timeout', () => {
  it("returns fn's resolved value", async () => {
    const ctxStoreDirs = [];
    const result = await withCommand({}, { need: 'archive' }, async (ctx) => {
      ctxStoreDirs.push(ctx.storeDir);
      return { ok: true, n: 42 };
    });
    expect(result).toEqual({ ok: true, n: 42 });
    expect(ctxStoreDirs[0]).toBe('/tmp/tgcli-withcommand-store');
  });

  it('honors globalFlags.timeoutMs: a slow fn rejects with the timeout message', async () => {
    vi.useFakeTimers();
    try {
      const promise = withCommand(
        { timeoutMs: 50 },
        { need: 'telegram', timeoutMessage: 'Timeout' },
        () => new Promise(() => {}), // never resolves
      );
      const assertion = expect(promise).rejects.toThrow('Timeout');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('opts.timeoutMs overrides globalFlags.timeoutMs (send commands)', async () => {
    vi.useFakeTimers();
    try {
      const promise = withCommand(
        { timeoutMs: 0 }, // global says unbounded...
        { need: 'telegram', timeoutMs: 50, timeoutMessage: 'SendTimeout' }, // ...send opt wins
        () => new Promise(() => {}),
      );
      const assertion = expect(promise).rejects.toThrow('SendTimeout');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no timeout, a long fn still resolves (unbounded)', async () => {
    const result = await withCommand({ timeoutMs: 0 }, { need: 'archive' }, async () => 'done');
    expect(result).toBe('done');
  });
});
