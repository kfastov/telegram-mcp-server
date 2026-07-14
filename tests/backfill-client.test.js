// Tests for the server-executed backfill CLI surface (issue #30/#26): the
// `backfill --chat`, `--background`, `count`, `status`, `wait`, and `cancel`
// commands that talk to the control server. The control client and all
// service/lock/store seams are stubbed, so there is no network, filesystem, or
// auth side effect.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({ current: null }));
const control = vi.hoisted(() => ({
  ensureServer: vi.fn(() => Promise.resolve({ ok: true, pid: 7, version: '2' })),
  pingServer: vi.fn(() => Promise.resolve(null)),
  enqueueBackfill: vi.fn(() => Promise.resolve({ jobId: 11, channelId: '-100', status: 'pending' })),
  cancelBackfill: vi.fn(() => Promise.resolve({ canceled: 1, jobIds: [11] })),
  retryBackfill: vi.fn(() => Promise.resolve({ updated: 2, jobIds: [11, 12] })),
}));

vi.mock('../core/services.js', () => ({
  createServices: vi.fn(() => services.current),
}));

vi.mock('../store-lock.js', () => ({
  acquireStoreLock: vi.fn(() => () => {}),
  acquireReadLock: vi.fn(() => () => {}),
  readStoreLock: vi.fn(() => ({ exists: false })),
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: vi.fn(() => '/tmp/tgcli-test-store'),
}));

vi.mock('../core/control-client.js', () => control);

const { buildProgram } = await import('../cli.js');

function makeFakeServices(overrides = {}) {
  const telegramClient = {
    isAuthorized: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const messageSyncService = {
    db: { open: false }, // withReadSnapshot only closes when db.open is true
    getQueueStats: vi.fn(() => ({ pending: 0, in_progress: 0, idle: 0, error: 0, processing: false })),
    getJobCounts: vi.fn(() => ({ pending: 0, inProgress: 0 })),
    listJobs: vi.fn(() => []),
    cancelJobs: vi.fn(() => ({ canceled: 1, jobIds: [11] })),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { telegramClient, messageSyncService };
}

async function runProgram(argv) {
  const program = buildProgram();
  program.exitOverride();
  return program.parseAsync(['node', 'cli.js', ...argv]);
}

let logSpy;
let errSpy;
let stdoutSpy;
let stderrSpy;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  services.current = null;
  control.ensureServer.mockClear();
  control.pingServer.mockClear();
  control.enqueueBackfill.mockClear();
  control.cancelBackfill.mockClear();
  control.retryBackfill.mockClear();
  control.ensureServer.mockResolvedValue({ ok: true, pid: 7, version: '2' });
  control.pingServer.mockResolvedValue(null);
  control.enqueueBackfill.mockResolvedValue({ jobId: 11, channelId: '-100', status: 'pending' });
  control.cancelBackfill.mockResolvedValue({ canceled: 1, jobIds: [11] });
  control.retryBackfill.mockResolvedValue({ updated: 2, jobIds: [11, 12] });
  vi.clearAllMocks();
});

function stdoutText() {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
}
function stderrText() {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
}

