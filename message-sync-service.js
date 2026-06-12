import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { Message, PeersIndex, _messageMediaFromTl, toggleChannelIdMark } from '@mtcute/core';
import { normalizeChannelId, summarizeMedia } from './telegram-client.js';
import { resolveStoreDir, resolveStorePaths } from './core/store.js';

const DEFAULT_DB_PATH = resolveStorePaths(resolveStoreDir()).dbPath;
const DEFAULT_TARGET_MESSAGES = 1000;
const SEARCH_INDEX_VERSION = 2;
const MEDIA_INDEX_VERSION = 1;
const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  IDLE: 'idle',
  ERROR: 'error',
};
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/giu;
const FILE_NAME_PATTERN = /\b[\w.\-]+\.[a-z0-9]{2,7}\b/iu;
const MAX_FILENAME_SCAN_DEPTH = 5;
const MEDIA_COLUMNS = `
  message_media.media_type,
  message_media.file_id,
  message_media.unique_file_id,
  message_media.file_name,
  message_media.mime_type,
  message_media.file_size,
  message_media.width,
  message_media.height,
  message_media.duration,
  message_media.extra_json
`;
const MEDIA_JOIN = `
  LEFT JOIN message_media
    ON message_media.channel_id = messages.channel_id
   AND message_media.message_id = messages.message_id
`;

const TAG_RULES = [
  {
    tag: 'ai',
    patterns: [
      /\bai\b/iu,
      /\bartificial intelligence\b/iu,
      /\bmachine learning\b/iu,
      /\bml\b/iu,
      /\bgpt\b/iu,
      /\bllm\b/iu,
      /нейросет/iu,
      /искусственн/iu,
      /машинн(ое|ого) обучен/iu,
    ],
  },
  {
    tag: 'memes',
    patterns: [
      /\bmeme(s)?\b/iu,
      /мем/iu,
      /юмор/iu,
      /шутк/iu,
      /\blol\b/iu,
      /\bkek\b/iu,
    ],
  },
  {
    tag: 'news',
    patterns: [
      /\bnews\b/iu,
      /новост/iu,
      /сводк/iu,
      /дайджест/iu,
      /\bbreaking\b/iu,
    ],
  },
  {
    tag: 'crypto',
    patterns: [
      /\bcrypto\b/iu,
      /\bbitcoin\b/iu,
      /\bbtc\b/iu,
      /\beth\b/iu,
      /\bblockchain\b/iu,
      /крипт/iu,
      /блокчейн/iu,
    ],
  },
  {
    tag: 'jobs',
    patterns: [
      /\bjob(s)?\b/iu,
      /ваканс/iu,
      /работа/iu,
      /\bhiring\b/iu,
      /\bcareer\b/iu,
    ],
  },
  {
    tag: 'events',
    patterns: [
      /\bevent(s)?\b/iu,
      /мероприяти/iu,
      /встреч/iu,
      /митап/iu,
      /конференц/iu,
    ],
  },
  {
    tag: 'travel',
    patterns: [
      /\btravel\b/iu,
      /\btrip\b/iu,
      /путешеств/iu,
      /туризм/iu,
    ],
  },
  {
    tag: 'finance',
    patterns: [
      /\bfinance\b/iu,
      /финанс/iu,
      /инвест/iu,
      /\bstock(s)?\b/iu,
      /акци/iu,
    ],
  },
  {
    tag: 'real_estate',
    patterns: [
      /\breal estate\b/iu,
      /недвижим/iu,
      /аренд/iu,
      /\brent\b/iu,
      /квартир/iu,
    ],
  },
  {
    tag: 'education',
    patterns: [
      /\bcourse(s)?\b/iu,
      /курс/iu,
      /обучен/iu,
      /учеб/iu,
    ],
  },
  {
    tag: 'tech',
    patterns: [
      /\btech\b/iu,
      /технол/iu,
      /\bsoftware\b/iu,
      /разработк/iu,
      /\bdev\b/iu,
    ],
  },
  {
    tag: 'marketing',
    patterns: [
      /\bmarketing\b/iu,
      /маркетинг/iu,
      /\bsmm\b/iu,
      /реклам/iu,
    ],
  },
  {
    tag: 'gaming',
    patterns: [
      /\bgam(e|ing|es)\b/iu,
      /игр/iu,
      /стрим/iu,
    ],
  },
  {
    tag: 'sports',
    patterns: [
      /\bsport(s)?\b/iu,
      /спорт/iu,
      /футбол/iu,
      /\bnba\b/iu,
    ],
  },
  {
    tag: 'health',
    patterns: [
      /\bhealth\b/iu,
      /здоров/iu,
      /медиц/iu,
      /fitness/iu,
      /фитнес/iu,
    ],
  },
];

function normalizeChannelKey(channelId) {
  return String(normalizeChannelId(channelId));
}

function normalizePeerType(peer) {
  if (!peer) return 'chat';
  if (peer.type === 'user' || peer.type === 'bot') return 'user';
  if (peer.type === 'channel') return 'channel';
  if (peer.type === 'chat' && peer.chatType && peer.chatType !== 'group') return 'channel';
  return 'chat';
}

function parseIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ts = date.getTime();
  if (Number.isNaN(ts)) {
    throw new Error('minDate must be a valid ISO-8601 string');
  }
  return Math.floor(ts / 1000);
}

function toIsoString(dateSeconds) {
  if (!dateSeconds) return null;
  return new Date(dateSeconds * 1000).toISOString();
}

function formatMediaRow(row) {
  if (!row) {
    return null;
  }
  const hasMedia = row.media_type || row.file_id || row.unique_file_id || row.file_name;
  if (!hasMedia) {
    return null;
  }
  const extras = safeParseJson(row.extra_json);
  return {
    type: row.media_type ?? null,
    fileId: row.file_id ?? null,
    uniqueFileId: row.unique_file_id ?? null,
    fileName: row.file_name ?? null,
    mimeType: row.mime_type ?? null,
    fileSize: typeof row.file_size === 'number' ? row.file_size : row.file_size ?? null,
    width: typeof row.width === 'number' ? row.width : row.width ?? null,
    height: typeof row.height === 'number' ? row.height : row.height ?? null,
    duration: typeof row.duration === 'number' ? row.duration : row.duration ?? null,
    extras: extras ?? null,
  };
}

function formatArchivedRow(row) {
  const isBot = row.from_is_bot;
  return {
    channelId: row.channel_id,
    peerTitle: row.peer_title ?? null,
    username: row.username ?? null,
    messageId: row.message_id,
    date: row.date ? new Date(row.date * 1000).toISOString() : null,
    fromId: row.from_id ?? null,
    fromUsername: row.from_username ?? null,
    fromDisplayName: row.from_display_name ?? null,
    fromPeerType: row.from_peer_type ?? null,
    fromIsBot: typeof isBot === 'number' ? Boolean(isBot) : isBot ?? null,
    text: row.text ?? '',
    media: formatMediaRow(row),
    topicId: row.topic_id ?? null,
  };
}

function normalizeTagsList(raw) {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function formatContactRow(row) {
  if (!row) {
    return null;
  }
  const isBot = row.is_bot;
  const isContact = row.is_contact;
  const tags = normalizeTagsList(row.tags);
  return {
    userId: row.user_id,
    peerType: row.peer_type ?? null,
    username: row.username ?? null,
    displayName: row.display_name ?? null,
    phone: row.phone ?? null,
    isContact: typeof isContact === 'number' ? Boolean(isContact) : isContact ?? null,
    isBot: typeof isBot === 'number' ? Boolean(isBot) : isBot ?? null,
    alias: row.alias ?? null,
    notes: row.notes ?? null,
    tags,
  };
}

function extractLinksFromText(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const matches = text.match(URL_PATTERN) ?? [];
  const results = new Set();
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.!?;:]+$/g, '');
    if (cleaned) {
      results.add(cleaned);
    }
  }
  return [...results];
}

function extractFileNamesFromText(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const matches = text.match(new RegExp(FILE_NAME_PATTERN.source, 'giu')) ?? [];
  return matches;
}

function collectFileNames(value, results, depth = 0) {
  if (!value || depth > MAX_FILENAME_SCAN_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFileNames(entry, results, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'fileName' || key === 'file_name') && typeof entry === 'string') {
      results.add(entry);
      continue;
    }
    if (key === 'name' && typeof entry === 'string' && FILE_NAME_PATTERN.test(entry)) {
      results.add(entry);
      continue;
    }
    collectFileNames(entry, results, depth + 1);
  }
}

function extractFileNames(message) {
  const results = new Set();
  const textFiles = extractFileNamesFromText(message?.text ?? message?.message ?? null);
  for (const entry of textFiles) {
    results.add(entry);
  }
  if (message?.raw) {
    collectFileNames(message.raw, results);
  }
  return [...results];
}

function buildSenderText(message) {
  const parts = [];
  if (message?.from_username) {
    parts.push(String(message.from_username));
  }
  if (message?.from_display_name) {
    parts.push(String(message.from_display_name));
  }
  if (message?.from_id) {
    parts.push(String(message.from_id));
  }
  return parts.length ? parts.join(' ') : null;
}

function buildTopicText(message) {
  if (!message) {
    return null;
  }
  if (typeof message.topic_title === 'string' && message.topic_title.trim()) {
    return message.topic_title.trim();
  }
  if (message.topic_id !== null && message.topic_id !== undefined) {
    return String(message.topic_id);
  }
  return null;
}

function buildLinkEntries(links) {
  const entries = [];
  for (const url of links) {
    let domain = null;
    try {
      domain = new URL(url).hostname || null;
    } catch (error) {
      domain = null;
    }
    entries.push({ url, domain });
  }
  return entries;
}

function buildSearchFields(message) {
  const links = extractLinksFromText(message?.text ?? message?.message ?? null);
  const files = extractFileNames(message);
  const sender = buildSenderText(message);
  const topic = buildTopicText(message);
  return {
    linksText: links.length ? links.join(' ') : null,
    filesText: files.length ? files.join(' ') : null,
    senderText: sender,
    topicText: topic,
    linkEntries: buildLinkEntries(links),
  };
}

function safeParseJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function normalizeMediaText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function normalizeMediaNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildMediaRecord(summary) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }
  const mediaType = normalizeMediaText(summary.type ?? summary.media_type);
  if (!mediaType) {
    return null;
  }
  let extraJson = null;
  if (summary.extras && typeof summary.extras === 'object') {
    try {
      extraJson = JSON.stringify(summary.extras);
    } catch (error) {
      extraJson = null;
    }
  } else if (typeof summary.extra_json === 'string') {
    extraJson = summary.extra_json;
  }

  return {
    media_type: mediaType,
    file_id: normalizeMediaText(summary.fileId ?? summary.file_id),
    unique_file_id: normalizeMediaText(summary.uniqueFileId ?? summary.unique_file_id),
    file_name: normalizeMediaText(summary.fileName ?? summary.file_name),
    mime_type: normalizeMediaText(summary.mimeType ?? summary.mime_type),
    file_size: normalizeMediaNumber(summary.fileSize ?? summary.file_size),
    width: normalizeMediaNumber(summary.width),
    height: normalizeMediaNumber(summary.height),
    duration: normalizeMediaNumber(summary.duration),
    extra_json: extraJson,
  };
}

function extractMediaSummary(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  if (message.media) {
    const summary = summarizeMedia(message.media);
    if (summary) {
      return summary;
    }
  }
  const rawMedia = message.raw?.media;
  if (!rawMedia || typeof rawMedia !== 'object') {
    return null;
  }
  try {
    const parsed = _messageMediaFromTl(null, rawMedia);
    return summarizeMedia(parsed);
  } catch (error) {
    return null;
  }
}

function normalizeTag(tag) {
  if (!tag) return null;
  const normalized = String(tag).trim().toLowerCase();
  return normalized.replace(/\s+/g, ' ');
}

function buildTagText({ peerTitle, username, about }) {
  return [peerTitle, username, about].filter(Boolean).join(' ').trim();
}

