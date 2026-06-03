import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import MessageSyncService from '../message-sync-service.js';

const CHANNEL_ID = '1001';

// Build a fake telegram client whose iterHistory yields a fresh batch of
// messages each call (older message IDs each time), so _backfillHistory makes
// several passes and we can observe per-batch progress.
function makeFakeClient(batches) {
  let call = 0;
  return {
    client: {
      resolvePeer: async () => ({ id: Number(CHANNEL_ID) }),
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
    // _backfillHistory serializes each yielded message through the client.
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

function buildBatch(startId, count, baseDate) {
  const batch = [];
  for (let i = 0; i < count; i += 1) {
    const id = startId - i;
    batch.push({ id, date: baseDate - id, text: `message ${id}` });
  }
  return batch;
}

describe('per-batch backfill progress persistence', () => {
  let storeDir;
  let service;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-progress-test-'));
  });

  afterEach(async () => {
    if (service?.db?.open) {
      service.db.close();
    }
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('adds a started_at column to the jobs table', () => {
    service = new MessageSyncService(makeFakeClient([]), {
      dbPath: path.join(storeDir, 'messages.db'),
      batchSize: 5,
      interJobDelayMs: 0,
      interBatchDelayMs: 0,
    });
    const columns = service.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    expect(columns).toContain('started_at');
  });

  it('advances message_count, updated_at, and started_at every batch', async () => {
    const baseDate = 2_000_000;
    // 3 batches of 5 messages each, descending IDs.
    const batches = [
      buildBatch(100, 5, baseDate),
      buildBatch(95, 5, baseDate),
      buildBatch(90, 5, baseDate),
    ];

    service = new MessageSyncService(makeFakeClient(batches), {
      dbPath: path.join(storeDir, 'messages.db'),
      batchSize: 5,
      interJobDelayMs: 0,
      interBatchDelayMs: 0,
    });

    // Seed the channel row so _getChannel / cursor updates work.
    service.db.prepare(`
      INSERT INTO channels (channel_id, sync_enabled, last_message_id, updated_at)
      VALUES (?, 1, 200, CURRENT_TIMESTAMP)
    `).run(CHANNEL_ID);

    const job = service.addJob(CHANNEL_ID, { depth: 15 });
    expect(job.message_count).toBe(0);

    const snapshots = [];
    const original = service._updateJobProgress.bind(service);
    // Capture the persisted job row right after each per-batch progress write.
    service._updateJobProgress = (id, payload) => {
      original(id, payload);
      const row = service.db.prepare('SELECT message_count, updated_at, started_at FROM jobs WHERE id = ?').get(id);
      snapshots.push(row);
    };

    const result = await service._backfillHistory(job, 0, 15);

    // Three batches => three progress writes.
    expect(snapshots.length).toBe(3);

    // message_count is live and strictly increases across batches.
    expect(snapshots[0].message_count).toBe(5);
    expect(snapshots[1].message_count).toBe(10);
    expect(snapshots[2].message_count).toBe(15);

    // started_at is stamped on the first batch and stays set thereafter.
    expect(snapshots[0].started_at).toBeTruthy();
    expect(snapshots[1].started_at).toBe(snapshots[0].started_at);

    // The final terminal count matches.
    expect(result.finalCount).toBe(15);

    // The persisted job row reflects the last live progress write.
    const finalRow = service.db.prepare('SELECT message_count, started_at FROM jobs WHERE id = ?').get(job.id);
    expect(finalRow.message_count).toBe(15);
    expect(finalRow.started_at).toBeTruthy();
  });
});

describe('job-count and watched-channel helpers', () => {
  let storeDir;
  let service;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-counts-test-'));
    service = new MessageSyncService(makeFakeClient([]), {
      dbPath: path.join(storeDir, 'messages.db'),
      batchSize: 5,
      interJobDelayMs: 0,
      interBatchDelayMs: 0,
    });
  });

  afterEach(() => {
    if (service?.db?.open) {
      service.db.close();
    }
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('getJobCounts reports pending and inProgress', () => {
    expect(service.getJobCounts()).toEqual({ pending: 0, inProgress: 0 });

    service.db.prepare(`
      INSERT INTO channels (channel_id, sync_enabled, updated_at) VALUES ('5', 1, CURRENT_TIMESTAMP)
    `).run();
    service.addJob('5');
    expect(service.getJobCounts()).toEqual({ pending: 1, inProgress: 0 });
  });

  it('getWatchedChannelCount counts channels with sync_enabled = 1', () => {
    expect(service.getWatchedChannelCount()).toBe(0);

    service.db.prepare(`
      INSERT INTO channels (channel_id, sync_enabled, updated_at) VALUES ('5', 1, CURRENT_TIMESTAMP)
    `).run();
    service.db.prepare(`
      INSERT INTO channels (channel_id, sync_enabled, updated_at) VALUES ('6', 0, CURRENT_TIMESTAMP)
    `).run();
    expect(service.getWatchedChannelCount()).toBe(1);
  });
});
