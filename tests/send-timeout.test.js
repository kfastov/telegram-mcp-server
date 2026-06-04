// Tests for issue #23: send commands get a bounded default timeout, while
// long-running commands (sync, --follow, server, ...) stay unbounded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks for the CLI integration tests ---------------------------------
// The send / sync handlers build real Telegram + sync services and acquire a
// store lock. Stub those seams so we can drive the command surface without any
// network, filesystem, or auth side effects.

const services = vi.hoisted(() => ({ current: null }));
const control = vi.hoisted(() => ({ ensureServer: null, invoke: null }));

vi.mock('../core/services.js', () => ({
  createServices: vi.fn(() => services.current),
  // withCommand builds only the needed half via these granular factories.
  createTelegramClient: vi.fn(() => ({ telegramClient: services.current.telegramClient })),
  createMessageSyncService: vi.fn(() => ({ messageSyncService: services.current.messageSyncService })),
}));

// Send commands route through the warm server (ensureServer + invoke). The CLI's
// timeoutMs bounds its wait on invoke; modeling that wait here lets us assert the
// CLI surfaces a clear send-timeout without any real process or network.
class ServerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

vi.mock('../core/control-client.js', () => ({
  ensureServer: (...args) => control.ensureServer(...args),
  invoke: (...args) => control.invoke(...args),
  pingServer: vi.fn(),
  enqueueBackfill: vi.fn(),
  cancelBackfill: vi.fn(),
  ServerUnavailableError,
}));

vi.mock('../store-lock.js', () => ({
  acquireStoreLock: vi.fn(() => () => {}),
  acquireReadLock: vi.fn(() => () => {}),
  readStoreLock: vi.fn(() => ({ exists: false })),
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: vi.fn(() => '/tmp/tgcli-test-store'),
}));

const {
  DEFAULT_SEND_TIMEOUT_MS,
  formatSendTimeoutMessage,
  resolveSendTimeoutMs,
  buildProgram,
} = await import('../cli.js');

const {
  executeSendWithRetries,
  parseRetryBackoff,
  formatRateLimitTimeoutMessage,
} = await import('../core/send-utils.js');

// --- Pure helper unit tests ----------------------------------------------

describe('resolveSendTimeoutMs', () => {
  it('(a) applies the default when no --timeout is given (null)', () => {
    expect(resolveSendTimeoutMs(null)).toBe(DEFAULT_SEND_TIMEOUT_MS);
    expect(resolveSendTimeoutMs(undefined)).toBe(DEFAULT_SEND_TIMEOUT_MS);
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(30000);
  });

  it('(c) treats --timeout 0 as disabled/unbounded (stays 0)', () => {
    expect(resolveSendTimeoutMs(0)).toBe(0);
  });

  it('(d) honors an explicit --timeout value', () => {
    expect(resolveSendTimeoutMs(5000)).toBe(5000);
    expect(resolveSendTimeoutMs(300000)).toBe(300000);
  });
});

describe('formatSendTimeoutMessage', () => {
  it('(e) produces a clear, actionable timeout message', () => {
    const msg = formatSendTimeoutMessage(30000);
    expect(msg).toBe(
      'Send timed out after 30s (no response from Telegram). '
      + 'Pass --timeout <duration> to extend, or --timeout 0 to disable.',
    );
  });

  it('renders sub-second timeouts in ms', () => {
    expect(formatSendTimeoutMessage(500)).toContain('Send timed out after 500ms');
  });
});

describe('formatRateLimitTimeoutMessage', () => {
  it('names the FLOOD_WAIT and the timeout budget', () => {
    expect(formatRateLimitTimeoutMessage(120, 30000)).toBe(
      'Telegram rate-limited this send (FLOOD_WAIT 120s), which exceeds the 30s timeout. '
      + 'Retry later or pass --timeout 0.',
    );
  });
});

// --- FLOOD_WAIT vs timeout budget ----------------------------------------

