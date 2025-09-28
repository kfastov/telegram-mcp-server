import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { normalizeChannelId } from './telegram-client.js';

const DEFAULT_DB_PATH = './data/messages.db';
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
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error TEXT
      );
    `);

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

  addJob(channelId) {
    const normalizedId = String(normalizeChannelId(channelId));
    const stmt = this.db.prepare(`
      INSERT INTO jobs (channel_id, status, error, updated_at)
      VALUES (?, '${JOB_STATUS.PENDING}', NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        status='${JOB_STATUS.PENDING}',
        error=NULL,
        updated_at=CURRENT_TIMESTAMP
      RETURNING *;
    `);

    return stmt.get(normalizedId);
  }

  listJobs() {
    return this.db.prepare(`
      SELECT id, channel_id, peer_title, peer_type, status, last_message_id, last_synced_at, created_at, updated_at, error
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

  async _processJob(job) {
    this._updateJobStatus(job.id, JOB_STATUS.IN_PROGRESS);

    try {
      const minId = job.last_message_id || 0;
      const { peerTitle, peerType, messages } = await this.telegramClient.getMessagesByChannelId(job.channel_id, this.batchSize, { minId });

      const newMessages = messages
        .filter(msg => msg.id > minId)
        .sort((a, b) => a.id - b.id);

      if (newMessages.length) {
        const records = newMessages.map(msg => ({
          channel_id: String(job.channel_id),
          message_id: msg.id,
          date: msg.date ?? null,
          from_id: msg.from_id ?? null,
          text: msg.text ?? null,
          raw_json: JSON.stringify(msg),
        }));

        this.insertMessagesTx(records);
      }

      const nextStatus = newMessages.length >= this.batchSize ? JOB_STATUS.PENDING : JOB_STATUS.IDLE;
      const lastMessageId = newMessages.length ? newMessages[newMessages.length - 1].id : job.last_message_id;

      this.db.prepare(`
        UPDATE jobs
        SET status = ?,
            peer_title = ?,
            peer_type = ?,
            last_message_id = ?,
            last_synced_at = CURRENT_TIMESTAMP,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextStatus, peerTitle, peerType, lastMessageId ?? 0, job.id);

      await delay(this.interBatchDelayMs);
    } catch (error) {
      this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JOB_STATUS.ERROR, error.message || String(error), job.id);
    }
  }

  _updateJobStatus(id, status) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
  }
}
