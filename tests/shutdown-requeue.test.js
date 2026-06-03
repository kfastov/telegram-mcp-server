import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import MessageSyncService from '../message-sync-service.js';

// Regression coverage for #42: only the queue worker may requeue in_progress
// jobs, and only the one it actually owns. Every non-worker teardown goes through
// close(), which must never touch the `jobs` table — otherwise a read-only
// command run against a live server's store would reset the server's in-flight
// job to pending and corrupt its state.

// Minimal fake client: close()/shutdown() only ever touch onNewMessage/etc. when
// realtime handlers are registered, which these tests never do.
function makeFakeClient() {
  return {
    client: {
      onNewMessage: { add() {}, remove() {} },
      onEditMessage: { add() {}, remove() {} },
      onDeleteMessage: { add() {}, remove() {} },
    },
  };
}

function newService(storeDir) {
  return new MessageSyncService(makeFakeClient(), {
    dbPath: path.join(storeDir, 'messages.db'),
    batchSize: 5,
    interJobDelayMs: 0,
    interBatchDelayMs: 0,
  });
}

// Insert a job row directly in a chosen status (channel_id is UNIQUE).
function seedJob(service, channelId, status) {
  const info = service.db.prepare(`
    INSERT INTO jobs (channel_id, status, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(String(channelId), status);
  return Number(info.lastInsertRowid);
}

function statusOf(service, id) {
  return service.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id)?.status;
}

describe('teardown responsibility separation (#42)', () => {
  let storeDir;
  let service;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-shutdown-test-'));
  });

  afterEach(() => {
    if (service?.db?.open) {
      service.db.close();
    }
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('close() does not reset an in_progress job (non-worker teardown)', () => {
    service = newService(storeDir);
    const jobId = seedJob(service, '100', 'in_progress');

    service.close();

    // Reopen the DB to read what was persisted: close() closed the handle.
    const reopened = newService(storeDir);
    expect(statusOf(reopened, jobId)).toBe('in_progress');
    reopened.db.close();
    service = null;
  });

  it('close() closes the DB handle without touching jobs', () => {
    service = newService(storeDir);
    seedJob(service, '100', 'in_progress');

    expect(service.db.open).toBe(true);
    service.close();
    expect(service.db.open).toBe(false);
  });

  it('shutdown() requeues only the job this instance owns', async () => {
    service = newService(storeDir);
    const ownedId = seedJob(service, '100', 'in_progress');
    const otherId = seedJob(service, '200', 'in_progress');

    // Simulate the worker having claimed `ownedId` as its in-flight job.
    service.ownedInProgressJobId = ownedId;

    await service.shutdown();

    const reopened = newService(storeDir);
    // The owned job is requeued so the worker resumes it next run...
    expect(statusOf(reopened, ownedId)).toBe('pending');
    // ...but the in_progress job owned by another process is left untouched.
    expect(statusOf(reopened, otherId)).toBe('in_progress');
    reopened.db.close();
    service = null;
  });

  it('shutdown() with no owned job leaves every in_progress row untouched', async () => {
    service = newService(storeDir);
    const a = seedJob(service, '100', 'in_progress');
    const b = seedJob(service, '200', 'in_progress');

    // ownedInProgressJobId starts null: this instance never ran the queue.
    await service.shutdown();

    const reopened = newService(storeDir);
    expect(statusOf(reopened, a)).toBe('in_progress');
    expect(statusOf(reopened, b)).toBe('in_progress');
    reopened.db.close();
    service = null;
  });

  it('shutdown() clears ownership after requeuing (idempotent)', async () => {
    service = newService(storeDir);
    const ownedId = seedJob(service, '100', 'in_progress');
    service.ownedInProgressJobId = ownedId;

    await service.shutdown();
    expect(service.ownedInProgressJobId).toBeNull();
  });
});

describe('worker job ownership lifecycle (#42)', () => {
  let storeDir;
  let service;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ownership-test-'));
    service = newService(storeDir);
  });

  afterEach(() => {
    if (service?.db?.open) {
      service.db.close();
    }
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('_processJob claims ownership while running and releases it on completion', async () => {
    const jobId = seedJob(service, '100', 'pending');
    const job = service.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

    // Stub the heavy sync/backfill steps so the job reaches a terminal status
    // without any network. We assert ownership is set the moment the job goes
    // in_progress, then cleared once _processJob writes its terminal status.
    let ownedDuringSync = null;
    service._syncNewerMessages = async () => {
      ownedDuringSync = service.ownedInProgressJobId;
      return { stoppedEarly: false };
    };
    service._countMessages = () => 0;
    service._backfillHistory = async () => ({
      stoppedEarly: false,
      hasMoreOlder: false,
      finalCount: 0,
      cursorMessageId: null,
      cursorMessageDate: null,
    });

    await service._processJob(job);

    // Ownership was held for the duration of the job...
    expect(ownedDuringSync).toBe(jobId);
    // ...and released once the job reached its terminal (idle) status.
    expect(service.ownedInProgressJobId).toBeNull();
    expect(statusOf(service, jobId)).toBe('idle');
  });
});
