import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isIdle,
  writeControlFile,
  removeControlFile,
  generateControlToken,
  CONTROL_FILE,
} from '../core/control-server.js';

describe('isIdle predicate', () => {
  const base = {
    jobCounts: { pending: 0, inProgress: 0 },
    watchedCount: 0,
    lastActivityAt: 0,
    now: 60_000,
    idleExitMs: 30_000,
  };

  it('is idle with no jobs, no watched channels, and stale activity', () => {
    expect(isIdle(base)).toBe(true);
  });

  it('is not idle when there are pending jobs', () => {
    expect(isIdle({ ...base, jobCounts: { pending: 1, inProgress: 0 } })).toBe(false);
  });

  it('is not idle when there are in-progress jobs', () => {
    expect(isIdle({ ...base, jobCounts: { pending: 0, inProgress: 1 } })).toBe(false);
  });

  it('is not idle when channels are watched', () => {
    expect(isIdle({ ...base, watchedCount: 3 })).toBe(false);
  });

  it('is not idle when activity is recent (within the window)', () => {
    expect(isIdle({ ...base, lastActivityAt: 45_000 })).toBe(false);
  });

  it('is never idle when idleExitMs is zero or unset', () => {
    expect(isIdle({ ...base, idleExitMs: 0 })).toBe(false);
    expect(isIdle({ ...base, idleExitMs: null })).toBe(false);
  });
});

describe('idle monitor shutdown timing (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires shutdown only after the idle window with no work', () => {
    const idleExitMs = 30_000;
    const intervalMs = 5_000;
    let lastActivityAt = 0;
    const onShutdown = vi.fn();
    const service = {
      getJobCounts: () => ({ pending: 0, inProgress: 0 }),
      getWatchedChannelCount: () => 0,
    };

    const timer = setInterval(() => {
      if (
        isIdle({
          jobCounts: service.getJobCounts(),
          watchedCount: service.getWatchedChannelCount(),
          lastActivityAt,
          now: Date.now(),
          idleExitMs,
        })
      ) {
        onShutdown();
      }
    }, intervalMs);

    // Before the window elapses, no shutdown.
    vi.advanceTimersByTime(30_000);
    expect(onShutdown).not.toHaveBeenCalled();

    // Crossing the window (now - lastActivityAt > idleExitMs) triggers shutdown.
    vi.advanceTimersByTime(5_000);
    expect(onShutdown).toHaveBeenCalled();

    clearInterval(timer);
  });

  it('does not fire shutdown while a channel is watched', () => {
    const idleExitMs = 30_000;
    const onShutdown = vi.fn();
    const service = {
      getJobCounts: () => ({ pending: 0, inProgress: 0 }),
      getWatchedChannelCount: () => 1,
    };

    const timer = setInterval(() => {
      if (
        isIdle({
          jobCounts: service.getJobCounts(),
          watchedCount: service.getWatchedChannelCount(),
          lastActivityAt: 0,
          now: Date.now(),
          idleExitMs,
        })
      ) {
        onShutdown();
      }
    }, 5_000);

    vi.advanceTimersByTime(120_000);
    expect(onShutdown).not.toHaveBeenCalled();

    clearInterval(timer);
  });
});

describe('control.json lifecycle', () => {
  let storeDir;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-control-test-'));
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('writes control.json with mode 0600 and removes it', () => {
    const token = generateControlToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    writeControlFile(storeDir, {
      pid: 999,
      port: 8765,
      token,
      startedAt: '2026-06-02T00:00:00.000Z',
      version: '9.9.9',
    });

    const filePath = path.join(storeDir, CONTROL_FILE);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed).toMatchObject({ pid: 999, port: 8765, token, version: '9.9.9' });

    removeControlFile(storeDir);
    expect(fs.existsSync(filePath)).toBe(false);

    // Removing a missing file is a no-op (does not throw).
    expect(() => removeControlFile(storeDir)).not.toThrow();
  });
});