function classifyTags(text) {
  if (!text) return [];
  const results = [];
  for (const rule of TAG_RULES) {
    let hits = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        hits += 1;
      }
    }
    if (hits > 0) {
      const confidence = Math.min(1, hits / 3);
      results.push({ tag: rule.tag, confidence });
    }
  }
  return results;
}

export default class MessageSyncService {
  constructor(telegramClient, options = {}) {
    this.telegramClient = telegramClient;
    this.dbPath = path.resolve(options.dbPath || DEFAULT_DB_PATH);
    this.batchSize = options.batchSize || 100;
    this.interJobDelayMs = options.interJobDelayMs || 3000;
    this.interBatchDelayMs = options.interBatchDelayMs || 1000;
    this.processing = false;
    this.stopRequested = false;
    this.realtimeActive = false;
    this.realtimeHandlers = null;
    this.unsubscribeChannelTooLong = null;
    // Id of the job this instance set to `in_progress` while running the queue.
    // Only the queue worker owns its in-flight job; `shutdown()` requeues just
    // this one so it resumes next run, without touching jobs other processes own.
    this.ownedInProgressJobId = null;

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
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        peer_title TEXT,
        peer_type TEXT,
        chat_type TEXT,
        is_forum INTEGER,
        username TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        last_message_id INTEGER DEFAULT 0,
        last_message_date TEXT,
        oldest_message_id INTEGER,
        oldest_message_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_metadata (
        channel_id TEXT PRIMARY KEY,
        about TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS channel_metadata_updated_idx
      ON channel_metadata (updated_at);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_tags (
        channel_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        confidence REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, tag, source)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS channel_tags_tag_idx
      ON channel_tags (tag);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT '${JOB_STATUS.PENDING}',
        target_message_count INTEGER DEFAULT ${DEFAULT_TARGET_MESSAGES},
        message_count INTEGER DEFAULT 0,
        cursor_message_id INTEGER,
        cursor_message_date TEXT,
        backfill_min_date TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error TEXT
      );
    `);

    this._ensureChannelColumn('chat_type', 'TEXT');
    this._ensureChannelColumn('is_forum', 'INTEGER');
    this._ensureJobColumn('target_message_count', `INTEGER DEFAULT ${DEFAULT_TARGET_MESSAGES}`);
    this._ensureJobColumn('message_count', 'INTEGER DEFAULT 0');
    this._ensureJobColumn('cursor_message_id', 'INTEGER');
    this._ensureJobColumn('cursor_message_date', 'TEXT');
    this._ensureJobColumn('backfill_min_date', 'TEXT');
    this._ensureJobColumn('started_at', 'TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        peer_type TEXT,
        username TEXT,
        display_name TEXT,
        phone TEXT,
        is_contact INTEGER,
        is_bot INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this._ensureUserColumn('phone', 'TEXT');
    this._ensureUserColumn('is_contact', 'INTEGER');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS users_username_idx
      ON users (username);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS users_phone_idx
      ON users (phone);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        user_id TEXT PRIMARY KEY,
        alias TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contact_tags (
        user_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, tag)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS contact_tags_tag_idx
      ON contact_tags (tag);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS contact_tags_user_idx
      ON contact_tags (user_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        topic_id INTEGER,
        date INTEGER,
        from_id TEXT,
        text TEXT,
        links TEXT,
        files TEXT,
        sender TEXT,
        topic TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(channel_id, message_id)
      );
    `);

    this._ensureMessageColumn('topic_id', 'INTEGER');
    this._ensureMessageColumn('links', 'TEXT');
    this._ensureMessageColumn('files', 'TEXT');
    this._ensureMessageColumn('sender', 'TEXT');
    this._ensureMessageColumn('topic', 'TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        domain TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(channel_id, message_id, url)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS message_links_url_idx
      ON message_links (url);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS message_links_domain_idx
      ON message_links (domain);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_media (
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        media_type TEXT,
        file_id TEXT,
        unique_file_id TEXT,
        file_name TEXT,
        mime_type TEXT,
        file_size INTEGER,
        width INTEGER,
        height INTEGER,
        duration INTEGER,
        extra_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, message_id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS message_media_type_idx
      ON message_media (media_type);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS message_media_mime_idx
      ON message_media (mime_type);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS message_media_name_idx
      ON message_media (file_name);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        channel_id TEXT NOT NULL,
        topic_id INTEGER NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, topic_id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS topics_title_idx
      ON topics (title);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    const searchSchema = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'message_search'
    `).get();
    const storedVersion = this.db.prepare(`
      SELECT value FROM search_meta WHERE key = 'search_index_version'
    `).get()?.value;
    const storedMediaVersion = this.db.prepare(`
      SELECT value FROM search_meta WHERE key = 'media_index_version'
    `).get()?.value;
    const needsVersionRebuild = Number(storedVersion ?? 0) !== SEARCH_INDEX_VERSION;
    const needsMediaRebuild = Number(storedMediaVersion ?? 0) !== MEDIA_INDEX_VERSION;
    const needsSearchRecreate = !searchSchema?.sql
      || !searchSchema.sql.includes("tokenize='unicode61'")
      || !searchSchema.sql.includes('links')
      || needsVersionRebuild;
    const shouldRebuildSearch = needsSearchRecreate;

    if (needsSearchRecreate) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS message_search;
      `);
    }

