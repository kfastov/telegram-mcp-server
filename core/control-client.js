// Thin client over the always-on loopback control API (see core/control-server.js).
// The CLI is a one-shot process: it asks a long-lived server to execute backfill
// work rather than doing MTProto/SQLite writes itself. Every call here is a plain
// HTTP request to 127.0.0.1, authed with the token from <store>/control.json.
//
// We deliberately use Node's built-in global `fetch` (Node 18+) — no http.request
// hand-rolling — and reuse the server's existing control endpoints, so enqueue and
// cancel logic is never reimplemented client-side.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { CONTROL_FILE, CONTROL_TOKEN_HEADER } from './control-server.js';
import { SendCommandError } from './send-utils.js';

// Path to this package's CLI, used to (re)spawn `tgcli server`.
const CLI_ENTRYPOINT = fileURLToPath(new URL('../cli.js', import.meta.url));

const PING_TIMEOUT_MS = 1500;
const ENQUEUE_TIMEOUT_MS = 30000;
const SERVER_START_TIMEOUT_MS = 10000;
const SERVER_POLL_INTERVAL_MS = 250;

// Parse <store>/control.json, returning the descriptor or null when absent.
// Shape: { pid, port, token, startedAt, version }.
export function readControlFile(storeDir) {
  const filePath = path.join(storeDir, CONTROL_FILE);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function controlUrl(control, pathname) {
  return `http://127.0.0.1:${control.port}${pathname}`;
}

async function controlFetch(control, pathname, { method = 'GET', body, timeoutMs } = {}) {
  const headers = { [CONTROL_TOKEN_HEADER]: control.token };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const signal = Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(controlUrl(control, pathname), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// GET /control/ping. Returns the parsed body ({ ok, pid, version, startedAt, jobs })
// or null when no server is reachable (no control.json, refused connection, timeout,
// or a non-2xx response).
export async function pingServer(storeDir) {
  const control = readControlFile(storeDir);
  if (!control || !control.port || !control.token) {
    return null;
  }
  try {
    const { status, json } = await controlFetch(control, '/control/ping', {
      timeoutMs: PING_TIMEOUT_MS,
    });
    if (status === 200 && json?.ok) {
      return json;
    }
    return null;
  } catch {
    return null;
  }
}

// POST /control/backfill → { jobId, channelId, status }. Throws on a non-2xx
// response so the caller surfaces the server's error (e.g. unknown chat).
export async function enqueueBackfill(storeDir, { chatId, depth, minDate } = {}) {
  const control = readControlFile(storeDir);
  if (!control) {
    throw new Error('No control server is running. Start one with `tgcli server`.');
  }
  const { status, json } = await controlFetch(control, '/control/backfill', {
    method: 'POST',
    body: { chatId, depth, minDate },
    timeoutMs: ENQUEUE_TIMEOUT_MS,
  });
  if (status !== 200) {
    throw new Error(json?.error ?? `Backfill request failed (HTTP ${status})`);
  }
  return json;
}

// POST /control/cancel → { canceled, jobIds }. Throws on a non-2xx response.
export async function cancelBackfill(storeDir, { chatId, jobId } = {}) {
  const control = readControlFile(storeDir);
  if (!control) {
    throw new Error('No control server is running.');
  }
  const { status, json } = await controlFetch(control, '/control/cancel', {
    method: 'POST',
    body: { chatId, jobId },
    timeoutMs: ENQUEUE_TIMEOUT_MS,
  });
  if (status !== 200) {
    throw new Error(json?.error ?? `Cancel request failed (HTTP ${status})`);
  }
  return json;
}

// POST /control/retry → { updated, jobIds }. Resets the matching errored job(s)
// to pending on the server so its queue reprocesses them. Throws on a non-2xx
// response.
export async function retryBackfill(storeDir, { jobId, channelId, allErrors } = {}) {
  const control = readControlFile(storeDir);
  if (!control) {
    throw new Error('No control server is running. Start one with `tgcli server`.');
  }
  const { status, json } = await controlFetch(control, '/control/retry', {
    method: 'POST',
    body: { jobId, channelId, allErrors },
    timeoutMs: ENQUEUE_TIMEOUT_MS,
  });
  if (status !== 200) {
    throw new Error(json?.error ?? `Retry request failed (HTTP ${status})`);
  }
  return json;
}

// POST /control/invoke { op, args } → the operation's result. Runs the shared
// operation handler against the server's warm services and returns `result`.
// timeoutMs bounds the request wait (defaults to the enqueue budget); a value of
// 0 disables it. A send op that fails reports structured details under
// `sendError`, which we re-throw as a SendCommandError so the CLI renders the
// same human/JSON error as a local send would. Other non-2xx responses surface
// the server's error message.
export async function invoke(storeDir, { op, args, timeoutMs } = {}) {
  const control = readControlFile(storeDir);
  if (!control) {
    throw new Error('No control server is running.');
  }
  const effectiveTimeoutMs = timeoutMs === undefined ? ENQUEUE_TIMEOUT_MS : timeoutMs;
  const { status, json } = await controlFetch(control, '/control/invoke', {
    method: 'POST',
    body: { op, args },
    timeoutMs: effectiveTimeoutMs > 0 ? effectiveTimeoutMs : undefined,
  });
  if (status !== 200) {
    if (json?.sendError) {
      throw new SendCommandError(json.sendError);
    }
    throw new Error(json?.error ?? `Operation failed (HTTP ${status})`);
  }
  return json?.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Spawn `tgcli server --idle-exit <idleExit>` fully detached so it outlives this
// one-shot CLI process. We ignore its stdio and unref the child; the server writes
// its own control.json once it is listening.
function spawnDetachedServer(idleExit) {
  const child = spawn(process.execPath, [CLI_ENTRYPOINT, 'server', '--idle-exit', idleExit], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child;
}

// Ensure a control server is reachable, returning its ping body.
//   - If one is already up, use it (covers the race where another CLI invocation,
//     or the user's own `tgcli server`, started it first).
//   - Otherwise spawn a detached `tgcli server --idle-exit <idleExit>` and poll
//     pingServer for up to ~10s. The idle-exit window lets the auto-started server
//     shut itself down once the queue drains and nothing is being watched.
export async function ensureServer(storeDir, { idleExit = '60s' } = {}) {
  const existing = await pingServer(storeDir);
  if (existing) {
    return existing;
  }

  spawnDetachedServer(idleExit);

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SERVER_POLL_INTERVAL_MS);
    const ping = await pingServer(storeDir);
    if (ping) {
      return ping;
    }
  }
  throw new Error('Timed out waiting for the control server to start.');
}
