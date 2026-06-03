import { resolveStoreDir } from './store.js';
import { acquireReadLock, acquireStoreLock } from '../store-lock.js';
import { createMessageSyncService, createTelegramClient, resolveValidatedConfig } from './services.js';
import { invoke, pingServer } from './control-client.js';
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

// Runs a shared operation server-first with a local fallback, returning its
// structured result. Both paths execute the SAME OPERATIONS[op], so the result —
// and therefore whatever the caller renders from it — is identical regardless of
// who served it.
//
//   - If a control server is already running, ask it to run the op against its
//     warm (already-authed) services via POST /control/invoke.
//   - Otherwise run the op locally inside withCommand with the requested
//     services/lock. requireAuth enforces the local auth check; the warm path
//     needs none because the server's client is already logged in.
//
// Opportunistic only: this never starts a server, so an offline run keeps the
// current local behavior.
export async function runOperation(globalFlags, { op, args, need, lock, requireAuth = false }) {
  const handler = OPERATIONS[op];
  if (!handler) {
    throw new Error(`runOperation: unknown operation "${op}"`);
  }
  const storeDir = resolveStoreDir();
  if (await pingServer(storeDir)) {
    return invoke(storeDir, { op, args });
  }
  return withCommand(globalFlags, { need, lock }, async (ctx) => {
    if (requireAuth && !(await ctx.telegramClient.isAuthorized().catch(() => false))) {
      throw new Error('Not authenticated. Run `node cli.js auth` first.');
    }
    return handler(ctx, args);
  });
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