    if (needsVersionRebuild || needsMediaRebuild) {
      this._backfillSearchFields({ rebuildMedia: needsMediaRebuild });
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        text,
        links,
        files,
        sender,
        topic,
        content='messages',
        content_rowid='id',
        tokenize='unicode61'
      );
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai
      AFTER INSERT ON messages BEGIN
        INSERT INTO message_search(rowid, text, links, files, sender, topic)
        VALUES (
          new.id,
          COALESCE(new.text, ''),
          COALESCE(new.links, ''),
          COALESCE(new.files, ''),
          COALESCE(new.sender, ''),
          COALESCE(new.topic, '')
        );
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad
      AFTER DELETE ON messages BEGIN
        INSERT INTO message_search(message_search, rowid, text, links, files, sender, topic)
        VALUES (
          'delete',
          old.id,
          COALESCE(old.text, ''),
          COALESCE(old.links, ''),
          COALESCE(old.files, ''),
          COALESCE(old.sender, ''),
          COALESCE(old.topic, '')
        );
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au
      AFTER UPDATE ON messages BEGIN
        INSERT INTO message_search(message_search, rowid, text, links, files, sender, topic)
        VALUES (
          'delete',
          old.id,
          COALESCE(old.text, ''),
          COALESCE(old.links, ''),
          COALESCE(old.files, ''),
          COALESCE(old.sender, ''),
          COALESCE(old.topic, '')
        );
        INSERT INTO message_search(rowid, text, links, files, sender, topic)
        VALUES (
          new.id,
          COALESCE(new.text, ''),
          COALESCE(new.links, ''),
          COALESCE(new.files, ''),
          COALESCE(new.sender, ''),
          COALESCE(new.topic, '')
        );
      END;
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_channel_topic_idx
      ON messages (channel_id, topic_id, message_id);
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO channels (channel_id, sync_enabled)
      SELECT channel_id, 1
      FROM jobs
      WHERE channel_id IS NOT NULL;
    `);

    this.upsertChannelStmt = this.db.prepare(`
      INSERT INTO channels (channel_id, peer_title, peer_type, chat_type, is_forum, username, updated_at)
      VALUES (@channel_id, @peer_title, @peer_type, @chat_type, @is_forum, @username, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        peer_title = excluded.peer_title,
        peer_type = COALESCE(excluded.peer_type, channels.peer_type),
        chat_type = COALESCE(excluded.chat_type, channels.chat_type),
        is_forum = COALESCE(excluded.is_forum, channels.is_forum),
        username = COALESCE(excluded.username, channels.username),
        updated_at = CURRENT_TIMESTAMP
      RETURNING channel_id, sync_enabled;
    `);

    this.upsertChannelMetadataStmt = this.db.prepare(`
      INSERT INTO channel_metadata (channel_id, about, updated_at)
      VALUES (@channel_id, @about, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        about = excluded.about,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.insertChannelTagStmt = this.db.prepare(`
      INSERT INTO channel_tags (channel_id, tag, source, confidence, updated_at)
      VALUES (@channel_id, @tag, @source, @confidence, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id, tag, source) DO UPDATE SET
        confidence = excluded.confidence,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.deleteChannelTagsStmt = this.db.prepare(`
      DELETE FROM channel_tags
      WHERE channel_id = ? AND source = ?
    `);

    this.upsertUserStmt = this.db.prepare(`
      INSERT INTO users (
        user_id,
        peer_type,
        username,
        display_name,
        phone,
        is_contact,
        is_bot,
        updated_at
      )
      VALUES (
        @user_id,
        @peer_type,
        @username,
        @display_name,
        @phone,
        @is_contact,
        @is_bot,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(user_id) DO UPDATE SET
        peer_type = COALESCE(excluded.peer_type, users.peer_type),
        username = COALESCE(excluded.username, users.username),
        display_name = COALESCE(excluded.display_name, users.display_name),
        phone = COALESCE(excluded.phone, users.phone),
        is_contact = COALESCE(excluded.is_contact, users.is_contact),
        is_bot = COALESCE(excluded.is_bot, users.is_bot),
        updated_at = CURRENT_TIMESTAMP
    `);

    this.ensureUserStmt = this.db.prepare(`
      INSERT OR IGNORE INTO users (user_id, peer_type, updated_at)
      VALUES (?, 'user', CURRENT_TIMESTAMP)
    `);

    this.upsertContactAliasStmt = this.db.prepare(`
      INSERT INTO contacts (user_id, alias, updated_at)
      VALUES (@user_id, @alias, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        alias = excluded.alias,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.upsertContactNotesStmt = this.db.prepare(`
      INSERT INTO contacts (user_id, notes, updated_at)
      VALUES (@user_id, @notes, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.insertContactTagStmt = this.db.prepare(`
      INSERT OR IGNORE INTO contact_tags (user_id, tag, updated_at)
      VALUES (@user_id, @tag, CURRENT_TIMESTAMP)
    `);

    this.deleteContactTagStmt = this.db.prepare(`
      DELETE FROM contact_tags
      WHERE user_id = ? AND tag = ?
    `);

    this.listContactTagsStmt = this.db.prepare(`
      SELECT tag
      FROM contact_tags
      WHERE user_id = ?
      ORDER BY tag ASC
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        channel_id,
        message_id,
        topic_id,
        date,
        from_id,
        text,
        links,
        files,
        sender,
        topic,
        raw_json
      )
      VALUES (
        @channel_id,
        @message_id,
        @topic_id,
        @date,
        @from_id,
        @text,
        @links,
        @files,
        @sender,
        @topic,
        @raw_json
      )
    `);

    this.upsertMessageStmt = this.db.prepare(`
      INSERT INTO messages (
        channel_id,
        message_id,
        topic_id,
        date,
        from_id,
        text,
        links,
        files,
        sender,
        topic,
        raw_json
      )
      VALUES (
        @channel_id,
        @message_id,
        @topic_id,
        @date,
        @from_id,
        @text,
        @links,
        @files,
        @sender,
        @topic,
        @raw_json
      )
      ON CONFLICT(channel_id, message_id) DO UPDATE SET
        topic_id = excluded.topic_id,
        date = excluded.date,
        from_id = excluded.from_id,
        text = excluded.text,
        links = excluded.links,
        files = excluded.files,
        sender = excluded.sender,
        topic = excluded.topic,
        raw_json = excluded.raw_json
    `);

    this.insertMessageLinkStmt = this.db.prepare(`
      INSERT OR IGNORE INTO message_links (channel_id, message_id, url, domain)
      VALUES (@channel_id, @message_id, @url, @domain)
    `);

    this.deleteMessageLinksStmt = this.db.prepare(`
      DELETE FROM message_links
      WHERE channel_id = ? AND message_id = ?
    `);

    this.upsertMessageMediaStmt = this.db.prepare(`
      INSERT INTO message_media (
        channel_id,
        message_id,
        media_type,
        file_id,
        unique_file_id,
        file_name,
        mime_type,
        file_size,
        width,
        height,
        duration,
        extra_json,
        updated_at
      )
      VALUES (
        @channel_id,
        @message_id,
        @media_type,
        @file_id,
        @unique_file_id,
        @file_name,
        @mime_type,
        @file_size,
        @width,
        @height,
        @duration,
        @extra_json,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(channel_id, message_id) DO UPDATE SET
        media_type = excluded.media_type,
        file_id = excluded.file_id,
        unique_file_id = excluded.unique_file_id,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        file_size = excluded.file_size,
        width = excluded.width,
        height = excluded.height,
        duration = excluded.duration,
        extra_json = excluded.extra_json,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.deleteMessageMediaStmt = this.db.prepare(`
      DELETE FROM message_media
      WHERE channel_id = ? AND message_id = ?
    `);

    this.upsertTopicStmt = this.db.prepare(`
      INSERT INTO topics (channel_id, topic_id, title, updated_at)
      VALUES (@channel_id, @topic_id, @title, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id, topic_id) DO UPDATE SET
        title = excluded.title,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.updateMessagesTopicStmt = this.db.prepare(`
      UPDATE messages
      SET topic = ?
      WHERE channel_id = ? AND topic_id = ?
    `);

    this.insertMessagesTx = this.db.transaction((records) => {
      let inserted = 0;
      for (const record of records) {
        const result = this.insertMessageStmt.run(record);
        if (result.changes > 0) {
          inserted += result.changes;
          this._replaceMessageLinks(record);
          this._replaceMessageMedia(record);
        }
      }
      return inserted;
    });

    this.setChannelTagsTx = this.db.transaction((channelId, source, tags) => {
      this.deleteChannelTagsStmt.run(channelId, source);
      for (const entry of tags) {
        this.insertChannelTagStmt.run({
          channel_id: channelId,
          tag: entry.tag,
          source,
          confidence: entry.confidence ?? null,
        });
      }
    });

    this.upsertUsersTx = this.db.transaction((records) => {
      for (const record of records) {
        this.upsertUserStmt.run(record);
      }
    });

    this.upsertTopicsTx = this.db.transaction((channelId, topics) => {
      for (const topic of topics) {
        this.upsertTopicStmt.run({
          channel_id: channelId,
          topic_id: topic.id,
          title: topic.title ?? null,
        });
        if (topic.title) {
          this.updateMessagesTopicStmt.run(topic.title, channelId, topic.id);
        }
      }
    });

    if (shouldRebuildSearch) {
      this.db.prepare("INSERT INTO message_search(message_search) VALUES ('rebuild')").run();
      this.db.prepare(`
        INSERT INTO search_meta (key, value)
        VALUES ('search_index_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(SEARCH_INDEX_VERSION));
    }

    if (needsMediaRebuild) {
      this.db.prepare(`
        INSERT INTO search_meta (key, value)
        VALUES ('media_index_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(MEDIA_INDEX_VERSION));
    }
  }

  _ensureJobColumn(column, definition) {
    const existing = this.db.prepare('PRAGMA table_info(jobs)').all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
    }
  }

  _ensureChannelColumn(column, definition) {
    const existing = this.db.prepare('PRAGMA table_info(channels)').all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE channels ADD COLUMN ${column} ${definition}`);
    }
  }

  _ensureMessageColumn(column, definition) {
    const existing = this.db.prepare('PRAGMA table_info(messages)').all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
    }
  }

  _ensureUserColumn(column, definition) {
    const existing = this.db.prepare('PRAGMA table_info(users)').all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    }
  }

  async refreshChannelsFromDialogs() {
    const dialogs = await this.telegramClient.listDialogs(0);
    this.upsertChannels(dialogs);
    return dialogs.length;
  }

  upsertChannels(dialogs = []) {
    const tx = this.db.transaction((items) => {
      for (const dialog of items) {
        this.upsertChannelStmt.get({
          channel_id: String(dialog.id),
          peer_title: dialog.title ?? null,
          peer_type: dialog.type ?? null,
          chat_type: dialog.chatType ?? null,
          is_forum: typeof dialog.isForum === 'boolean' ? (dialog.isForum ? 1 : 0) : null,
          username: dialog.username ?? null,
        });
      }
    });

    tx(dialogs);
  }

  upsertTopics(channelId, topics = []) {
    const normalizedId = normalizeChannelKey(channelId);
    const entries = [];
    for (const topic of topics || []) {
      const id = typeof topic.id === 'number' ? topic.id : Number(topic.id);
      if (!Number.isFinite(id)) {
        continue;
      }
      const title = typeof topic.title === 'string' ? topic.title : null;
      entries.push({ id, title });
    }
    if (!entries.length) {
      return 0;
    }
    this.upsertTopicsTx(normalizedId, entries);
    return entries.length;
  }

  listActiveChannels() {
    return this.db.prepare(`
      SELECT channel_id, peer_title, peer_type, chat_type, is_forum, username, sync_enabled,
             last_message_id, last_message_date, oldest_message_id, oldest_message_date,
             created_at, updated_at
      FROM channels
      WHERE sync_enabled = 1
      ORDER BY updated_at DESC
    `).all();
  }

  setChannelSync(channelId, enabled) {
    const normalizedId = normalizeChannelKey(channelId);
    const value = enabled ? 1 : 0;
    const stmt = this.db.prepare(`
      INSERT INTO channels (channel_id, sync_enabled, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        sync_enabled = excluded.sync_enabled,
        updated_at = CURRENT_TIMESTAMP
      RETURNING channel_id, sync_enabled;
    `);

    return stmt.get(normalizedId, value);
  }

  setChannelTags(channelId, tags, options = {}) {
    const normalizedId = normalizeChannelKey(channelId);
    const source = options.source ? String(options.source) : 'manual';
    const uniqueTags = new Set();
    for (const tag of tags || []) {
      const normalizedTag = normalizeTag(tag);
      if (normalizedTag) {
        uniqueTags.add(normalizedTag);
      }
    }
    const finalTags = [...uniqueTags].map((tag) => ({ tag, confidence: null }));

    this.db.prepare(`
      INSERT INTO channels (channel_id, updated_at)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(normalizedId);

    this.setChannelTagsTx(normalizedId, source, finalTags);
    return finalTags.map((entry) => entry.tag);
  }

  listChannelTags(channelId, options = {}) {
    const normalizedId = normalizeChannelKey(channelId);
    const source = options.source ? String(options.source) : null;
    const rows = this.db.prepare(`
      SELECT tag, source, confidence, created_at, updated_at
      FROM channel_tags
      WHERE channel_id = ?
      ${source ? 'AND source = ?' : ''}
      ORDER BY tag ASC
    `).all(...(source ? [normalizedId, source] : [normalizedId]));

    return rows.map((row) => ({
      tag: row.tag,
      source: row.source,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listTaggedChannels(tag, options = {}) {
    const normalizedTag = normalizeTag(tag);
    if (!normalizedTag) {
      return [];
    }
    const source = options.source ? String(options.source) : null;
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 100;
    const rows = this.db.prepare(`
      SELECT channels.channel_id, channels.peer_title, channels.peer_type, channels.username,
             channel_tags.tag, channel_tags.source, channel_tags.confidence
      FROM channel_tags
      JOIN channels ON channels.channel_id = channel_tags.channel_id
      WHERE channel_tags.tag = ?
      ${source ? 'AND channel_tags.source = ?' : ''}
      ORDER BY channels.peer_title ASC
      LIMIT ?
    `).all(...(source ? [normalizedTag, source, limit] : [normalizedTag, limit]));

    return rows.map((row) => ({
      channelId: row.channel_id,
      peerTitle: row.peer_title,
      peerType: row.peer_type,
      username: row.username,
      tag: row.tag,
      source: row.source,
      confidence: row.confidence,
    }));
  }

  async refreshContacts() {
    const contacts = await this.telegramClient.listContacts();
    const records = [];
    for (const contact of contacts) {
      const record = this._buildUserRecordFromPeer(contact);
      if (record) {
        records.push(record);
      }
    }
    if (records.length) {
      this.upsertUsersTx(records);
    }
    return records.length;
  }

  setContactAlias(userId, alias) {
    const normalizedId = String(userId);
    const value = typeof alias === 'string' ? alias.trim() : '';
    if (!value) {
      throw new Error('Alias must be a non-empty string.');
    }
    this.ensureUserStmt.run(normalizedId);
    this.upsertContactAliasStmt.run({
      user_id: normalizedId,
      alias: value,
    });
    return value;
  }

  removeContactAlias(userId) {
    const normalizedId = String(userId);
    this.ensureUserStmt.run(normalizedId);
    this.upsertContactAliasStmt.run({
      user_id: normalizedId,
      alias: null,
    });
    return true;
  }

  setContactNotes(userId, notes) {
    const normalizedId = String(userId);
    const value = typeof notes === 'string' ? notes.trim() : '';
    this.ensureUserStmt.run(normalizedId);
    this.upsertContactNotesStmt.run({
      user_id: normalizedId,
      notes: value || null,
    });
    return value || null;
  }

  listContactTags(userId) {
    const normalizedId = String(userId);
    return this.listContactTagsStmt.all(normalizedId).map((row) => row.tag);
  }

  addContactTags(userId, tags) {
    const normalizedId = String(userId);
    this.ensureUserStmt.run(normalizedId);
    const uniqueTags = new Set();
    for (const tag of tags || []) {
      const normalizedTag = normalizeTag(tag);
      if (normalizedTag) {
        uniqueTags.add(normalizedTag);
      }
    }
    const finalTags = [...uniqueTags];
    if (!finalTags.length) {
      return this.listContactTags(normalizedId);
    }
    const tx = this.db.transaction((entries) => {
      for (const entry of entries) {
        this.insertContactTagStmt.run({
          user_id: normalizedId,
          tag: entry,
        });
      }
    });
    tx(finalTags);
    return this.listContactTags(normalizedId);
  }

  removeContactTags(userId, tags) {
    const normalizedId = String(userId);
    const uniqueTags = new Set();
    for (const tag of tags || []) {
      const normalizedTag = normalizeTag(tag);
      if (normalizedTag) {
        uniqueTags.add(normalizedTag);
      }
    }
    const finalTags = [...uniqueTags];
    if (finalTags.length) {
      const tx = this.db.transaction((entries) => {
        for (const entry of entries) {
          this.deleteContactTagStmt.run(normalizedId, entry);
        }
      });
      tx(finalTags);
    }
    return this.listContactTags(normalizedId);
  }

  getContact(userId) {
    const normalizedId = String(userId);
    const row = this.db.prepare(`
      SELECT
        users.user_id,
        users.peer_type,
        users.username,
        users.display_name,
        users.phone,
        users.is_contact,
        users.is_bot,
        contacts.alias,
        contacts.notes
      FROM users
      LEFT JOIN contacts ON contacts.user_id = users.user_id
      WHERE users.user_id = ?
    `).get(normalizedId);

    if (!row) {
      return null;
    }

    return {
      ...formatContactRow(row),
      tags: this.listContactTags(normalizedId),
    };
  }

  searchContacts(query, options = {}) {
    const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!normalizedQuery) {
      return [];
    }
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 50;
    const like = `%${normalizedQuery}%`;
    const rows = this.db.prepare(`
      SELECT
        users.user_id,
        users.peer_type,
        users.username,
        users.display_name,
        users.phone,
        users.is_contact,
        users.is_bot,
        contacts.alias,
        contacts.notes,
        GROUP_CONCAT(DISTINCT contact_tags.tag) AS tags
      FROM users
      LEFT JOIN contacts ON contacts.user_id = users.user_id
      LEFT JOIN contact_tags ON contact_tags.user_id = users.user_id
      WHERE (
        LOWER(COALESCE(users.username, '')) LIKE ?
        OR LOWER(COALESCE(users.display_name, '')) LIKE ?
        OR LOWER(COALESCE(users.phone, '')) LIKE ?
        OR LOWER(COALESCE(contacts.alias, '')) LIKE ?
        OR LOWER(COALESCE(contacts.notes, '')) LIKE ?
        OR LOWER(COALESCE(contact_tags.tag, '')) LIKE ?
      )
      AND (users.peer_type IS NULL OR users.peer_type = 'user')
      GROUP BY users.user_id
      ORDER BY users.display_name IS NULL, users.display_name COLLATE NOCASE
      LIMIT ?
    `).all(like, like, like, like, like, like, limit);

    return rows.map((row) => formatContactRow(row));
  }

  // True when the archive holds real data under this key: a channels row with
  // resolved metadata, or at least one archived message. Bare channels rows
  // (side effects of addJob/tag inserts) do not count, so a leftover row from
  // an old failed positive-id enqueue cannot pin the wrong key.
  _channelKeyHasData(key) {
    const channelRow = this.db.prepare(`
      SELECT 1
      FROM channels
      WHERE channel_id = ? AND (peer_title IS NOT NULL OR peer_type IS NOT NULL)
    `).get(key);
    if (channelRow) {
      return true;
    }
    const messageRow = this.db.prepare(`
      SELECT 1 FROM messages WHERE channel_id = ? LIMIT 1
    `).get(key);
    return Boolean(messageRow);
  }

  // Maps a chat reference to the archive key that actually holds its data.
  // Group/channel data is keyed by the marked (negative) id, so a bare positive
  // id falls back to its channel (-100...) form, then its basic-chat (-id)
  // form. Keys that already hold data — including user DMs under a positive
  // key — are returned unchanged; no stored keys are rewritten.
  resolveArchiveChannelKey(channelId) {
    const key = normalizeChannelKey(channelId);
    if (!/^\d+$/.test(key) || this._channelKeyHasData(key)) {
      return key;
    }
    for (const candidate of [String(toggleChannelIdMark(Number(key))), `-${key}`]) {
      if (this._channelKeyHasData(candidate)) {
        return candidate;
      }
    }
    return key;
  }

  // Same sign tolerance for job lookups (status/retry/cancel by chat): a job
  // enqueued under the canonical negative key is found from the positive id.
  _resolveJobChannelKey(channelId) {
    const key = normalizeChannelKey(channelId);
    const hasJob = (candidate) => Boolean(
      this.db.prepare('SELECT 1 FROM jobs WHERE channel_id = ? LIMIT 1').get(candidate),
    );
    if (!/^\d+$/.test(key) || hasJob(key)) {
      return key;
    }
    for (const candidate of [String(toggleChannelIdMark(Number(key))), `-${key}`]) {
      if (hasJob(candidate)) {
        return candidate;
      }
    }
    return key;
  }

  getChannelMetadata(channelId) {
    const normalizedId = this.resolveArchiveChannelKey(channelId);
    const row = this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.chat_type,
        channels.is_forum,
        channels.username,
        channel_metadata.about,
        channel_metadata.updated_at AS metadata_updated_at
      FROM channels
      LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
      WHERE channels.channel_id = ?
    `).get(normalizedId);

    if (!row) {
      return null;
    }

    return {
      channelId: row.channel_id,
      peerTitle: row.peer_title,
      peerType: row.peer_type,
      chatType: row.chat_type ?? null,
      isForum: typeof row.is_forum === 'number' ? Boolean(row.is_forum) : row.is_forum ?? null,
      username: row.username,
      about: row.about ?? null,
      metadataUpdatedAt: row.metadata_updated_at ?? null,
    };
  }

  getChannel(channelId) {
    const normalizedId = this.resolveArchiveChannelKey(channelId);
    const row = this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.chat_type,
        channels.is_forum,
        channels.username,
        channels.sync_enabled,
        channels.last_message_id,
        channels.last_message_date,
        channels.oldest_message_id,
        channels.oldest_message_date,
        channels.created_at,
        channels.updated_at,
        channel_metadata.about,
        channel_metadata.updated_at AS metadata_updated_at
      FROM channels
      LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
      WHERE channels.channel_id = ?
    `).get(normalizedId);

    if (!row) {
      return null;
    }

    const syncEnabled = row.sync_enabled;
    const isForum = row.is_forum;
    return {
      channelId: row.channel_id,
      peerTitle: row.peer_title ?? null,
      peerType: row.peer_type ?? null,
      chatType: row.chat_type ?? null,
      isForum: typeof isForum === 'number' ? Boolean(isForum) : isForum ?? null,
      username: row.username ?? null,
      syncEnabled: typeof syncEnabled === 'number' ? Boolean(syncEnabled) : syncEnabled ?? null,
      lastMessageId: row.last_message_id ?? null,
      lastMessageDate: row.last_message_date ?? null,
      oldestMessageId: row.oldest_message_id ?? null,
      oldestMessageDate: row.oldest_message_date ?? null,
      about: row.about ?? null,
      metadataUpdatedAt: row.metadata_updated_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  async refreshChannelMetadata(options = {}) {
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 20;
    const force = Boolean(options.force);
    const onlyMissing = Boolean(options.onlyMissing);
    const channelIds = Array.isArray(options.channelIds) ? options.channelIds : null;

    let rows;
    if (channelIds && channelIds.length) {
      rows = channelIds.map((id) => this._getChannelWithMetadata(normalizeChannelKey(id))).filter(Boolean);
    } else {
      rows = this.db.prepare(`
        SELECT
          channels.channel_id,
          channels.peer_title,
          channels.peer_type,
          channels.chat_type,
          channels.is_forum,
          channels.username,
          channel_metadata.about,
          channel_metadata.updated_at AS metadata_updated_at
        FROM channels
        LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
        ORDER BY channels.updated_at DESC
        LIMIT ?
      `).all(limit);
    }

    const results = [];
    for (const row of rows) {
      if (onlyMissing && row.metadata_updated_at) {
        continue;
      }
      if (!force && !this._isMetadataStale(row.metadata_updated_at)) {
        continue;
      }

      const metadata = await this.telegramClient.getPeerMetadata(
        row.channel_id,
        row.peer_type,
      );

      const nextChatType = metadata.chatType ?? row.chat_type ?? null;
      const nextIsForum = typeof metadata.isForum === 'boolean'
        ? (metadata.isForum ? 1 : 0)
        : row.is_forum ?? null;

      if (metadata.peerTitle || metadata.peerType || metadata.username || metadata.chatType || typeof metadata.isForum === 'boolean') {
        this.upsertChannelStmt.get({
          channel_id: row.channel_id,
          peer_title: metadata.peerTitle ?? row.peer_title ?? null,
          peer_type: metadata.peerType ?? row.peer_type ?? null,
          chat_type: nextChatType,
          is_forum: typeof nextIsForum === 'number' ? nextIsForum : null,
          username: metadata.username ?? row.username ?? null,
        });
      }

      this.upsertChannelMetadataStmt.run({
        channel_id: row.channel_id,
        about: metadata.about ?? null,
      });

      results.push({
        channelId: row.channel_id,
        peerTitle: metadata.peerTitle ?? row.peer_title ?? null,
        peerType: metadata.peerType ?? row.peer_type ?? null,
        chatType: nextChatType,
        isForum: typeof nextIsForum === 'number' ? Boolean(nextIsForum) : nextIsForum ?? null,
        username: metadata.username ?? row.username ?? null,
        about: metadata.about ?? null,
        metadataUpdatedAt: new Date().toISOString(),
      });
    }

    return results;
  }

  async autoTagChannels(options = {}) {
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 50;
    const source = options.source ? String(options.source) : 'auto';
    const refreshMetadata = options.refreshMetadata !== false;
    const channelIds = Array.isArray(options.channelIds) ? options.channelIds : null;

    let rows;
    if (channelIds && channelIds.length) {
      rows = channelIds.map((id) => this._getChannelWithMetadata(normalizeChannelKey(id))).filter(Boolean);
    } else {
      rows = this.db.prepare(`
        SELECT
          channels.channel_id,
          channels.peer_title,
          channels.peer_type,
          channels.username,
          channel_metadata.about,
          channel_metadata.updated_at AS metadata_updated_at
        FROM channels
        LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
        ORDER BY channels.updated_at DESC
        LIMIT ?
      `).all(limit);
    }

    const results = [];
    for (const row of rows) {
      let about = row.about;
      let metadataUpdatedAt = row.metadata_updated_at;
      let peerTitle = row.peer_title;
      let username = row.username;
      let peerType = row.peer_type;
      let chatType = row.chat_type;
      let isForum = row.is_forum;
      if (refreshMetadata && this._isMetadataStale(metadataUpdatedAt)) {
        const metadata = await this.telegramClient.getPeerMetadata(
          row.channel_id,
          row.peer_type,
        );
        if (metadata.peerTitle || metadata.peerType || metadata.username || metadata.chatType || typeof metadata.isForum === 'boolean') {
          peerTitle = metadata.peerTitle ?? peerTitle;
          username = metadata.username ?? username;
          peerType = metadata.peerType ?? peerType;
          chatType = metadata.chatType ?? chatType;
          if (typeof metadata.isForum === 'boolean') {
            isForum = metadata.isForum ? 1 : 0;
          }
          this.upsertChannelStmt.get({
            channel_id: row.channel_id,
            peer_title: peerTitle ?? null,
            peer_type: peerType ?? null,
            chat_type: chatType ?? null,
            is_forum: typeof isForum === 'number' ? isForum : null,
            username: username ?? null,
          });
        }
        this.upsertChannelMetadataStmt.run({
          channel_id: row.channel_id,
          about: metadata.about ?? null,
        });
        about = metadata.about ?? null;
        metadataUpdatedAt = new Date().toISOString();
      }

      const tagText = buildTagText({
        peerTitle,
        username,
        about,
      }).toLowerCase();
      const tags = classifyTags(tagText);
      this.setChannelTagsTx(row.channel_id, source, tags);

      results.push({
        channelId: row.channel_id,
        peerTitle,
        peerType,
        chatType: chatType ?? null,
        isForum: typeof isForum === 'number' ? Boolean(isForum) : isForum ?? null,
        username,
        tags: tags.map((entry) => ({
          tag: entry.tag,
          confidence: entry.confidence,
        })),
        metadataUpdatedAt: metadataUpdatedAt ?? null,
      });
    }

    return results;
  }

  addJob(channelId, options = {}) {
    const normalizedId = normalizeChannelKey(channelId);
    const target = options.depth && options.depth > 0 ? Number(options.depth) : DEFAULT_TARGET_MESSAGES;
    const minDate = options.minDate ? parseIsoDate(options.minDate) : null;
    const minDateIso = minDate ? new Date(minDate * 1000).toISOString() : null;

    this.db.prepare(`
      INSERT INTO channels (channel_id, updated_at)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(normalizedId);

    const stmt = this.db.prepare(`
      INSERT INTO jobs (
        channel_id,
        status,
        error,
        target_message_count,
        message_count,
        cursor_message_id,
        cursor_message_date,
        backfill_min_date,
        updated_at
      )
      VALUES (?, '${JOB_STATUS.PENDING}', NULL, ?, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        status='${JOB_STATUS.PENDING}',
        error=NULL,
        target_message_count=excluded.target_message_count,
        backfill_min_date=excluded.backfill_min_date,
        updated_at=CURRENT_TIMESTAMP
      RETURNING *;
    `);

    return stmt.get(normalizedId, target, minDateIso);
  }

  listJobs(options = {}) {
    const status = options.status ? String(options.status) : null;
    const channelId = options.channelId ? this._resolveJobChannelKey(options.channelId) : null;
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : null;
    const clauses = [];
    const params = [];

    if (status) {
      clauses.push('jobs.status = ?');
      params.push(status);
    }

    if (channelId) {
      clauses.push('jobs.channel_id = ?');
      params.push(channelId);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = limit ? 'LIMIT ?' : '';
    if (limit) {
      params.push(limit);
    }

    return this.db.prepare(`
      SELECT
        jobs.id,
        jobs.channel_id,
        channels.peer_title,
        channels.peer_type,
        jobs.status,
        jobs.target_message_count,
        jobs.message_count,
        jobs.cursor_message_id,
        jobs.cursor_message_date,
        jobs.backfill_min_date,
        jobs.last_synced_at,
        jobs.created_at,
        jobs.updated_at,
        jobs.error
      FROM jobs
      LEFT JOIN channels ON channels.channel_id = jobs.channel_id
      ${whereClause}
      ORDER BY jobs.updated_at DESC
      ${limitClause}
    `).all(...params);
  }

  retryJobs(options = {}) {
    const allErrors = Boolean(options.allErrors);
    const channelId = options.channelId ? this._resolveJobChannelKey(options.channelId) : null;
    const jobId = options.jobId !== undefined && options.jobId !== null ? Number(options.jobId) : null;

    if (!allErrors && jobId === null && !channelId) {
      throw new Error('Provide jobId, channelId, or allErrors to retry.');
    }
    if (allErrors && (jobId !== null || channelId)) {
      throw new Error('Use allErrors without jobId/channelId.');
    }
    if (jobId !== null && !Number.isFinite(jobId)) {
      throw new Error('jobId must be a number.');
    }

    let ids = [];
    if (allErrors) {
      ids = this.db.prepare(`
        SELECT id
        FROM jobs
        WHERE status = ?
      `).all(JOB_STATUS.ERROR).map((row) => row.id);
    } else if (jobId !== null) {
      const row = this.db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId);
      if (row) {
        ids = [row.id];
      }
    } else if (channelId) {
      ids = this.db.prepare(`
        SELECT id
        FROM jobs
        WHERE channel_id = ?
      `).all(channelId).map((row) => row.id);
    }

    if (!ids.length) {
      return { updated: 0, jobIds: [] };
    }

    const tx = this.db.transaction((entries) => {
      for (const id of entries) {
        this.db.prepare(`
          UPDATE jobs
          SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(JOB_STATUS.PENDING, id);
      }
    });
    tx(ids);

    return { updated: ids.length, jobIds: ids };
  }

  cancelJobs(options = {}) {
    const channelId = options.channelId ? this._resolveJobChannelKey(options.channelId) : null;
    const jobId = options.jobId !== undefined && options.jobId !== null ? Number(options.jobId) : null;

    if (jobId === null && !channelId) {
      throw new Error('Provide jobId or channelId to cancel.');
    }
    if (jobId !== null && !Number.isFinite(jobId)) {
      throw new Error('jobId must be a number.');
    }

    let ids = [];
    if (jobId !== null) {
      const row = this.db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId);
      if (row) {
        ids = [row.id];
      }
    } else if (channelId) {
      ids = this.db.prepare(`
        SELECT id
        FROM jobs
        WHERE channel_id = ?
      `).all(channelId).map((row) => row.id);
    }

    if (!ids.length) {
      return { canceled: 0, jobIds: [] };
    }

    const tx = this.db.transaction((entries) => {
      for (const id of entries) {
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      }
    });
    tx(ids);

    return { canceled: ids.length, jobIds: ids };
  }

  // Compact `{ pending, inProgress }` snapshot for the control API
  // (`/control/ping`) and the idle monitor. A trivial re-key of getQueueStats()
  // that keeps callers (and their service stubs) off the snake_case queue shape.
  getJobCounts() {
    const { pending, in_progress: inProgress } = this.getQueueStats();
    return { pending, inProgress };
  }

  // Number of channels with realtime watch enabled. Used by the idle monitor:
  // a server watching any channel must stay up to receive realtime updates.
  getWatchedChannelCount() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM channels
      WHERE sync_enabled = 1
    `).get();
    return row?.cnt ?? 0;
  }

  getQueueStats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM jobs
      GROUP BY status
    `).all();
    const stats = {
      pending: 0,
      in_progress: 0,
      idle: 0,
      error: 0,
    };
    for (const row of rows) {
      if (row.status in stats) {
        stats[row.status] = row.count;
      }
    }
    return {
      processing: this.processing,
      ...stats,
    };
  }

  getSearchStatus() {
    const row = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'message_search'
    `).get();
    const version = this.db.prepare(`
      SELECT value FROM search_meta WHERE key = 'search_index_version'
    `).get()?.value ?? null;
    return {
      enabled: Boolean(row?.name),
      version: version ? Number(version) : null,
    };
  }

  startRealtimeSync() {
    if (this.realtimeActive) {
      return;
    }

    const newMessageHandler = (message) => {
      this._handleIncomingMessage(message, { isEdit: false });
    };
    const editMessageHandler = (message) => {
      this._handleIncomingMessage(message, { isEdit: true });
    };
    const deleteMessageHandler = (update) => {
      this._handleDeleteMessage(update);
    };

    this.telegramClient.client.onNewMessage.add(newMessageHandler);
    this.telegramClient.client.onEditMessage.add(editMessageHandler);
    this.telegramClient.client.onDeleteMessage.add(deleteMessageHandler);

    this.realtimeHandlers = {
      newMessageHandler,
      editMessageHandler,
      deleteMessageHandler,
    };

    this.unsubscribeChannelTooLong = this.telegramClient.onChannelTooLong((payload) => {
      this._handleChannelTooLong(payload);
    });

    this.realtimeActive = true;
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
    this._resetErroredJobs();
    void this.processQueue();
  }

  // Worker-only teardown. Stops the queue loop, requeues *only* the job this
  // instance left in_progress (so the worker resumes it next run), then releases
  // resources via close(). Jobs owned by other processes are never touched.
  // Non-worker commands must call close() instead — see #42.
  async shutdown() {
    this.stopRequested = true;

    while (this.processing) {
      await delay(100);
    }

    if (this.ownedInProgressJobId !== null && this.db && this.db.open) {
      this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?
      `).run(JOB_STATUS.PENDING, this.ownedInProgressJobId, JOB_STATUS.IN_PROGRESS);
      this.ownedInProgressJobId = null;
    }

    this.close();
  }

  // Non-mutating teardown for any process that isn't the queue worker. Removes
  // realtime handlers (if registered) and closes the DB handle, but never touches
  // the `jobs` table — so a read-only command run against a live server's store
  // cannot corrupt the server's in-progress job (#42).
  close() {
    if (this.realtimeActive && this.realtimeHandlers) {
      this.telegramClient.client.onNewMessage.remove(this.realtimeHandlers.newMessageHandler);
      this.telegramClient.client.onEditMessage.remove(this.realtimeHandlers.editMessageHandler);
      this.telegramClient.client.onDeleteMessage.remove(this.realtimeHandlers.deleteMessageHandler);
      this.realtimeHandlers = null;
      if (this.unsubscribeChannelTooLong) {
        this.unsubscribeChannelTooLong();
        this.unsubscribeChannelTooLong = null;
      }
      this.realtimeActive = false;
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

  _resetErroredJobs() {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = ?
    `).run(JOB_STATUS.PENDING, JOB_STATUS.ERROR);
  }

  searchMessages({ channelId, topicId, pattern, limit = 50, caseInsensitive = true }) {
    const normalizedId = normalizeChannelKey(channelId);
    const flags = caseInsensitive ? 'i' : '';
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Invalid pattern: ${error.message}`);
    }

    const topicClause = typeof topicId === 'number' ? 'AND topic_id = ?' : '';
    const params = typeof topicId === 'number' ? [normalizedId, topicId] : [normalizedId];
    const rows = this.db.prepare(`
      SELECT
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name
      FROM messages
      LEFT JOIN users ON users.user_id = messages.from_id
      WHERE channel_id = ?
      ${topicClause}
      ORDER BY message_id DESC
    `).all(...params);

    const matches = [];
    for (const row of rows) {
      const text = row.text || '';
      if (regex.test(text)) {
        matches.push({
          messageId: row.message_id,
          date: row.date ? new Date(row.date * 1000).toISOString() : null,
          fromId: row.from_id,
          fromUsername: row.from_username ?? null,
          fromDisplayName: row.from_display_name ?? null,
          text,
          topicId: row.topic_id ?? null,
        });
        if (matches.length >= limit) {
          break;
        }
      }
    }

    return matches;
  }

  listArchivedMessages({ channelIds, topicId, fromDate, toDate, beforeId, afterId, limit = 50 }) {
    const resolvedIds = Array.isArray(channelIds) ? channelIds : (channelIds ? [channelIds] : []);
    const normalizedIds = resolvedIds.map((id) => this.resolveArchiveChannelKey(id)).filter(Boolean);
    const clauses = [];
    const params = [];

    if (normalizedIds.length) {
      clauses.push(`messages.channel_id IN (${normalizedIds.map(() => '?').join(', ')})`);
      params.push(...normalizedIds);
    }

    if (typeof topicId === 'number') {
      clauses.push('messages.topic_id = ?');
      params.push(topicId);
    }

    if (fromDate) {
      params.push(parseIsoDate(fromDate));
      clauses.push('messages.date >= ?');
    }

    if (toDate) {
      params.push(parseIsoDate(toDate));
      clauses.push('messages.date <= ?');
    }

    if (Number.isFinite(beforeId) && beforeId > 0) {
      params.push(Number(beforeId));
      clauses.push('messages.message_id < ?');
    }

    if (Number.isFinite(afterId) && afterId > 0) {
      params.push(Number(afterId));
      clauses.push('messages.message_id > ?');
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const finalLimit = limit && limit > 0 ? Number(limit) : 50;
    params.push(finalLimit);

    const rows = this.db.prepare(`
      SELECT
        messages.channel_id,
        channels.peer_title,
        channels.username,
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name,
        users.peer_type AS from_peer_type,
        users.is_bot AS from_is_bot,
        ${MEDIA_COLUMNS}
      FROM messages
      LEFT JOIN channels ON channels.channel_id = messages.channel_id
      LEFT JOIN users ON users.user_id = messages.from_id
      ${MEDIA_JOIN}
      ${whereClause}
      ORDER BY messages.date DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => formatArchivedRow(row));
  }

  getArchivedMessage({ channelId, messageId }) {
    const normalizedId = this.resolveArchiveChannelKey(channelId);
    const row = this.db.prepare(`
      SELECT
        messages.channel_id,
        channels.peer_title,
        channels.username,
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name,
        users.peer_type AS from_peer_type,
        users.is_bot AS from_is_bot,
        ${MEDIA_COLUMNS}
      FROM messages
      LEFT JOIN channels ON channels.channel_id = messages.channel_id
      LEFT JOIN users ON users.user_id = messages.from_id
      ${MEDIA_JOIN}
      WHERE messages.channel_id = ? AND messages.message_id = ?
    `).get(normalizedId, Number(messageId));

    if (!row) {
      return null;
    }

    return formatArchivedRow(row);
  }

  getArchivedMessageContext({ channelId, messageId, before = 20, after = 20 }) {
    const normalizedId = this.resolveArchiveChannelKey(channelId);
    const target = this.getArchivedMessage({ channelId: normalizedId, messageId });
    if (!target) {
      return { target: null, before: [], after: [] };
    }

    const safeBefore = before && before > 0 ? Number(before) : 0;
    const safeAfter = after && after > 0 ? Number(after) : 0;

    const beforeRows = safeBefore > 0
      ? this.db.prepare(`
          SELECT
            messages.channel_id,
            channels.peer_title,
            channels.username,
            messages.message_id,
            messages.date,
            messages.from_id,
            messages.text,
            messages.topic_id,
            users.username AS from_username,
            users.display_name AS from_display_name,
            users.peer_type AS from_peer_type,
            users.is_bot AS from_is_bot,
            ${MEDIA_COLUMNS}
          FROM messages
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          WHERE messages.channel_id = ? AND messages.message_id < ?
          ORDER BY messages.message_id DESC
          LIMIT ?
        `).all(normalizedId, Number(messageId), safeBefore)
      : [];

    const afterRows = safeAfter > 0
      ? this.db.prepare(`
          SELECT
            messages.channel_id,
            channels.peer_title,
            channels.username,
            messages.message_id,
            messages.date,
            messages.from_id,
            messages.text,
            messages.topic_id,
            users.username AS from_username,
            users.display_name AS from_display_name,
            users.peer_type AS from_peer_type,
            users.is_bot AS from_is_bot,
            ${MEDIA_COLUMNS}
          FROM messages
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          WHERE messages.channel_id = ? AND messages.message_id > ?
          ORDER BY messages.message_id ASC
          LIMIT ?
        `).all(normalizedId, Number(messageId), safeAfter)
      : [];

    const beforeMessages = beforeRows.map((row) => formatArchivedRow(row)).reverse();
    const afterMessages = afterRows.map((row) => formatArchivedRow(row));

    return {
      target,
      before: beforeMessages,
      after: afterMessages,
    };
  }

  searchArchiveMessages(options = {}) {
    const queryText = typeof options.query === 'string' ? options.query.trim() : '';
    const regexText = typeof options.regex === 'string' ? options.regex.trim() : '';
    const tagList = Array.isArray(options.tags) ? options.tags : (options.tag ? [options.tag] : []);
    const normalizedTags = tagList.map((tag) => normalizeTag(tag)).filter(Boolean);
    const resolvedIds = Array.isArray(options.channelIds)
      ? options.channelIds
      : (options.channelIds ? [options.channelIds] : []);
    const normalizedIds = resolvedIds.map((id) => this.resolveArchiveChannelKey(id)).filter(Boolean);
    const topicId = typeof options.topicId === 'number' ? options.topicId : null;
    const finalLimit = options.limit && options.limit > 0 ? Number(options.limit) : 100;
    const caseInsensitive = options.caseInsensitive !== false;

    let regex = null;
    if (regexText) {
      try {
        regex = new RegExp(regexText, caseInsensitive ? 'i' : '');
      } catch (error) {
        throw new Error(`Invalid regex: ${error.message}`);
      }
    }

    const clauses = [];
    const params = [];
    const joinTags = normalizedTags.length
      ? 'JOIN channel_tags ON channel_tags.channel_id = messages.channel_id'
      : '';

    if (normalizedTags.length) {
      clauses.push(`channel_tags.tag IN (${normalizedTags.map(() => '?').join(', ')})`);
      params.push(...normalizedTags);
    }

    if (normalizedIds.length) {
      clauses.push(`messages.channel_id IN (${normalizedIds.map(() => '?').join(', ')})`);
      params.push(...normalizedIds);
    }

    if (topicId !== null) {
      clauses.push('messages.topic_id = ?');
      params.push(topicId);
    }

    if (options.fromDate) {
      params.push(parseIsoDate(options.fromDate));
      clauses.push('messages.date >= ?');
    }

    if (options.toDate) {
      params.push(parseIsoDate(options.toDate));
      clauses.push('messages.date <= ?');
    }

    if (Number.isFinite(options.beforeId) && options.beforeId > 0) {
      params.push(Number(options.beforeId));
      clauses.push('messages.message_id < ?');
    }

    if (Number.isFinite(options.afterId) && options.afterId > 0) {
      params.push(Number(options.afterId));
      clauses.push('messages.message_id > ?');
    }

    if (queryText) {
      clauses.push('message_search MATCH ?');
      params.push(queryText);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const preLimit = regex ? Math.min(finalLimit * 5, 1000) : finalLimit;
    params.push(preLimit);

    const baseSelect = `
      SELECT DISTINCT
        messages.channel_id,
        channels.peer_title,
        channels.username,
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name,
        users.peer_type AS from_peer_type,
        users.is_bot AS from_is_bot,
        ${MEDIA_COLUMNS}
    `;

    const rows = queryText
      ? this.db.prepare(`
          ${baseSelect}
          FROM message_search
          JOIN messages ON messages.id = message_search.rowid
          ${joinTags}
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          ${whereClause}
          ORDER BY messages.date DESC
          LIMIT ?
        `).all(...params)
      : this.db.prepare(`
          ${baseSelect}
          FROM messages
          ${joinTags}
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          ${whereClause}
          ORDER BY messages.date DESC
          LIMIT ?
        `).all(...params);

    let results = rows.map((row) => formatArchivedRow(row));
    if (regex) {
      results = results.filter((row) => regex.test(row.text || ''));
    }

    return results.slice(0, finalLimit);
  }

  getArchivedMessages({ channelId, topicId, limit = 50 }) {
    const normalizedId = normalizeChannelKey(channelId);
    const topicClause = typeof topicId === 'number' ? 'AND topic_id = ?' : '';
    const params = typeof topicId === 'number'
      ? [normalizedId, topicId, limit]
      : [normalizedId, limit];
    const rows = this.db.prepare(`
      SELECT
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name
      FROM messages
      LEFT JOIN users ON users.user_id = messages.from_id
      WHERE channel_id = ?
      ${topicClause}
      ORDER BY message_id DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => ({
      messageId: row.message_id,
      date: row.date ? new Date(row.date * 1000).toISOString() : null,
      fromId: row.from_id,
      fromUsername: row.from_username ?? null,
      fromDisplayName: row.from_display_name ?? null,
      text: row.text,
      topicId: row.topic_id ?? null,
    }));
  }

  getMessageStats(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
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

  searchTaggedMessages({ tag, query, fromDate, toDate, limit = 100, source = null }) {
    const normalizedTag = normalizeTag(tag);
    if (!normalizedTag) {
      return [];
    }
    const queryText = typeof query === 'string' ? query.trim() : '';
    const params = [normalizedTag];
    const sourceClause = source ? 'AND channel_tags.source = ?' : '';
    if (source) {
      params.push(String(source));
    }

    let dateClause = '';
    if (fromDate) {
      params.push(parseIsoDate(fromDate));
      dateClause += ' AND messages.date >= ?';
    }
    if (toDate) {
      params.push(parseIsoDate(toDate));
      dateClause += ' AND messages.date <= ?';
    }

    const finalLimit = limit && limit > 0 ? Number(limit) : 100;

    if (queryText) {
      params.push(queryText);
      params.push(finalLimit);
      const rows = this.db.prepare(`
        SELECT
          messages.channel_id,
          channels.peer_title,
          channels.username,
          messages.message_id,
          messages.date,
          messages.from_id,
          messages.text,
          messages.topic_id,
          users.username AS from_username,
          users.display_name AS from_display_name
        FROM message_search
        JOIN messages ON messages.id = message_search.rowid
        JOIN channel_tags ON channel_tags.channel_id = messages.channel_id
        LEFT JOIN channels ON channels.channel_id = messages.channel_id
        LEFT JOIN users ON users.user_id = messages.from_id
        WHERE channel_tags.tag = ?
        ${sourceClause}
        ${dateClause}
        AND message_search MATCH ?
        ORDER BY messages.date DESC
        LIMIT ?
      `).all(...params);

      return rows.map((row) => ({
        channelId: row.channel_id,
        peerTitle: row.peer_title,
        username: row.username,
        messageId: row.message_id,
        date: row.date ? new Date(row.date * 1000).toISOString() : null,
        fromId: row.from_id,
        fromUsername: row.from_username ?? null,
        fromDisplayName: row.from_display_name ?? null,
        text: row.text,
        topicId: row.topic_id ?? null,
      }));
    }

    params.push(finalLimit);
    const rows = this.db.prepare(`
      SELECT
        messages.channel_id,
        channels.peer_title,
        channels.username,
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name
      FROM messages
      JOIN channel_tags ON channel_tags.channel_id = messages.channel_id
      LEFT JOIN channels ON channels.channel_id = messages.channel_id
      LEFT JOIN users ON users.user_id = messages.from_id
      WHERE channel_tags.tag = ?
      ${sourceClause}
      ${dateClause}
      ORDER BY messages.date DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => ({
      channelId: row.channel_id,
      peerTitle: row.peer_title,
      username: row.username,
      messageId: row.message_id,
      date: row.date ? new Date(row.date * 1000).toISOString() : null,
      fromId: row.from_id,
      fromUsername: row.from_username ?? null,
      fromDisplayName: row.from_display_name ?? null,
      text: row.text,
      topicId: row.topic_id ?? null,
    }));
  }

  async scanTaggedMessages(options = {}) {
    const normalizedTag = normalizeTag(options.tag);
    if (!normalizedTag) {
      return {
        tag: null,
        source: null,
        autoTag: false,
        taggedChannelCount: 0,
        messageCount: 0,
        taggedChannels: [],
        messages: [],
      };
    }

    const source = options.source ? String(options.source) : 'auto';
    const autoTag = options.autoTag !== false;
    const autoTagLimit = options.autoTagLimit && options.autoTagLimit > 0
      ? Number(options.autoTagLimit)
      : 50;
    const refreshMetadata = options.refreshMetadata !== false;
    const channelLimit = options.channelLimit && options.channelLimit > 0
      ? Number(options.channelLimit)
      : 100;
    const messageLimit = options.messageLimit && options.messageLimit > 0
      ? Number(options.messageLimit)
      : 100;
    const channelIds = Array.isArray(options.channelIds) ? options.channelIds : null;

    if (autoTag) {
      await this.autoTagChannels({
        channelIds,
        limit: autoTagLimit,
        source,
        refreshMetadata,
      });
    }

    const taggedChannels = this.listTaggedChannels(normalizedTag, {
      source,
      limit: channelLimit,
    });

    const messages = this.searchTaggedMessages({
      tag: normalizedTag,
      query: options.query,
      fromDate: options.fromDate,
      toDate: options.toDate,
      limit: messageLimit,
      source,
    });

    return {
      tag: normalizedTag,
      source,
      query: typeof options.query === 'string' ? options.query : null,
      fromDate: options.fromDate ?? null,
      toDate: options.toDate ?? null,
      autoTag,
      autoTagLimit,
      taggedChannelCount: taggedChannels.length,
      messageCount: messages.length,
      taggedChannels,
      messages,
    };
  }

  async _processJob(job) {
    if (this.stopRequested) {
      this._updateJobStatus(job.id, JOB_STATUS.PENDING);
      return;
    }

    this._updateJobStatus(job.id, JOB_STATUS.IN_PROGRESS);
    // Claim ownership so shutdown() requeues this job (and only this one) if the
    // process exits before _processJob writes its terminal/pending status.
    this.ownedInProgressJobId = job.id;

    try {
      const channelId = normalizeChannelKey(job.channel_id);
      const syncResult = await this._syncNewerMessages(channelId);
      if (this.stopRequested || syncResult.stoppedEarly) {
        this._updateJobStatus(job.id, JOB_STATUS.PENDING);
        return;
      }

      const currentCount = this._countMessages(channelId);
      const targetCount = job.target_message_count || DEFAULT_TARGET_MESSAGES;
      const backfillResult = await this._backfillHistory(job, currentCount, targetCount);
      if (this.stopRequested || backfillResult.stoppedEarly) {
        this._updateJobRecord(job.id, {
          status: JOB_STATUS.PENDING,
          messageCount: backfillResult.finalCount,
          cursorMessageId: backfillResult.cursorMessageId,
          cursorMessageDate: backfillResult.cursorMessageDate,
        });
        return;
      }

      const shouldContinue = backfillResult.hasMoreOlder;
      const finalStatus = shouldContinue ? JOB_STATUS.PENDING : JOB_STATUS.IDLE;

      this._updateJobRecord(job.id, {
        status: finalStatus,
        messageCount: backfillResult.finalCount,
        cursorMessageId: backfillResult.cursorMessageId,
        cursorMessageDate: backfillResult.cursorMessageDate,
      });
    } catch (error) {
      if (this.stopRequested) {
        this._updateJobStatus(job.id, JOB_STATUS.PENDING);
        return;
      }
      const waitMatch = /wait of (\d+) seconds is required/i.exec(error.message || '');
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
    } finally {
      // _processJob always writes a non-in_progress status above before
      // returning, so releasing ownership here is safe. If the process is
      // killed mid-await instead, ownership is still set and shutdown() requeues.
      this.ownedInProgressJobId = null;
    }
  }

  _updateJobStatus(id, status) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
  }

  _updateJobRecord(id, { status, messageCount, cursorMessageId, cursorMessageDate }) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?,
          message_count = ?,
          cursor_message_id = ?,
          cursor_message_date = ?,
          last_synced_at = CURRENT_TIMESTAMP,
          error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      status,
      messageCount ?? 0,
      cursorMessageId ?? null,
      cursorMessageDate ?? null,
      id,
    );
  }

  // Lightweight per-batch progress write used while a backfill run is mid-flight.
  // Keeps `message_count`/cursor/`updated_at` live (and stamps `started_at` on the
  // first batch) without touching status, so the control API and idle monitor can
  // observe progress between terminal updates.
  _updateJobProgress(id, { messageCount, cursorMessageId, cursorMessageDate }) {
    this.db.prepare(`
      UPDATE jobs
      SET message_count = ?,
          cursor_message_id = ?,
          cursor_message_date = ?,
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      messageCount ?? 0,
      cursorMessageId ?? null,
      cursorMessageDate ?? null,
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

  _replaceMessageLinks(record) {
    if (!record) {
      return;
    }
    this.deleteMessageLinksStmt.run(record.channel_id, record.message_id);
    const entries = Array.isArray(record.link_entries) ? record.link_entries : [];
    for (const entry of entries) {
      this.insertMessageLinkStmt.run({
        channel_id: record.channel_id,
        message_id: record.message_id,
        url: entry.url,
        domain: entry.domain ?? null,
      });
    }
  }

  _replaceMessageMedia(record) {
    if (!record) {
      return;
    }
    const summary = buildMediaRecord(record.media_summary);
    if (!summary) {
      this.deleteMessageMediaStmt.run(record.channel_id, record.message_id);
      return;
    }
    this.upsertMessageMediaStmt.run({
      channel_id: record.channel_id,
      message_id: record.message_id,
      ...summary,
    });
  }

  _backfillSearchFields(options = {}) {
    const rebuildMedia = Boolean(options.rebuildMedia);
    const selectStmt = this.db.prepare(`
      SELECT id, channel_id, message_id, raw_json, text, topic_id, from_id
      FROM messages
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `);
    const updateStmt = this.db.prepare(`
      UPDATE messages
      SET links = ?, files = ?, sender = ?, topic = ?
      WHERE id = ?
    `);
    const deleteLinksStmt = this.db.prepare(`
      DELETE FROM message_links
      WHERE channel_id = ? AND message_id = ?
    `);
    const insertLinkStmt = this.db.prepare(`
      INSERT OR IGNORE INTO message_links (channel_id, message_id, url, domain)
      VALUES (?, ?, ?, ?)
    `);
    const deleteMediaStmt = rebuildMedia ? this.db.prepare(`
      DELETE FROM message_media
      WHERE channel_id = ? AND message_id = ?
    `) : null;
    const upsertMediaStmt = rebuildMedia ? this.db.prepare(`
      INSERT INTO message_media (
        channel_id,
        message_id,
        media_type,
        file_id,
        unique_file_id,
        file_name,
        mime_type,
        file_size,
        width,
        height,
        duration,
        extra_json,
        updated_at
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(channel_id, message_id) DO UPDATE SET
        media_type = excluded.media_type,
        file_id = excluded.file_id,
        unique_file_id = excluded.unique_file_id,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        file_size = excluded.file_size,
        width = excluded.width,
        height = excluded.height,
        duration = excluded.duration,
        extra_json = excluded.extra_json,
        updated_at = CURRENT_TIMESTAMP
    `) : null;

    const applyBatch = this.db.transaction((rows) => {
      for (const row of rows) {
        const parsed = safeParseJson(row.raw_json) ?? {};
        const message = {
          ...parsed,
          text: parsed.text ?? row.text ?? null,
          topic_id: parsed.topic_id ?? row.topic_id ?? null,
          from_id: parsed.from_id ?? row.from_id ?? null,
        };
        const fields = buildSearchFields(message);
        updateStmt.run(
          fields.linksText,
          fields.filesText,
          fields.senderText,
          fields.topicText,
          row.id,
        );
        deleteLinksStmt.run(row.channel_id, row.message_id);
        for (const entry of fields.linkEntries) {
          insertLinkStmt.run(row.channel_id, row.message_id, entry.url, entry.domain);
        }
        if (rebuildMedia) {
          const summary = extractMediaSummary(message);
          const mediaRecord = buildMediaRecord(summary);
          if (mediaRecord) {
            upsertMediaStmt.run(
              row.channel_id,
              row.message_id,
              mediaRecord.media_type,
              mediaRecord.file_id,
              mediaRecord.unique_file_id,
              mediaRecord.file_name,
              mediaRecord.mime_type,
              mediaRecord.file_size,
              mediaRecord.width,
              mediaRecord.height,
              mediaRecord.duration,
              mediaRecord.extra_json,
            );
          } else {
            deleteMediaStmt.run(row.channel_id, row.message_id);
          }
        }
      }
    });

    let lastId = 0;
    const batchSize = 500;
    while (true) {
      const rows = selectStmt.all(lastId, batchSize);
      if (!rows.length) {
        break;
      }
      applyBatch(rows);
      lastId = rows[rows.length - 1].id;
    }
  }

  _buildMessageRecord(channelId, message) {
    const searchFields = buildSearchFields(message);
    const mediaSummary = extractMediaSummary(message);
    return {
      channel_id: channelId,
      message_id: message.id,
      topic_id: message.topic_id ?? null,
      date: message.date ?? null,
      from_id: message.from_id ?? null,
      text: message.text ?? null,
      links: searchFields.linksText,
      files: searchFields.filesText,
      sender: searchFields.senderText,
      topic: searchFields.topicText,
      raw_json: JSON.stringify(message),
      link_entries: searchFields.linkEntries,
      media_summary: mediaSummary,
    };
  }

  _buildUserRecordFromPeer(peer) {
    if (!peer?.id) {
      return null;
    }
    const username = typeof peer.username === 'string' && peer.username ? peer.username : null;
    let displayName = null;
    if (typeof peer.displayName === 'string' && peer.displayName.trim()) {
      displayName = peer.displayName.trim();
    } else {
      const nameParts = [peer.firstName, peer.lastName].filter(Boolean);
      displayName = nameParts.length ? nameParts.join(' ') : null;
    }
    const peerType = normalizePeerType(peer);
    const isBot = typeof peer.isBot === 'boolean' ? (peer.isBot ? 1 : 0) : null;
    const phone = typeof peer.phoneNumber === 'string' && peer.phoneNumber.trim()
      ? peer.phoneNumber.trim()
      : null;
    const isContact = typeof peer.isContact === 'boolean' ? (peer.isContact ? 1 : 0) : null;

    return {
      user_id: peer.id.toString(),
      peer_type: peerType,
      username,
      display_name: displayName,
      phone,
      is_contact: isContact,
      is_bot: isBot,
    };
  }

  _buildUserRecordFromSerialized(message) {
    if (!message?.from_id) {
      return null;
    }
    const userId = String(message.from_id);
    if (!userId || userId === 'unknown') {
      return null;
    }
    const username = message.from_username ?? null;
    const displayName = message.from_display_name ?? null;
    const peerType = message.from_peer_type ?? null;
    const isBot = typeof message.from_is_bot === 'boolean' ? (message.from_is_bot ? 1 : 0) : null;
    if (!username && !displayName && !peerType && isBot === null) {
      return null;
    }

    return {
      user_id: userId,
      peer_type: peerType,
      username,
      display_name: displayName,
      phone: null,
      is_contact: null,
      is_bot: isBot,
    };
  }

  _getChannel(channelId) {
    return this.db.prepare(`
      SELECT channel_id, peer_title, peer_type, username, sync_enabled,
             last_message_id, last_message_date, oldest_message_id, oldest_message_date
      FROM channels
      WHERE channel_id = ?
    `).get(channelId);
  }

  _getChannelWithMetadata(channelId) {
    return this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.chat_type,
        channels.is_forum,
        channels.username,
        channel_metadata.about,
        channel_metadata.updated_at AS metadata_updated_at
      FROM channels
      LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
      WHERE channels.channel_id = ?
    `).get(channelId);
  }

  _isMetadataStale(updatedAt) {
    if (!updatedAt) {
      return true;
    }
    const ts = new Date(updatedAt).getTime();
    if (Number.isNaN(ts)) {
      return true;
    }
    return Date.now() - ts > METADATA_TTL_MS;
  }

  _updateChannelCursors(channelId, { lastMessageId, lastMessageDate, oldestMessageId, oldestMessageDate }) {
    const existing = this._getChannel(channelId);
    if (!existing) {
      return;
    }

    let nextLastId = existing.last_message_id || 0;
    let nextLastDate = existing.last_message_date || null;
    if (Number.isFinite(lastMessageId) && lastMessageId > nextLastId) {
      nextLastId = lastMessageId;
      nextLastDate = lastMessageDate || nextLastDate;
    }

    let nextOldestId = existing.oldest_message_id || null;
    let nextOldestDate = existing.oldest_message_date || null;
    if (Number.isFinite(oldestMessageId) && (!nextOldestId || oldestMessageId < nextOldestId)) {
      nextOldestId = oldestMessageId;
      nextOldestDate = oldestMessageDate || nextOldestDate;
    }

    this.db.prepare(`
      UPDATE channels
      SET last_message_id = ?,
          last_message_date = ?,
          oldest_message_id = ?,
          oldest_message_date = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE channel_id = ?
    `).run(
      nextLastId,
      nextLastDate,
      nextOldestId,
      nextOldestDate,
      channelId,
    );
  }

  _ensureChannelFromPeer(channelId, peer) {
    const peerTitle = peer?.displayName ?? null;
    const peerType = normalizePeerType(peer);
    const username = peer?.username ?? null;
    const chatType = typeof peer?.chatType === 'string' ? peer.chatType : null;
    const isForum = typeof peer?.isForum === 'boolean' ? (peer.isForum ? 1 : 0) : null;
    return this.upsertChannelStmt.get({
      channel_id: channelId,
      peer_title: peerTitle,
      peer_type: peerType,
      chat_type: chatType,
      is_forum: isForum,
      username,
    });
  }

  _isChannelActive(channelId) {
    const row = this.db.prepare(`
      SELECT sync_enabled
      FROM channels
      WHERE channel_id = ?
    `).get(channelId);

    if (!row) {
      return false;
    }
    return row.sync_enabled === 1;
  }

  _handleIncomingMessage(message, { isEdit }) {
    if (!message?.chat?.id) {
      return;
    }

    const channelId = String(message.chat.id);
    const channelRow = this._ensureChannelFromPeer(channelId, message.chat);
    const syncEnabled = channelRow ? channelRow.sync_enabled === 1 : this._isChannelActive(channelId);
    if (!syncEnabled) {
      return;
    }

    const senderRecord = this._buildUserRecordFromPeer(message.sender || message.from || message.author);
    if (senderRecord) {
      this.upsertUserStmt.run(senderRecord);
    }

    const serialized = this.telegramClient._serializeMessage(message, message.chat);
    const record = this._buildMessageRecord(channelId, serialized);

    if (isEdit) {
      this.upsertMessageStmt.run(record);
      this._replaceMessageLinks(record);
      this._replaceMessageMedia(record);
    } else {
      this.insertMessageStmt.run(record);
      this._replaceMessageLinks(record);
      this._replaceMessageMedia(record);
    }

    const messageDate = toIsoString(serialized.date);
    this._updateChannelCursors(channelId, {
      lastMessageId: serialized.id,
      lastMessageDate: messageDate,
      oldestMessageId: serialized.id,
      oldestMessageDate: messageDate,
    });
  }

  _handleDeleteMessage(update) {
    if (!update?.messageIds?.length) {
      return;
    }

    const ids = update.messageIds;
    const placeholders = ids.map(() => '?').join(', ');

    if (update.channelId) {
      const channelId = normalizeChannelKey(update.channelId);
      this.db.prepare(`
        DELETE FROM messages
        WHERE channel_id = ? AND message_id IN (${placeholders})
      `).run(channelId, ...ids);
      this.db.prepare(`
        DELETE FROM message_links
        WHERE channel_id = ? AND message_id IN (${placeholders})
      `).run(channelId, ...ids);
      this.db.prepare(`
        DELETE FROM message_media
        WHERE channel_id = ? AND message_id IN (${placeholders})
      `).run(channelId, ...ids);
      return;
    }

    this.db.prepare(`
      DELETE FROM messages
      WHERE message_id IN (${placeholders})
        AND channel_id IN (
          SELECT channel_id FROM channels WHERE peer_type IN ('chat', 'user')
        )
    `).run(...ids);
    this.db.prepare(`
      DELETE FROM message_links
      WHERE message_id IN (${placeholders})
        AND channel_id IN (
          SELECT channel_id FROM channels WHERE peer_type IN ('chat', 'user')
        )
    `).run(...ids);
    this.db.prepare(`
      DELETE FROM message_media
      WHERE message_id IN (${placeholders})
        AND channel_id IN (
          SELECT channel_id FROM channels WHERE peer_type IN ('chat', 'user')
        )
    `).run(...ids);
  }

  _handleChannelTooLong({ channelId, diff }) {
    if (!diff?.messages?.length) {
      return;
    }

    const peers = PeersIndex.from(diff);
    const records = [];
    const userRecords = new Map();
    let batchChannelId = null;
    let latestMessageId = null;
    let latestMessageDate = null;
    let oldestMessageId = null;
    let oldestMessageDate = null;

    for (const rawMessage of diff.messages) {
      if (rawMessage._ === 'messageEmpty') {
        continue;
      }
      const message = new Message(rawMessage, peers);
      const channelKey = String(message.chat?.id ?? normalizeChannelKey(channelId));
      batchChannelId = batchChannelId ?? channelKey;

      const channelRow = this._ensureChannelFromPeer(channelKey, message.chat);
      const syncEnabled = channelRow ? channelRow.sync_enabled === 1 : this._isChannelActive(channelKey);
      if (!syncEnabled) {
        continue;
      }

      const senderRecord = this._buildUserRecordFromPeer(message.sender || message.from || message.author);
      if (senderRecord) {
        userRecords.set(senderRecord.user_id, senderRecord);
      }

      const serialized = this.telegramClient._serializeMessage(message, message.chat);
      records.push(this._buildMessageRecord(channelKey, serialized));

      const messageDateIso = toIsoString(serialized.date);
      if (Number.isFinite(serialized.id)) {
        if (!latestMessageId || serialized.id > latestMessageId) {
          latestMessageId = serialized.id;
          latestMessageDate = messageDateIso;
        }
        if (!oldestMessageId || serialized.id < oldestMessageId) {
          oldestMessageId = serialized.id;
          oldestMessageDate = messageDateIso;
        }
      }
    }

    if (!records.length || !batchChannelId) {
      return;
    }

    if (userRecords.size) {
      this.upsertUsersTx([...userRecords.values()]);
    }

    this.insertMessagesTx(records);

    this._updateChannelCursors(batchChannelId, {
      lastMessageId: latestMessageId,
      lastMessageDate: latestMessageDate,
      oldestMessageId: oldestMessageId,
      oldestMessageDate: oldestMessageDate,
    });

    void this._syncNewerMessages(batchChannelId);
  }

  async _syncNewerMessages(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
    const channel = this._getChannel(normalizedId);
    if (!channel || channel.sync_enabled !== 1) {
      return { hasMoreNewer: false, stoppedEarly: false };
    }

    let minId = channel.last_message_id || 0;
    let lastMessageId = channel.last_message_id || 0;
    let lastMessageDate = channel.last_message_date || null;
    let oldestMessageId = channel.oldest_message_id || null;
    let oldestMessageDate = channel.oldest_message_date || null;
    let hasMoreNewer = false;
    let stoppedEarly = false;
    let peerTitle = channel.peer_title;
    let peerType = channel.peer_type;

    while (true) {
      if (this.stopRequested) {
        stoppedEarly = true;
        break;
      }
      const { peerTitle: title, peerType: type, messages } = await this.telegramClient.getMessagesByChannelId(
        normalizedId,
        this.batchSize,
        { minId },
      );

      if (this.stopRequested) {
        stoppedEarly = true;
        break;
      }

      peerTitle = title ?? peerTitle;
      peerType = type ?? peerType;

      const newMessages = messages
        .filter((msg) => msg.id > minId)
        .sort((a, b) => a.id - b.id);

      if (!newMessages.length) {
        hasMoreNewer = false;
        break;
      }

      const userRecords = new Map();
      for (const message of newMessages) {
        const userRecord = this._buildUserRecordFromSerialized(message);
        if (userRecord) {
          userRecords.set(userRecord.user_id, userRecord);
        }
      }

      const records = newMessages.map((msg) => this._buildMessageRecord(normalizedId, msg));
      this.insertMessagesTx(records);
      if (userRecords.size) {
        this.upsertUsersTx([...userRecords.values()]);
      }

      const newest = newMessages[newMessages.length - 1];
      const oldest = newMessages[0];

      lastMessageId = newest.id;
      lastMessageDate = toIsoString(newest.date) || lastMessageDate;

      if (!oldestMessageId || oldest.id < oldestMessageId) {
        oldestMessageId = oldest.id;
        oldestMessageDate = toIsoString(oldest.date) || oldestMessageDate;
      }

      minId = newest.id;
      hasMoreNewer = newMessages.length >= this.batchSize;

      if (!hasMoreNewer || this.stopRequested) {
        if (this.stopRequested) {
          stoppedEarly = true;
        }
        break;
      }

      await delay(this.interBatchDelayMs);
    }

    if (peerTitle || peerType) {
      this.upsertChannelStmt.get({
        channel_id: normalizedId,
        peer_title: peerTitle ?? null,
        peer_type: peerType ?? null,
        chat_type: null,
        is_forum: null,
        username: channel.username ?? null,
      });
    }

    this._updateChannelCursors(normalizedId, {
      lastMessageId,
      lastMessageDate,
      oldestMessageId,
      oldestMessageDate,
    });

    return {
      hasMoreNewer,
      lastMessageId,
      oldestMessageId,
      stoppedEarly,
    };
  }

  async _backfillHistory(job, currentCount, targetCount) {
    if (currentCount >= targetCount) {
      return {
        finalCount: currentCount,
        oldestMessageId: null,
        oldestMessageDate: null,
        hasMoreOlder: false,
        insertedCount: 0,
        cursorMessageId: job.cursor_message_id ?? null,
        cursorMessageDate: job.cursor_message_date ?? null,
        stoppedEarly: false,
      };
    }

    const channelId = normalizeChannelKey(job.channel_id);
    const channel = this._getChannel(channelId);
    const peer = await this.telegramClient.client.resolvePeer(normalizeChannelId(channelId));
    const minDateSeconds = job.backfill_min_date ? parseIsoDate(job.backfill_min_date) : null;

    let total = currentCount;
    let currentOldestId = channel?.oldest_message_id ?? null;
    let currentOldestDate = channel?.oldest_message_date ?? null;
    let insertedCount = 0;
    let nextOffsetId = job.cursor_message_id ?? currentOldestId ?? channel?.last_message_id ?? 0;
    let nextOffsetDate = null;
    if (job.cursor_message_date) {
      nextOffsetDate = parseIsoDate(job.cursor_message_date);
    } else if (currentOldestDate) {
      nextOffsetDate = parseIsoDate(currentOldestDate);
    } else if (channel?.last_message_date) {
      nextOffsetDate = parseIsoDate(channel.last_message_date);
    }
    let stopDueToDate = false;
    let stoppedEarly = false;

    while (total < targetCount) {
      if (this.stopRequested) {
        stoppedEarly = true;
        break;
      }
      if (nextOffsetId !== 0 && nextOffsetId <= 1) {
        break;
      }

      const chunkLimit = Math.min(this.batchSize, targetCount - total);
      const iterator = this.telegramClient.client.iterHistory(peer, {
        limit: chunkLimit,
        chunkSize: chunkLimit,
        reverse: false,
        offset: { id: nextOffsetId, date: nextOffsetDate ?? 0 },
        addOffset: 0,
      });

      const records = [];
      const userRecords = new Map();
      let lowestIdInChunk = null;
      let lowestDateInChunk = null;
      let lowestDateSecondsInChunk = null;

      for await (const message of iterator) {
        if (this.stopRequested) {
          stoppedEarly = true;
          break;
        }
        const serialized = this.telegramClient._serializeMessage(message, peer);
        if (minDateSeconds && serialized.date && serialized.date < minDateSeconds) {
          stopDueToDate = true;
          break;
        }

        const senderRecord = this._buildUserRecordFromPeer(message.sender || message.from || message.author);
        if (senderRecord) {
          userRecords.set(senderRecord.user_id, senderRecord);
        }

        records.push(this._buildMessageRecord(channelId, serialized));

        if (!lowestIdInChunk || serialized.id < lowestIdInChunk) {
          lowestIdInChunk = serialized.id;
          lowestDateSecondsInChunk = serialized.date ?? null;
          lowestDateInChunk = toIsoString(serialized.date);
        }
      }

      if (this.stopRequested) {
        break;
      }

      if (!records.length) {
        break;
      }

      if (userRecords.size) {
        this.upsertUsersTx([...userRecords.values()]);
      }

      const inserted = this.insertMessagesTx(records);

      total += inserted;
      insertedCount += inserted;

      const previousOffsetId = nextOffsetId;
      const previousOffsetDate = nextOffsetDate ?? 0;
      nextOffsetId = lowestIdInChunk ?? nextOffsetId;
      if (Number.isFinite(lowestDateSecondsInChunk)) {
        nextOffsetDate = lowestDateSecondsInChunk;
      }

      if (lowestIdInChunk && (!currentOldestId || lowestIdInChunk < currentOldestId)) {
        currentOldestId = lowestIdInChunk;
        currentOldestDate = lowestDateInChunk || currentOldestDate;
      }

      // Persist live progress after every batch so the control API and idle
      // monitor see the archived count and resume cursor advance mid-run, not
      // just on terminal completion. `started_at` is stamped on the first batch.
      this._updateJobProgress(job.id, {
        messageCount: this._countMessages(channelId),
        cursorMessageId: nextOffsetId ?? null,
        cursorMessageDate: Number.isFinite(nextOffsetDate) && nextOffsetDate > 0
          ? toIsoString(nextOffsetDate)
          : null,
      });

      if (nextOffsetId === previousOffsetId && (nextOffsetDate ?? 0) === previousOffsetDate) {
        break;
      }

      if (stopDueToDate || total >= targetCount || this.stopRequested) {
        if (this.stopRequested) {
          stoppedEarly = true;
        }
        break;
      }

      await delay(this.interBatchDelayMs);
    }

    if (currentOldestId) {
      this._updateChannelCursors(channelId, {
        oldestMessageId: currentOldestId,
        oldestMessageDate: currentOldestDate,
      });
    }

    return {
      finalCount: this._countMessages(channelId),
      oldestMessageId: currentOldestId,
      oldestMessageDate: currentOldestDate,
      hasMoreOlder: insertedCount > 0 && total < targetCount && !stopDueToDate && !stoppedEarly,
      insertedCount,
      cursorMessageId: nextOffsetId ?? job.cursor_message_id ?? null,
      cursorMessageDate: Number.isFinite(nextOffsetDate) && nextOffsetDate > 0
        ? toIsoString(nextOffsetDate)
        : job.cursor_message_date ?? null,
      stoppedEarly,
    };
  }
}