describe('executeSendWithRetries FLOOD_WAIT budget handling', () => {
  it('reports a rate limit (not a generic timeout) when FLOOD_WAIT exceeds the budget', async () => {
    let currentTime = 0;
    const now = vi.fn(() => currentTime);
    const sleep = vi.fn(async (ms) => { currentTime += ms; });
    const sendFn = vi.fn().mockRejectedValue(new Error('FLOOD_WAIT_120'));

    await expect(
      executeSendWithRetries(sendFn, {
        method: 'sendText',
        retries: 2,
        retryBackoff: parseRetryBackoff('constant'),
        timeoutMs: 30000,
        maxWaitSeconds: 300,
        sleep,
        now,
      }),
    ).rejects.toMatchObject({
      name: 'SendCommandError',
      details: expect.objectContaining({
        type: 'rate_limit',
        method: 'sendText',
        waitSeconds: 120,
      }),
    });

    // It must abort early rather than sleep into a generic timeout.
    expect(sleep).not.toHaveBeenCalled();
    const error = await executeSendWithRetries(sendFn, {
      method: 'sendText',
      retries: 1,
      timeoutMs: 30000,
      sleep,
      now: () => 0,
    }).catch((e) => e);
    expect(error.details.message).toContain('FLOOD_WAIT 120s');
    expect(error.details.message).toContain('30s timeout');
  });

  it('still retries a FLOOD_WAIT that fits inside the budget', async () => {
    let currentTime = 0;
    const now = vi.fn(() => currentTime);
    const sleep = vi.fn(async (ms) => { currentTime += ms; });
    const sendFn = vi.fn()
      .mockRejectedValueOnce(new Error('A wait of 3 seconds is required'))
      .mockResolvedValueOnce({ messageId: 42 });

    const result = await executeSendWithRetries(sendFn, {
      method: 'sendText',
      retries: 2,
      timeoutMs: 30000,
      sleep,
      now,
    });

    expect(result).toEqual({ result: { messageId: 42 }, attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(3000);
  });
});

// --- CLI integration: scoped default timeout -----------------------------

function makeFakeServices({ refreshImpl } = {}) {
  const telegramClient = {
    isAuthorized: vi.fn().mockResolvedValue(true),
    startUpdates: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const messageSyncService = {
    refreshChannelsFromDialogs: vi.fn(refreshImpl ?? (async () => {})),
    resumePendingJobs: vi.fn(),
    getQueueStats: vi.fn(() => ({ pending: 0, in_progress: 0, processing: false })),
    shutdown: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { telegramClient, messageSyncService };
}

// Model the warm server's send execution behind invoke: a hanging send rejects
// with a TimeoutError once the CLI's invoke timeoutMs elapses (mirroring
// AbortSignal.timeout aborting the real request); a normal send resolves with the
// op's { result, attempts } shape.
function makeInvoke({ resultMessageId, hang = false } = {}) {
  return vi.fn((_storeDir, { timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (hang) {
      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
      }
      // timeoutMs === 0 (--timeout 0): never settle.
      return;
    }
    resolve({ result: { messageId: resultMessageId }, attempts: 1 });
  }));
}

describe('send command default timeout (CLI integration)', () => {
  let logSpy;
  let errSpy;
  let exitCode;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitCode = process.exitCode;
    process.exitCode = undefined;
    control.ensureServer = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
    errSpy.mockRestore();
    services.current = null;
    process.exitCode = exitCode;
  });

  async function runProgram(argv) {
    const program = buildProgram();
    program.exitOverride();
    return program.parseAsync(['node', 'cli.js', ...argv]);
  }

  it('(a) times out a hanging send after the 30s default when no --timeout is given', async () => {
    control.invoke = makeInvoke({ hang: true });

    const done = runProgram(['send', 'text', '--to', '@x', '--message', 'hi']);

    // Let the async work reach the hanging invoke, then cross the 30s boundary.
    await vi.advanceTimersByTimeAsync(29000);
    expect(process.exitCode).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(process.exitCode).toBe(1);
    const stderrText = errSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrText).toContain('Send timed out after 30s');
  });

  it('(d) honors an explicit --timeout value', async () => {
    control.invoke = makeInvoke({ hang: true });

    const done = runProgram(['send', 'text', '--to', '@x', '--message', 'hi', '--timeout', '1s']);

    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(process.exitCode).toBe(1);
    const stderrText = errSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrText).toContain('Send timed out after 1s');
  });

  it('(c) --timeout 0 disables the timeout (send is unbounded)', async () => {
    let invokeResolve;
    control.invoke = vi.fn(() => new Promise((resolve) => { invokeResolve = resolve; }));

    const done = runProgram(['send', 'text', '--to', '@x', '--message', 'hi', '--timeout', '0']);

    // Cross well past the default budget: nothing should time out.
    await vi.advanceTimersByTimeAsync(120000);
    expect(process.exitCode).toBeUndefined();

    // Now let the send finish and confirm success, not a timeout.
    invokeResolve({ result: { messageId: 7 }, attempts: 1 });
    await done;

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Message sent (7).');
    // The CLI passes timeoutMs: 0 so its wait on invoke is unbounded.
    expect(control.invoke.mock.calls[0][1].timeoutMs).toBe(0);
  });

  it('(b) a long-running command (sync) is NOT bounded by the send default', async () => {
    // The queue never drains (one job stays in-flight forever); if the send
    // default leaked into sync it would reject at 30s. It must not.
    services.current = makeFakeServices();
    services.current.messageSyncService.getJobCounts = vi.fn(() => ({ pending: 0, inProgress: 1 }));
    services.current.messageSyncService.listJobs = vi.fn(() => []);

    let settled = false;
    const done = runProgram(['sync', '--once']).then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // Advance to 2x the send default; sync must still be tracking the queue.
    await vi.advanceTimersByTimeAsync(60000);
    expect(settled).toBe(false);
    expect(process.exitCode).toBeUndefined();

    // Detach the dangling promise so the test runner can exit cleanly.
    void done;
  });

  it('passes the 30s default as the invoke timeout and prints success', async () => {
    control.invoke = makeInvoke({ resultMessageId: 11 });

    await runProgram(['send', 'text', '--to', '@x', '--message', 'hi']);

    expect(process.exitCode).toBeUndefined();
    expect(control.invoke).toHaveBeenCalledTimes(1);
    expect(control.invoke.mock.calls[0][1].timeoutMs).toBe(DEFAULT_SEND_TIMEOUT_MS);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Message sent (11).');
  });

  it('honors --quiet without emitting the dropped connecting status', async () => {
    control.invoke = makeInvoke({ resultMessageId: 12 });

    await runProgram(['send', 'text', '--to', '@x', '--message', 'hi', '--quiet']);

    expect(process.exitCode).toBeUndefined();
    const stderrText = errSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrText).not.toContain('Connecting to Telegram');
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Message sent (12).');
  });
});