describe('backfill --chat (server-executed)', () => {
  it('--background enqueues and prints the job id without polling', async () => {
    services.current = makeFakeServices();
    await runProgram(['--json', 'backfill', '--chat', '@chan', '--depth', '50', '--background']);

    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(control.enqueueBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', {
      chatId: '@chan',
      depth: 50,
      minDate: null,
    });
    // No progress polling in background mode.
    expect(services.current.messageSyncService.listJobs).not.toHaveBeenCalled();
    expect(stdoutText()).toContain('"jobId": 11');
  });

  it('foreground polls listJobs until the job reaches a terminal status', async () => {
    const listJobs = vi
      .fn()
      .mockReturnValueOnce([{ id: 11, channel_id: '-100', peer_title: 'Chan', status: 'in_progress', message_count: 10, target_message_count: 100 }])
      .mockReturnValue([{ id: 11, channel_id: '-100', peer_title: 'Chan', status: 'idle', message_count: 100, target_message_count: 100 }]);
    services.current = makeFakeServices({ listJobs });

    await runProgram(['backfill', '--chat', '@chan']);

    expect(control.enqueueBackfill).toHaveBeenCalled();
    expect(listJobs).toHaveBeenCalledWith({ channelId: '-100', limit: 1 });
    // Progress rendered to stderr; final summary on stdout.
    expect(stderrText()).toContain('Backfilling Chan');
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Backfill complete');
    expect(process.exitCode).not.toBe(1);
  });

  it('exits non-zero when the job ends in error', async () => {
    const listJobs = vi.fn(() => [
      { id: 11, channel_id: '-100', peer_title: 'Chan', status: 'error', error: 'boom', message_count: 0, target_message_count: 100 },
    ]);
    services.current = makeFakeServices({ listJobs });

    await runProgram(['backfill', '--chat', '@chan']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset for other tests
  });

  it('--quiet suppresses progress on stderr', async () => {
    const listJobs = vi.fn(() => [
      { id: 11, channel_id: '-100', peer_title: 'Chan', status: 'idle', message_count: 100, target_message_count: 100 },
    ]);
    services.current = makeFakeServices({ listJobs });

    await runProgram(['--quiet', 'backfill', '--chat', '@chan']);
    expect(stderrText()).not.toContain('Backfilling');
  });

  it('SIGINT detaches without cancelling the job', async () => {
    // Keep the job non-terminal so the poll loop is running when SIGINT fires.
    const listJobs = vi.fn(() => [
      { id: 11, channel_id: '-100', peer_title: 'Chan', status: 'in_progress', message_count: 5, target_message_count: 100 },
    ]);
    services.current = makeFakeServices({ listJobs });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit__'); // unwind the poll loop like a real exit would
    });

    const run = runProgram(['backfill', '--chat', '@chan']).catch((e) => {
      if (e?.message !== '__exit__') throw e;
    });
    // Let the first poll tick start, then deliver SIGINT. The handler calls
    // process.exit(0), which our stub turns into a synchronous throw — catch it
    // here since it unwinds through the synchronous emit.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      process.emit('SIGINT');
    } catch (e) {
      if (e?.message !== '__exit__') throw e;
    }
    await run;

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stderrText()).toContain('Still running in the background');
    // Detach must NOT cancel: no cancel call of any kind.
    expect(control.cancelBackfill).not.toHaveBeenCalled();
    expect(services.current.messageSyncService.cancelJobs).not.toHaveBeenCalled();
  });
});

describe('backfill count', () => {
  it('prints the number of in-progress jobs', async () => {
    services.current = makeFakeServices({
      getJobCounts: vi.fn(() => ({ pending: 2, inProgress: 3 })),
    });
    await runProgram(['backfill', 'count']);
    expect(logSpy).toHaveBeenCalledWith('3');
  });
});

describe('backfill status', () => {
  it('reports active backfills and server state', async () => {
    services.current = makeFakeServices({
      getQueueStats: vi.fn(() => ({ pending: 1, in_progress: 1, idle: 0, error: 0 })),
      listJobs: vi.fn(() => [
        { id: 11, channel_id: '-100', peer_title: 'Chan', status: 'in_progress', message_count: 40, target_message_count: 100, cursor_message_date: '2026-01-01', updated_at: 'u' },
      ]),
    });
    control.pingServer.mockResolvedValue({ ok: true, pid: 7, version: '2' });

    await runProgram(['backfill', 'status']);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('QUEUE:');
    expect(out).toContain('SERVER: up (pid 7)');
    expect(out).toContain('Chan [in_progress] 40/100 (40%)');
  });
});

