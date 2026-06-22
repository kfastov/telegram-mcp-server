import { resolveStoreDir } from './store.js';
import { acquireReadLock, acquireStoreLock } from '../store-lock.js';
import { createMessageSyncService, createTelegramClient, resolveValidatedConfig } from './services.js';
import { ensureServer, invoke, ServerUnavailableError } from './control-client.js';
import { OPERATIONS } from './operations.js';

// Runs fn(ctx) with exactly the services a command needs, owning the surrounding
// lifecycle: timeout, store dir, store lock, scoped service creation, and teardown.
// A handler is: validate args, then withCommand(globalFlags, opts, fn).
//
// opts.need selects which services ctx receives:
//   'telegram' -> { telegramClient }                    teardown: destroy()
//   'archive'  -> { messageSyncService } (no MTProto)    teardown: close()
//   'full'     -> { telegramClient, messageSyncService } teardown: close() + destroy()
//   'worker'   -> { telegramClient, messageSyncService }, runs the queue/realtime;
//                                                        teardown: shutdown() + destroy()
// 'archive' builds the message service with a null client, so a DB-only read opens
// no MTProto connection.
//
// opts.lock: 'read' (acquireReadLock) | 'write' (acquireStoreLock) | omitted (none).
// opts.services overrides the factories for tests.
export async function withCommand(globalFlags, opts, fn) {
  const {
    need,
    lock = null,
    onTimeout,
    timeoutMessage,
    services = { createTelegramClient, createMessageSyncService },
    storeDirOverride = null,
  } = opts;

  if (!VALID_NEEDS.has(need)) {
    throw new Error(`withCommand: unknown need "${need}"`);
  }

  // Most commands use the global --timeout; send commands pass an explicit
  // timeoutMs (resolveSendTimeoutMs) so the seam honors their default.
  const timeoutMs = opts.timeoutMs ?? globalFlags?.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = storeDirOverride ?? resolveStoreDir();
    const release = acquireLock(lock, storeDir);

    let telegramClient = null;
    let messageSyncService = null;
    try {
      if (NEEDS_TELEGRAM.has(need)) {
        // createTelegramClient validates config (throws on missing credentials).
        ({ telegramClient } = services.createTelegramClient({ storeDir }));
      } else if (need === 'archive') {
        // No client is built here, so validate config explicitly — otherwise
        // missing credentials wouldn't be reported until a query runs.
        resolveValidatedConfig({}, storeDir);
      }
      if (NEEDS_ARCHIVE.has(need)) {
        // Archive query methods never touch the client; pass it through when we
        // have one (full/worker) and null for archive-only so no MTProto spins up.
        ({ messageSyncService } = services.createMessageSyncService(telegramClient, { storeDir }));
      }

      const ctx = { storeDir };
      if (telegramClient) ctx.telegramClient = telegramClient;
      if (messageSyncService) ctx.messageSyncService = messageSyncService;
      return await fn(ctx);
    } finally {
      if (messageSyncService) {
        if (need === 'worker') {
          await messageSyncService.shutdown();
        } else {
          await messageSyncService.close();
        }
      }
      if (telegramClient) {
        await telegramClient.destroy();
      }
      if (release) {
        release();
      }
    }
  }, timeoutMs, onTimeout, timeoutMessage);
}

// Runs a shared operation against the always-on control server, returning its
// structured result. The server is the single warm backend: it owns the live
// MTProto connection, the open DB, auth, and store locking, so the CLI is a thin
// client here.
//
// The common case — a server already running — costs a single round-trip: invoke
// the op directly. Only when that fails because the server is unreachable
// (ServerUnavailableError: no control.json or a refused loopback connection) do
// we start one (ensureServer) and retry the invoke once. An operation that runs
// and fails (a 4xx/5xx, including a send error) never triggers a server start.
//
// invokeTimeoutMs bounds the client's wait on each request (e.g. the 30s send
// default); it is independent of the global --timeout. A request timeout means
// the server was reached but did not reply in time, so it surfaces to the caller
// rather than starting a second server.
export async function runOperation(globalFlags, { op, args, invokeTimeoutMs } = {}) {
  if (!OPERATIONS[op]) {
    throw new Error(`runOperation: unknown operation "${op}"`);
  }
  const storeDir = resolveStoreDir();
  try {
    return await invoke(storeDir, { op, args, timeoutMs: invokeTimeoutMs });
  } catch (error) {
    if (!(error instanceof ServerUnavailableError)) {
      throw error;
    }
    await ensureServer(storeDir, { idleExit: '60s' });
    return invoke(storeDir, { op, args, timeoutMs: invokeTimeoutMs });
  }
}

const VALID_NEEDS = new Set(['telegram', 'archive', 'full', 'worker']);
const NEEDS_TELEGRAM = new Set(['telegram', 'full', 'worker']);
const NEEDS_ARCHIVE = new Set(['archive', 'full', 'worker']);

function acquireLock(lock, storeDir) {
  if (lock === 'read') return acquireReadLock(storeDir);
  if (lock === 'write') return acquireStoreLock(storeDir);
  if (lock === null) return null;
  throw new Error(`withCommand: unknown lock "${lock}"`);
}

// Runs task; with a timeout set, races it against a timer that optionally runs
// onTimeout (cleanup) before rejecting with timeoutMessage. Exported for callers
// that manage their own service lifecycle instead of going through withCommand.
export function runWithTimeout(task, timeoutMs, onTimeout, timeoutMessage = 'Timeout') {
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
