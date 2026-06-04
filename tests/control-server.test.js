import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createControlRequestHandler,
  CONTROL_TOKEN_HEADER,
} from '../core/control-server.js';
import { OPERATIONS } from '../core/operations.js';

const TOKEN = 'test-token-abc123';

function makeService(overrides = {}) {
  return {
    getJobCounts: vi.fn(() => ({ pending: 1, inProgress: 2 })),
    addJob: vi.fn((chatId, opts) => ({
      id: 42,
      channel_id: String(chatId),
      status: 'pending',
      ...opts,
    })),
    processQueue: vi.fn(() => Promise.resolve()),
    cancelJobs: vi.fn(() => ({ canceled: 1, jobIds: [42] })),
    retryJobs: vi.fn(() => ({ updated: 1, jobIds: [42] })),
    ...overrides,
  };
}

function startServer(handler) {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function request(port, method, pathname, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) {
    headers[CONTROL_TOKEN_HEADER] = token;
  }
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe('control API request handler', () => {
  let service;
  let onActivity;
  let server;
  let port;

  beforeEach(async () => {
    service = makeService();
    onActivity = vi.fn();
    const handler = createControlRequestHandler({
      service,
      token: TOKEN,
      pid: 12345,
      version: '9.9.9',
      startedAt: '2026-06-02T00:00:00.000Z',
      onActivity,
      ensureLogin: vi.fn(() => Promise.resolve()),
    });
    ({ server, port } = await startServer(handler));
  });

  afterEach(() => {
    server.close();
  });

  it('GET /control/ping returns ok with job counts', async () => {
    const { status, json } = await request(port, 'GET', '/control/ping', { token: TOKEN });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      pid: 12345,
      version: '9.9.9',
      startedAt: '2026-06-02T00:00:00.000Z',
      jobs: { pending: 1, inProgress: 2 },
    });
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it('POST /control/backfill enqueues via addJob and kicks the queue', async () => {
    const { status, json } = await request(port, 'POST', '/control/backfill', {
      token: TOKEN,
      body: { chatId: '777', depth: 500, minDate: '2026-01-01T00:00:00.000Z' },
    });
    expect(status).toBe(200);
    expect(service.addJob).toHaveBeenCalledWith('777', {
      depth: 500,
      minDate: '2026-01-01T00:00:00.000Z',
    });
    expect(service.processQueue).toHaveBeenCalledTimes(1);
    expect(json).toEqual({ jobId: 42, channelId: '777', status: 'pending' });
  });

  it('POST /control/backfill requires chatId', async () => {
    const { status } = await request(port, 'POST', '/control/backfill', {
      token: TOKEN,
      body: {},
    });
    expect(status).toBe(400);
    expect(service.addJob).not.toHaveBeenCalled();
  });

  it('POST /control/cancel cancels via cancelJobs', async () => {
    const { status, json } = await request(port, 'POST', '/control/cancel', {
      token: TOKEN,
      body: { chatId: '777' },
    });
    expect(status).toBe(200);
    expect(service.cancelJobs).toHaveBeenCalledWith({ channelId: '777', jobId: undefined });
    expect(json).toEqual({ canceled: 1, jobIds: [42] });
  });

  it('POST /control/cancel accepts jobId', async () => {
    const { status } = await request(port, 'POST', '/control/cancel', {
      token: TOKEN,
      body: { jobId: 42 },
    });
    expect(status).toBe(200);
    expect(service.cancelJobs).toHaveBeenCalledWith({ channelId: undefined, jobId: 42 });
  });

  it('POST /control/cancel requires chatId or jobId', async () => {
    const { status } = await request(port, 'POST', '/control/cancel', {
      token: TOKEN,
      body: {},
    });
    expect(status).toBe(400);
    expect(service.cancelJobs).not.toHaveBeenCalled();
  });

  it('POST /control/retry resets via retryJobs and kicks the queue', async () => {
    const { status, json } = await request(port, 'POST', '/control/retry', {
      token: TOKEN,
      body: { channelId: '777' },
    });
    expect(status).toBe(200);
    expect(service.retryJobs).toHaveBeenCalledWith({
      jobId: undefined,
      channelId: '777',
      allErrors: false,
    });
    expect(service.processQueue).toHaveBeenCalledTimes(1);
    expect(json).toEqual({ updated: 1, jobIds: [42] });
  });

  it('POST /control/retry accepts allErrors', async () => {
    const { status } = await request(port, 'POST', '/control/retry', {
      token: TOKEN,
      body: { allErrors: true },
    });
    expect(status).toBe(200);
    expect(service.retryJobs).toHaveBeenCalledWith({
      jobId: undefined,
      channelId: undefined,
      allErrors: true,
    });
  });

  it('POST /control/retry does not kick the queue when nothing was reset', async () => {
    service.retryJobs.mockReturnValueOnce({ updated: 0, jobIds: [] });
    const { status } = await request(port, 'POST', '/control/retry', {
      token: TOKEN,
      body: { jobId: 99 },
    });
    expect(status).toBe(200);
    expect(service.processQueue).not.toHaveBeenCalled();
  });

  it('POST /control/retry requires jobId, channelId, or allErrors', async () => {
    const { status } = await request(port, 'POST', '/control/retry', {
      token: TOKEN,
      body: {},
    });
    expect(status).toBe(400);
    expect(service.retryJobs).not.toHaveBeenCalled();
  });

  it('rejects requests with a missing token', async () => {
    const { status, json } = await request(port, 'GET', '/control/ping');
    expect(status).toBe(401);
    expect(json).toEqual({ error: 'Unauthorized' });
    expect(service.getJobCounts).not.toHaveBeenCalled();
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('rejects requests with a wrong token', async () => {
    const { status } = await request(port, 'GET', '/control/ping', { token: 'nope' });
    expect(status).toBe(401);
    expect(service.getJobCounts).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown control paths', async () => {
    const { status } = await request(port, 'GET', '/control/unknown', { token: TOKEN });
    expect(status).toBe(404);
  });

  it('returns 404 for non-control paths', async () => {
    const { status } = await request(port, 'GET', '/something-else', { token: TOKEN });
    expect(status).toBe(404);
  });
});

describe('POST /control/invoke', () => {
  let warmServices;
  let ensureLogin;
  let server;
  let port;

  beforeEach(async () => {
    warmServices = {
      telegramClient: {
        listDialogs: vi.fn(() => Promise.resolve([{ id: '1', title: 'Warm' }])),
        searchDialogs: vi.fn(() => Promise.resolve([])),
        getGroupInviteLink: vi.fn(() => Promise.resolve({ link: 'https://t.me/+warm' })),
      },
      messageSyncService: {
        setChannelSync: vi.fn(() => ({ channel_id: '@g', sync_enabled: 1 })),
        listJobs: vi.fn(() => []),
        addJob: vi.fn(() => ({ id: 5, status: 'pending' })),
        processQueue: vi.fn(),
      },
    };
    ensureLogin = vi.fn(() => Promise.resolve());
    const handler = createControlRequestHandler({
      service: makeService(),
      warmServices,
      token: TOKEN,
      pid: 1,
      version: '1',
      startedAt: 's',
      ensureLogin,
    });
    ({ server, port } = await startServer(handler));
  });

  afterEach(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it('runs a known op against the warm services and returns its result', async () => {
    const spy = vi.spyOn(OPERATIONS, 'listChannels');
    const { status, json } = await request(port, 'POST', '/control/invoke', {
      token: TOKEN,
      body: { op: 'listChannels', args: { limit: 10 } },
    });
    expect(status).toBe(200);
    expect(spy).toHaveBeenCalledWith(warmServices, { limit: 10 });
    expect(warmServices.telegramClient.listDialogs).toHaveBeenCalledWith(10);
    expect(json).toEqual({ result: [{ id: '1', title: 'Warm' }] });
    expect(ensureLogin).toHaveBeenCalledTimes(1);
  });

  it('dispatches a write op (channelSetSync) against the warm services', async () => {
    const { status, json } = await request(port, 'POST', '/control/invoke', {
      token: TOKEN,
      body: { op: 'channelSetSync', args: { chat: '@g', enable: true } },
    });
    expect(status).toBe(200);
    expect(warmServices.messageSyncService.setChannelSync).toHaveBeenCalledWith('@g', true);
    expect(warmServices.messageSyncService.addJob).toHaveBeenCalledWith('@g');
    expect(json.result).toMatchObject({ channelId: '@g', syncEnabled: true, jobId: 5, jobQueued: true });
    expect(ensureLogin).toHaveBeenCalledTimes(1);
  });

  it('returns 500 with a sendError payload when a send op fails', async () => {
    warmServices.telegramClient.sendTextMessage = vi.fn(() => Promise.reject(new Error('FLOOD_WAIT_120')));
    const { status, json } = await request(port, 'POST', '/control/invoke', {
      token: TOKEN,
      body: { op: 'sendText', args: { chat: '@g', text: 'hi', retries: 0, timeoutMs: 30000 } },
    });
    expect(status).toBe(500);
    expect(json.sendError).toMatchObject({ type: 'rate_limit', method: 'sendText', waitSeconds: 120 });
  });

  it('returns 400 for an unknown op (no handler invoked)', async () => {
    const { status, json } = await request(port, 'POST', '/control/invoke', {
      token: TOKEN,
      body: { op: 'doesNotExist', args: {} },
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Unknown operation/);
    expect(ensureLogin).not.toHaveBeenCalled();
  });

  it('rejects an invoke without a token', async () => {
    const { status } = await request(port, 'POST', '/control/invoke', {
      body: { op: 'listChannels', args: {} },
    });
    expect(status).toBe(401);
    expect(warmServices.telegramClient.listDialogs).not.toHaveBeenCalled();
  });
});
