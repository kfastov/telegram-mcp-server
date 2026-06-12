// Regression coverage for archive-key canonicalization: enqueue-time
// canonicalization on /control/backfill, single-key convergence of live-written
// and backfilled rows, and sign-tolerant read/job lookups — all against a real
// MessageSyncService on a real sqlite store.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toggleChannelIdMark } from '@mtcute/core';

import MessageSyncService from '../message-sync-service.js';
import {
  createControlRequestHandler,
  CONTROL_TOKEN_HEADER,
} from '../core/control-server.js';

const TOKEN = 'test-token-abc123';
const GROUP_ID = '4701666782';
const CANONICAL_ID = `-${GROUP_ID}`;

function makeFakeTelegramClient(batches = []) {
  let call = 0;
  return {
    client: {
      resolvePeer: async () => ({ id: Number(CANONICAL_ID) }),
      iterHistory() {
        const batch = batches[call] ?? [];
        call += 1;
        return (async function* () {
          for (const message of batch) {
            yield message;
          }
        })();
      },
    },
    _serializeMessage(message) {
      return {
        id: message.id,
        date: message.date,
        from_id: message.from_id ?? null,
        text: message.text ?? `msg ${message.id}`,
      };
    },
  };
}

function seedChannel(service, channelId, { peerTitle = 'Group', peerType = 'chat', lastMessageId = null } = {}) {
  service.db.prepare(`
    INSERT INTO channels (channel_id, peer_title, peer_type, sync_enabled, last_message_id, updated_at)
    VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
  `).run(channelId, peerTitle, peerType, lastMessageId);
}

