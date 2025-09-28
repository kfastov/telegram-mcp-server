import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { normalizeChannelId } from './telegram-client.js';

const DEFAULT_DB_PATH = './data/messages.db';
const DEFAULT_TARGET_MESSAGES = 1000;
const JOB_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  IDLE: 'idle',
  ERROR: 'error',
};

export default class MessageSyncService {
  constructor(telegramClient, options = {}) {
    this.telegramClient = telegramClient;
    this.dbPath = path.resolve(options.dbPath || DEFAULT_DB_PATH);
    this.batchSize = options.batchSize || 100;
    this.interJobDelayMs = options.interJobDelayMs || 3000;
    this.interBatchDelayMs = options.interBatchDelayMs || 1000;
    this.processing = false;
    this.stopRequested = false;

    this._initDatabase();
  }

  _initDatabase() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL UNIQUE,
        peer_title TEXT,
        peer_type TEXT,
        status TEXT NOT NULL DEFAULT '${JOB_STATUS.PENDING}',
        last_message_id INTEGER DEFAULT 0,
        oldest_message_id INTEGER,
        target_message_count INTEGER DEFAULT ${DEFAULT_TARGET_MESSAGES},
        message_count INTEGER DEFAULT 0,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error TEXT
      );
    `);

    this._ensureJobColumn('oldest_message_id', 'INTEGER');
    this._ensureJobColumn('target_message_count', `INTEGER DEFAULT ${DEFAULT_TARGET_MESSAGES}`);
    this._ensureJobColumn('message_count', 'INTEGER DEFAULT 0');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        date INTEGER,
        from_id TEXT,
        text TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(channel_id, message_id)
      );
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (channel_id, message_id, date, from_id, text, raw_json)
      VALUES (@channel_id, @message_id, @date, @from_id, @text, @raw_json)
    `);

    this.insertMessagesTx = this.db.transaction((records) => {
      for (const record of records) {
        this.insertMessageStmt.run(record);
      }
    });
  }

  _ensureJobColumn(column, definition) {
    const existing = this.db.prepare("PRAGMA table_info(jobs)").all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
    }
  }

  addJob(channelId, options = {}) {
    const normalizedId = String(normalizeChannelId(channelId));
    const target = options.depth && options.depth > 0 ? Number(options.depth) : DEFAULT_TARGET_MESSAGES;
    const stmt = this.db.prepare(`
      INSERT INTO jobs (channel_id, status, error, target_message_count, updated_at)
      VALUES (?, '${JOB_STATUS.PENDING}', NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        status='${JOB_STATUS.PENDING}',
        error=NULL,
        target_message_count=?,
        updated_at=CURRENT_TIMESTAMP
      RETURNING *;
    `);

    return stmt.get(normalizedId, target, target);
  }

  listJobs() {
    return this.db.prepare(`
      SELECT id, channel_id, peer_title, peer_type, status, last_message_id, oldest_message_id, target_message_count, message_count, last_synced_at, created_at, updated_at, error
      FROM jobs
      ORDER BY updated_at DESC
    `).all();
  }

  async processQueue() {
    if (this.processing) {
      return;
    }
    if (this.stopRequested) {
      return;
    }
    this.processing = true;
    try {
      while (true) {
        if (this.stopRequested) {
          break;
        }
        const job = this._getNextJob();
        if (!job) {
          break;
        }
        await this._processJob(job);
        await delay(this.interJobDelayMs);
      }
    } finally {
      this.processing = false;
    }
  }

  resumePendingJobs() {
    void this.processQueue();
  }

  async shutdown() {
    this.stopRequested = true;

    while (this.processing) {
      await delay(100);
    }

    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  _getNextJob() {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('${JOB_STATUS.PENDING}', '${JOB_STATUS.IN_PROGRESS}')
      ORDER BY updated_at ASC
      LIMIT 1
    `).get();
  }

  searchMessages({ channelId, pattern, limit = 50, caseInsensitive = true }) {
    const normalizedId = String(normalizeChannelId(channelId));
    const flags = caseInsensitive ? "i" : "";
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Invalid pattern: ${error.message}`);
    }

    const rows = this.db.prepare(`
      SELECT message_id, date, from_id, text
      FROM messages
      WHERE channel_id = ?
      ORDER BY message_id DESC
    `).all(normalizedId);

    const matches = [];
    for (const row of rows) {
      const text = row.text || "";
      if (regex.test(text)) {
        matches.push({
          messageId: row.message_id,
          date: row.date ? new Date(row.date * 1000).toISOString() : null,
          fromId: row.from_id,
          text,
        });
        if (matches.length >= limit) {
          break;
        }
      }
    }

    return matches;
  }

  getMessageStats(channelId) {
    const normalizedId = String(normalizeChannelId(channelId));
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        MIN(message_id) AS oldestMessageId,
        MAX(message_id) AS newestMessageId,
        MIN(date) AS oldestDate,
        MAX(date) AS newestDate
      FROM messages
      WHERE channel_id = ?
    `).get(normalizedId);

    return {
      total: summary.total || 0,
      oldestMessageId: summary.oldestMessageId || null,
      newestMessageId: summary.newestMessageId || null,
      oldestDate: summary.oldestDate ? new Date(summary.oldestDate * 1000).toISOString() : null,
      newestDate: summary.newestDate ? new Date(summary.newestDate * 1000).toISOString() : null,
    };
  }

  async _processJob(job) {
    this._updateJobStatus(job.id, JOB_STATUS.IN_PROGRESS);

    try {
      const newerDetails = await this._syncNewerMessages(job);

      const backfillResult = await this._backfillHistory(
        job,
        newerDetails.totalMessages,
        newerDetails.targetCount,
        newerDetails.lastMessageId,
      );

      const finalCount = backfillResult.finalCount;
      const finalOldest = backfillResult.oldestMessageId ?? newerDetails.oldestMessageId ?? job.oldest_message_id;
      const finalLatest = newerDetails.lastMessageId ?? job.last_message_id ?? 0;

      const shouldContinue =
        newerDetails.hasMoreNewer ||
        backfillResult.hasMoreOlder;

      const finalStatus = shouldContinue ? JOB_STATUS.PENDING : JOB_STATUS.IDLE;

      this._updateJobRecord(job.id, {
        status: finalStatus,
        peerTitle: newerDetails.peerTitle,
        peerType: newerDetails.peerType,
        lastMessageId: finalLatest,
        oldestMessageId: finalOldest,
        messageCount: finalCount,
        targetCount: newerDetails.targetCount,
      });
    } catch (error) {
      const waitMatch = /wait of (\d+) seconds is required/i.exec(error.message || "");
      if (waitMatch) {
        const waitSeconds = Number(waitMatch[1]);
        this.db.prepare(`
          UPDATE jobs
          SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(JOB_STATUS.PENDING, `Rate limited, waiting ${waitSeconds}s`, job.id);
        await delay(waitSeconds * 1000);
      } else {
        this._markJobError(job.id, error);
      }
    }
  }

  _updateJobStatus(id, status) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
  }

  _updateJobRecord(id, {
    status,
    peerTitle,
    peerType,
    lastMessageId,
    oldestMessageId,
    messageCount,
    targetCount,
  }) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?,
          peer_title = ?,
          peer_type = ?,
          last_message_id = ?,
          oldest_message_id = ?,
          message_count = ?,
          target_message_count = ?,
          last_synced_at = CURRENT_TIMESTAMP,
          error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      status,
      peerTitle,
      peerType,
      lastMessageId ?? 0,
      oldestMessageId ?? null,
      messageCount ?? 0,
      targetCount ?? DEFAULT_TARGET_MESSAGES,
      id,
    );
  }

  _markJobError(id, error) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JOB_STATUS.ERROR, error.message || String(error), id);
  }

  _countMessages(channelId) {
    return this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM messages
      WHERE channel_id = ?
    `).get(String(channelId)).cnt;
  }

  async _syncNewerMessages(job) {
    const minId = job.last_message_id || 0;
    const { peerTitle, peerType, messages } = await this.telegramClient.getMessagesByChannelId(job.channel_id, this.batchSize, { minId });

    const newMessages = messages
      .filter((msg) => msg.id > minId)
      .sort((a, b) => a.id - b.id);

    let lastMessageId = job.last_message_id || 0;
    let oldestMessageId = job.oldest_message_id || null;

    if (newMessages.length) {
      const records = newMessages.map((msg) => ({
        channel_id: String(job.channel_id),
        message_id: msg.id,
        date: msg.date ?? null,
        from_id: msg.from_id ?? null,
        text: msg.text ?? null,
        raw_json: JSON.stringify(msg),
      }));

      this.insertMessagesTx(records);

      lastMessageId = newMessages[newMessages.length - 1].id;
      oldestMessageId = oldestMessageId ? Math.min(oldestMessageId, newMessages[0].id) : newMessages[0].id;
    }

    const totalMessages = this._countMessages(job.channel_id);

    return {
      peerTitle,
      peerType,
      lastMessageId,
      oldestMessageId,
      totalMessages,
      targetCount: job.target_message_count || DEFAULT_TARGET_MESSAGES,
      hasMoreNewer: newMessages.length >= this.batchSize,
    };
  }

  async _backfillHistory(job, currentCount, targetCount, newestMessageId) {
    if (currentCount >= targetCount) {
      return {
        finalCount: currentCount,
        oldestMessageId: job.oldest_message_id ?? null,
        hasMoreOlder: false,
        insertedCount: 0,
      };
    }

    const peer = await this.telegramClient.client.resolvePeer(
      normalizeChannelId(job.channel_id),
    );

    let total = currentCount;
    let currentOldest = job.oldest_message_id ?? null;
    let insertedCount = 0;
    let nextOffsetId = job.oldest_message_id ?? newestMessageId ?? job.last_message_id ?? 0;

    while (total < targetCount) {
      if (!nextOffsetId || nextOffsetId <= 1) {
        break;
      }

      const chunkLimit = Math.min(this.batchSize, targetCount - total);
      const iterator = this.telegramClient.client.iterHistory(peer, {
        limit: chunkLimit,
        chunkSize: chunkLimit,
        reverse: false,
        offset: { id: nextOffsetId, date: 0 },
        addOffset: 0,
      });

      const records = [];
      let lowestIdInChunk = null;
      let chunkCount = 0;

      for await (const message of iterator) {
        const serialized = this.telegramClient._serializeMessage(message, peer);
        records.push({
          channel_id: String(job.channel_id),
          message_id: serialized.id,
          date: serialized.date ?? null,
          from_id: serialized.from_id ?? null,
          text: serialized.text ?? null,
          raw_json: JSON.stringify(serialized),
        });

        lowestIdInChunk = lowestIdInChunk === null
          ? serialized.id
          : Math.min(lowestIdInChunk, serialized.id);
        currentOldest = currentOldest
          ? Math.min(currentOldest, serialized.id)
          : serialized.id;
        chunkCount += 1;
      }

      if (!records.length) {
        break;
      }

      this.insertMessagesTx(records);

      total += chunkCount;
      insertedCount += chunkCount;
      nextOffsetId = lowestIdInChunk ?? nextOffsetId;

      if (total >= targetCount) {
        break;
      }

      await delay(this.interBatchDelayMs);
    }

    return {
      finalCount: this._countMessages(job.channel_id),
      oldestMessageId: currentOldest,
      hasMoreOlder: insertedCount > 0 && total < targetCount,
      insertedCount,
    };
  }
}