describe('backfill cancel', () => {
  it('auto-starts the control server and cancels by chat through it', async () => {
    services.current = makeFakeServices();

    await runProgram(['backfill', 'cancel', '--chat', '@chan']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(control.cancelBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', { chatId: '@chan' });
    expect(control.pingServer).not.toHaveBeenCalled();
    expect(services.current.messageSyncService.cancelJobs).not.toHaveBeenCalled();
  });
});

describe('backfill (no --chat): queue draining via the server', () => {
  it('--once starts the server and tracks the queue to completion', async () => {
    services.current = makeFakeServices({
      getJobCounts: vi.fn(() => ({ pending: 0, inProgress: 0 })),
    });
    await runProgram(['backfill', '--once']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    // No in-process worker: never created services for queue processing, only the
    // brief read snapshot the drain poll uses.
    expect(services.current.messageSyncService.processQueue).toBeUndefined();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Backfill queue drained.');
  });

  it('--follow tracks the queue with progress, then exits when drained', async () => {
    const getJobCounts = vi
      .fn()
      .mockReturnValueOnce({ pending: 0, inProgress: 1 })
      .mockReturnValue({ pending: 0, inProgress: 0 });
    services.current = makeFakeServices({
      getJobCounts,
      listJobs: vi.fn((q) => (q.status === 'in_progress'
        ? [{ id: 11, channel_id: '-100', peer_title: 'Chan', status: 'in_progress', message_count: 5, target_message_count: 100 }]
        : [])),
    });
    await runProgram(['sync', '--follow']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(stderrText()).toContain('Backfilling Chan');
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Backfill queue drained.');
  });

  it('bare backfill (no flags) prints usage and does not touch the server', async () => {
    services.current = makeFakeServices();
    await runProgram(['backfill']);
    expect(control.ensureServer).not.toHaveBeenCalled();
    expect(stderrText()).toContain('Usage:');
  });
});

describe('backfill jobs add / retry / cancel route through the control API', () => {
  it('jobs add enqueues via the control client (no in-process queue)', async () => {
    services.current = makeFakeServices();
    await runProgram(['backfill', 'jobs', 'add', '--chat', '@chan', '--depth', '5']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(control.enqueueBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', {
      chatId: '@chan',
      depth: 5,
      minDate: null,
    });
    expect(services.current.messageSyncService.processQueue).toBeUndefined();
  });

  it('jobs retry resets via the control client and lets the server process', async () => {
    services.current = makeFakeServices();
    await runProgram(['backfill', 'jobs', 'retry', '--all-errors']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(control.retryBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', {
      jobId: null,
      channelId: null,
      allErrors: true,
    });
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Re-queued 2 job(s).');
  });

  it('jobs retry by channel routes the channel filter to the server', async () => {
    services.current = makeFakeServices();
    await runProgram(['backfill', 'jobs', 'retry', '--channel', '@chan']);
    expect(control.retryBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', {
      jobId: null,
      channelId: '@chan',
      allErrors: false,
    });
  });

  it('jobs cancel by job id auto-starts and routes through the control client', async () => {
    services.current = makeFakeServices();
    await runProgram(['backfill', 'jobs', 'cancel', '--job-id', '42']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(control.cancelBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', {
      jobId: 42,
      chatId: null,
    });
    expect(services.current.messageSyncService.cancelJobs).not.toHaveBeenCalled();
  });

  it('jobs cancel by channel auto-starts and routes through the control client', async () => {
    services.current = makeFakeServices();
    await runProgram(['backfill', 'jobs', 'cancel', '--channel', '@chan']);
    expect(control.ensureServer).toHaveBeenCalledWith('/tmp/tgcli-test-store', { idleExit: '60s' });
    expect(control.cancelBackfill).toHaveBeenCalledWith('/tmp/tgcli-test-store', {
      jobId: null,
      chatId: '@chan',
    });
    expect(services.current.messageSyncService.cancelJobs).not.toHaveBeenCalled();
  });
});
