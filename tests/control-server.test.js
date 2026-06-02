import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createControlRequestHandler,
  CONTROL_TOKEN_HEADER,
} from '../core/control-server.js';

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
