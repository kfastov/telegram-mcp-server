// Cold-start readiness: the control listener must be reachable (control.json
// written, GET /control/ping succeeds) BEFORE the Telegram connection resolves,
// so a thin client polling for the server does not give up while a large account
// is still connecting. Operations, by contrast, await the shared connect via the
// ensureLogin hook each control handler runs before touching MTProto.
//
// This mirrors the server wiring (listener up first, connect kicked off in the
// background) without bootstrapping the full mcp-server entrypoint: the listener,
// control.json, ping path, and ensureLogin hook are the real components.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createControlRequestHandler,
  generateControlToken,
  writeControlFile,
  CONTROL_TOKEN_HEADER,
} from '../core/control-server.js';
import { pingServer, readControlFile } from '../core/control-client.js';

let storeDir;
let server;

function makeService() {
  return {
    getJobCounts: vi.fn(() => ({ pending: 0, inProgress: 0 })),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Start the listener exactly as the server does: bind, then write control.json in
// the listen callback. Returns once control.json is on disk.
function startControl(handler, token) {
  server = http.createServer((req, res) => void handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      writeControlFile(storeDir, { pid: process.pid, port, token, startedAt: 's', version: '1' });
      resolve(port);
    });
  });
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-cold-start-'));
});

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
  fs.rmSync(storeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('control server reachable before Telegram connect resolves', () => {
  it('writes control.json and answers ping while the connect is still pending', async () => {
    const token = generateControlToken();
    // A slow connect that never resolves on its own; the ensureLogin hook awaits it.
    const connect = deferred();
    const ensureLogin = vi.fn(() => connect.promise);

    const warmServices = {
      telegramClient: { listDialogs: vi.fn(() => Promise.resolve([{ id: '1', title: 'Warm' }])) },
      messageSyncService: {},
    };

    const handler = createControlRequestHandler({
      service: makeService(),
      warmServices,
      token,
      pid: process.pid,
      version: '1',
      startedAt: 's',
      ensureLogin,
    });

    await startControl(handler, token);

    // control.json exists and ping succeeds even though the connect has not
    // resolved (ensureLogin still pending) — the readiness probe does not pay the
    // connect cost.
    expect(readControlFile(storeDir)).toMatchObject({ token });
    const ping = await pingServer(storeDir);
    expect(ping).toMatchObject({ ok: true });
    expect(ensureLogin).not.toHaveBeenCalled();

    // An operation awaits the connect: it must not complete while the connect is
    // pending.
    const control = readControlFile(storeDir);
    let opSettled = false;
    const opPromise = fetch(`http://127.0.0.1:${control.port}/control/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
      body: JSON.stringify({ op: 'listChannels', args: { limit: 1 } }),
    }).then(async (res) => {
      opSettled = true;
      return { status: res.status, json: await res.json() };
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(ensureLogin).toHaveBeenCalledTimes(1);
    expect(opSettled).toBe(false);
    expect(warmServices.telegramClient.listDialogs).not.toHaveBeenCalled();

    // Ping still works while the op is blocked on the connect.
    expect(await pingServer(storeDir)).toMatchObject({ ok: true });

    // Once the connect resolves, the op runs against the warm services.
    connect.resolve();
    const { status, json } = await opPromise;
    expect(status).toBe(200);
    expect(json).toEqual({ result: [{ id: '1', title: 'Warm' }] });
    expect(warmServices.telegramClient.listDialogs).toHaveBeenCalledWith(1);
  });
});
