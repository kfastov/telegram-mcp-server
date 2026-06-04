// Tests for the control client (issue #30/#26): the thin HTTP layer the one-shot
// CLI uses to drive the always-on control server. Global `fetch` and
// child_process.spawn are mocked — no real network, no real process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

import {
  cancelBackfill,
  enqueueBackfill,
  ensureServer,
  invoke,
  pingServer,
  readControlFile,
} from '../core/control-client.js';
import { CONTROL_TOKEN_HEADER } from '../core/control-server.js';

let storeDir;

function writeControl(descriptor) {
  fs.writeFileSync(path.join(storeDir, 'control.json'), JSON.stringify(descriptor));
}

function jsonResponse(status, body) {
  return {
    status,
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-control-client-'));
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ unref: vi.fn() });
  global.fetch = vi.fn();
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('readControlFile', () => {
  it('returns null when control.json is absent', () => {
    expect(readControlFile(storeDir)).toBeNull();
  });

  it('parses a present control.json', () => {
    writeControl({ pid: 1, port: 8765, token: 'tok', startedAt: 'now', version: '1' });
    expect(readControlFile(storeDir)).toMatchObject({ port: 8765, token: 'tok' });
  });

  it('returns null on malformed JSON', () => {
    fs.writeFileSync(path.join(storeDir, 'control.json'), '{not json');
    expect(readControlFile(storeDir)).toBeNull();
  });
});

describe('pingServer', () => {
  it('returns null with no control file (no fetch attempted)', async () => {
    const result = await pingServer(storeDir);
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns the body and sends the token header when reachable', async () => {
    writeControl({ pid: 9, port: 8765, token: 'secret', startedAt: 's', version: '2' });
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true, pid: 9, version: '2' }));
    const result = await pingServer(storeDir);
    expect(result).toMatchObject({ ok: true, pid: 9 });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765/control/ping');
    expect(init.headers[CONTROL_TOKEN_HEADER]).toBe('secret');
  });

  it('returns null when the server is unreachable', async () => {
    writeControl({ pid: 9, port: 8765, token: 'secret', startedAt: 's', version: '2' });
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await pingServer(storeDir)).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    writeControl({ pid: 9, port: 8765, token: 'secret', startedAt: 's', version: '2' });
    global.fetch.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }));
    expect(await pingServer(storeDir)).toBeNull();
  });
});

describe('enqueueBackfill / cancelBackfill', () => {
  beforeEach(() => {
    writeControl({ pid: 9, port: 8765, token: 'secret', startedAt: 's', version: '2' });
  });

  it('POSTs to /control/backfill and returns the job descriptor', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { jobId: 7, channelId: '-100', status: 'pending' }));
    const result = await enqueueBackfill(storeDir, { chatId: '@c', depth: 50, minDate: '2026-01-01' });
    expect(result).toEqual({ jobId: 7, channelId: '-100', status: 'pending' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765/control/backfill');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ chatId: '@c', depth: 50, minDate: '2026-01-01' });
  });

  it('throws the server error message on a non-200 backfill response', async () => {
    global.fetch.mockResolvedValue(jsonResponse(400, { error: 'chatId is required' }));
    await expect(enqueueBackfill(storeDir, {})).rejects.toThrow('chatId is required');
  });

  it('POSTs to /control/cancel', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { canceled: 2, jobIds: [1, 2] }));
    const result = await cancelBackfill(storeDir, { chatId: '@c' });
    expect(result).toEqual({ canceled: 2, jobIds: [1, 2] });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765/control/cancel');
    expect(JSON.parse(init.body)).toEqual({ chatId: '@c', jobId: undefined });
  });
});

describe('invoke', () => {
  beforeEach(() => {
    writeControl({ pid: 9, port: 8765, token: 'secret', startedAt: 's', version: '2' });
  });

  it('POSTs { op, args } to /control/invoke and returns result', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { result: [{ id: '1' }] }));
    const result = await invoke(storeDir, { op: 'listChannels', args: { limit: 5 } });
    expect(result).toEqual([{ id: '1' }]);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8765/control/invoke');
    expect(init.method).toBe('POST');
    expect(init.headers[CONTROL_TOKEN_HEADER]).toBe('secret');
    expect(JSON.parse(init.body)).toEqual({ op: 'listChannels', args: { limit: 5 } });
  });

  it('throws the server error message on a non-200 response', async () => {
    global.fetch.mockResolvedValue(jsonResponse(400, { error: 'Unknown operation: nope' }));
    await expect(invoke(storeDir, { op: 'nope', args: {} })).rejects.toThrow('Unknown operation: nope');
  });
});

describe('ensureServer', () => {
  it('uses an existing server when ping succeeds (no spawn)', async () => {
    writeControl({ pid: 9, port: 8765, token: 'secret', startedAt: 's', version: '2' });
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true, pid: 9 }));
    const result = await ensureServer(storeDir, { idleExit: '60s' });
    expect(result).toMatchObject({ ok: true, pid: 9 });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns a detached server and polls until it becomes reachable', async () => {
    // First ping (pre-spawn) fails: no control file yet. After "spawn" we write
    // the control file and make subsequent pings succeed.
    let started = false;
    spawnMock.mockImplementation(() => {
      started = true;
      writeControl({ pid: 42, port: 8765, token: 'secret', startedAt: 's', version: '2' });
      return { unref: vi.fn() };
    });
    global.fetch.mockImplementation(() => {
      if (!started) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return Promise.resolve(jsonResponse(200, { ok: true, pid: 42 }));
    });

    const result = await ensureServer(storeDir, { idleExit: '60s' });
    expect(result).toMatchObject({ ok: true, pid: 42 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain('server');
    expect(args).toContain('--idle-exit');
    expect(args).toContain('60s');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('handles the race where another process started the server first', async () => {
    // No control file initially; "spawn" does nothing, but a concurrent process
    // wrote control.json before our first poll tick.
    spawnMock.mockImplementation(() => {
      writeControl({ pid: 99, port: 8765, token: 'secret', startedAt: 's', version: '2' });
      return { unref: vi.fn() };
    });
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true, pid: 99 }));
    const result = await ensureServer(storeDir, {});
    expect(result).toMatchObject({ ok: true, pid: 99 });
  });
});