function seedMessage(service, channelId, { id, date, text }) {
  service.insertMessagesTx([
    service._buildMessageRecord(channelId, { id, date, text }),
  ]);
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

describe('peer canonicalization', () => {
  let storeDir;
  let service;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-canon-test-'));
  });

  afterEach(() => {
    if (service?.db?.open) {
      service.db.close();
    }
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  function makeService(batches = []) {
    service = new MessageSyncService(makeFakeTelegramClient(batches), {
      dbPath: path.join(storeDir, 'messages.db'),
      batchSize: 5,
      interJobDelayMs: 0,
      interBatchDelayMs: 0,
    });
    // The control handler kicks the queue after enqueue; keep the worker out
    // of these tests.
    service.processQueue = vi.fn();
    return service;
  }

  describe('POST /control/backfill enqueue-time canonicalization', () => {
    it('enqueues under the canonical key returned by canonicalizeChannelId', async () => {
      makeService();
      const canonicalizeChannelId = vi.fn(async () => CANONICAL_ID);
      const handler = createControlRequestHandler({
        service,
        warmServices: { telegramClient: { canonicalizeChannelId }, messageSyncService: service },
        token: TOKEN,
        pid: 1,
        version: '1',
        startedAt: 's',
        ensureLogin: vi.fn(() => Promise.resolve()),
      });
      const { server, port } = await startServer(handler);
      try {
        const { status, json } = await request(port, 'POST', '/control/backfill', {
          token: TOKEN,
          body: { chatId: GROUP_ID, depth: 50 },
        });

        expect(status).toBe(200);
        expect(canonicalizeChannelId).toHaveBeenCalledWith(GROUP_ID);
        expect(json.channelId).toBe(CANONICAL_ID);

        const jobKeys = service.db.prepare('SELECT DISTINCT channel_id FROM jobs').all()
          .map((row) => row.channel_id);
        expect(jobKeys).toEqual([CANONICAL_ID]);
      } finally {
        server.close();
      }
    });

    it('fails the enqueue with the resolution hint and persists nothing when canonicalization rejects', async () => {
      makeService();
      const canonicalizeChannelId = vi.fn(async () => {
        throw new Error(
          `Peer ${GROUP_ID} is not found in local cache — Group and channel ids are negative — `
          + `try --chat="-${GROUP_ID}"; list ids with \`tgcli channels list\``,
        );
      });
      const addJobSpy = vi.spyOn(service, 'addJob');
      const handler = createControlRequestHandler({
        service,
        warmServices: { telegramClient: { canonicalizeChannelId }, messageSyncService: service },
        token: TOKEN,
        pid: 1,
        version: '1',
        startedAt: 's',
        ensureLogin: vi.fn(() => Promise.resolve()),
      });
      const { server, port } = await startServer(handler);
      try {
        const { status, json } = await request(port, 'POST', '/control/backfill', {
          token: TOKEN,
          body: { chatId: GROUP_ID },
        });

        expect(status).toBe(500);
        expect(json.error).toContain(`--chat="-${GROUP_ID}"`);
        expect(addJobSpy).not.toHaveBeenCalled();

        const channelRows = service.db.prepare(
          "SELECT COUNT(*) AS cnt FROM channels WHERE channel_id LIKE ?",
        ).get(`%${GROUP_ID}`);
        expect(channelRows.cnt).toBe(0);
        const jobRows = service.db.prepare('SELECT COUNT(*) AS cnt FROM jobs').get();
        expect(jobRows.cnt).toBe(0);
      } finally {
        server.close();
      }
    });
  });

  describe('archive-key convergence (live writer + backfill)', () => {
    it('keeps live-written and backfilled rows under one canonical key', async () => {
      const baseDate = 2_000_000;
      makeService([
        [
          { id: 199, date: baseDate - 199, text: 'older 199' },
          { id: 198, date: baseDate - 198, text: 'older 198' },
        ],
      ]);

      // Live writer state: a real channels row plus a message keyed by the
      // marked id, exactly what realtime sync produces.
      seedChannel(service, CANONICAL_ID, { lastMessageId: 200 });
      seedMessage(service, CANONICAL_ID, { id: 200, date: baseDate - 200, text: 'live row' });

      // Backfill enqueued under the canonical key (as the control server now
      // guarantees) backfills under the same key.
      const job = service.addJob(CANONICAL_ID, { depth: 3 });
      const result = await service._backfillHistory(job, 1, 3);
      expect(result.insertedCount).toBe(2);

      const messageKeys = service.db.prepare('SELECT DISTINCT channel_id FROM messages').all()
        .map((row) => row.channel_id);
      expect(messageKeys).toEqual([CANONICAL_ID]);

      const channelKeys = service.db.prepare(
        'SELECT channel_id FROM channels WHERE channel_id LIKE ?',
      ).all(`%${GROUP_ID}`).map((row) => row.channel_id);
      expect(channelKeys).toEqual([CANONICAL_ID]);
    });
  });

  describe('read-side key disambiguation', () => {
    it('routes positive-id reads to the negative key holding the data', () => {
      makeService();
      seedChannel(service, CANONICAL_ID);
      seedMessage(service, CANONICAL_ID, { id: 99, date: 1700000000, text: 'context before' });
      seedMessage(service, CANONICAL_ID, { id: 100, date: 1700000100, text: 'hello world' });
      seedMessage(service, CANONICAL_ID, { id: 101, date: 1700000200, text: 'context after' });

      expect(service.getChannel(GROUP_ID)?.channelId).toBe(CANONICAL_ID);
      expect(service.getChannelMetadata(GROUP_ID)?.channelId).toBe(CANONICAL_ID);

      const listed = service.listArchivedMessages({ channelIds: [GROUP_ID] });
      expect(listed).toHaveLength(3);
      expect(listed[0].channelId).toBe(CANONICAL_ID);

      const searched = service.searchArchiveMessages({ query: 'hello', channelIds: [GROUP_ID] });
      expect(searched).toHaveLength(1);
      expect(searched[0].messageId).toBe(100);

      const single = service.getArchivedMessage({ channelId: GROUP_ID, messageId: 100 });
      expect(single?.channelId).toBe(CANONICAL_ID);

      const context = service.getArchivedMessageContext({ channelId: GROUP_ID, messageId: 100 });
      expect(context.target?.messageId).toBe(100);
      expect(context.before).toHaveLength(1);
      expect(context.after).toHaveLength(1);
    });

    it('ignores a phantom positive-key channels row (no metadata, no messages)', () => {
      makeService();
      seedChannel(service, CANONICAL_ID);
      seedMessage(service, CANONICAL_ID, { id: 100, date: 1700000100, text: 'real data' });
      // Bare row left behind by an old failed positive-id enqueue: NULL
      // peer_title/peer_type and no messages must not pin the positive key.
      service.db.prepare(
        'INSERT INTO channels (channel_id, updated_at) VALUES (?, CURRENT_TIMESTAMP)',
      ).run(GROUP_ID);

      expect(service.getChannel(GROUP_ID)?.channelId).toBe(CANONICAL_ID);
      expect(service.getArchivedMessage({ channelId: GROUP_ID, messageId: 100 })?.channelId)
        .toBe(CANONICAL_ID);
    });

    it('does not reroute a positive key that holds real data (user DM)', () => {
      makeService();
      seedChannel(service, '555', { peerTitle: 'Alice', peerType: 'user' });
      seedMessage(service, '555', { id: 7, date: 1700000000, text: 'dm text' });

      expect(service.getChannel('555')?.channelId).toBe('555');
      const listed = service.listArchivedMessages({ channelIds: ['555'] });
      expect(listed).toHaveLength(1);
      expect(listed[0].channelId).toBe('555');
    });

    it('finds marked supergroup (-100...) data from the bare positive id', () => {
      makeService();
      const bareId = 888999777;
      const markedKey = String(toggleChannelIdMark(bareId));
      seedChannel(service, markedKey, { peerTitle: 'Supergroup', peerType: 'channel' });
      seedMessage(service, markedKey, { id: 12, date: 1700000000, text: 'super' });

      expect(service.getChannel(String(bareId))?.channelId).toBe(markedKey);
      expect(service.getArchivedMessage({ channelId: String(bareId), messageId: 12 })?.channelId)
        .toBe(markedKey);
    });
  });

  describe('job-key disambiguation', () => {
    it('listJobs/retryJobs/cancelJobs match canonical-keyed jobs from the positive id', () => {
      makeService();
      const job = service.addJob(CANONICAL_ID, { depth: 10 });

      const listed = service.listJobs({ channelId: GROUP_ID });
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(job.id);

      const retried = service.retryJobs({ channelId: GROUP_ID });
      expect(retried.updated).toBe(1);
      expect(retried.jobIds).toEqual([job.id]);

      const canceled = service.cancelJobs({ channelId: GROUP_ID });
      expect(canceled.canceled).toBe(1);
      expect(canceled.jobIds).toEqual([job.id]);
    });
  });
});
