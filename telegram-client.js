import { TelegramClient as MtCuteClient } from '@mtcute/node';
import readline from 'readline';
import path from 'path';
import fs from 'fs';

function sanitizeString(value) {
  return typeof value === 'string' ? value : '';
}

function coerceApiId(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  throw new Error('TELEGRAM_API_ID must be a number');
}

function normalizePeerType(peer) {
  if (!peer) return 'chat';
  if (peer.type === 'user' || peer.type === 'bot') return 'user';
  if (peer.type === 'channel') return 'channel';
  return 'chat';
}

export function normalizeChannelId(channelId) {
  if (typeof channelId === 'number') {
    return channelId;
  }
  if (typeof channelId === 'bigint') {
    return Number(channelId);
  }
  if (typeof channelId === 'string') {
    const trimmed = channelId.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isNaN(numeric)) {
        return numeric;
      }
    }
    return trimmed;
  }
  throw new Error('Invalid channel ID provided');
}

class TelegramClient {
  constructor(apiId, apiHash, phoneNumber, sessionPath = './data/session.json') {
    this.apiId = coerceApiId(apiId);
    this.apiHash = sanitizeString(apiHash);
    this.phoneNumber = sanitizeString(phoneNumber);
    this.sessionPath = path.resolve(sessionPath);

    const dataDir = path.dirname(this.sessionPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.client = new MtCuteClient({
      apiId: this.apiId,
      apiHash: this.apiHash,
      storage: this.sessionPath,
    });
  }

  _isUnauthorizedError(error) {
    if (!error) return false;
    const code = error.code || error.status || error.errorCode;
    if (code === 401) {
      return true;
    }
    const message = (error.errorMessage || error.message || '').toUpperCase();
    return message.includes('AUTH_KEY') || message.includes('AUTHORIZATION') || message.includes('SESSION_PASSWORD_NEEDED');
  }

  async _isAuthorized() {
    try {
      await this.client.getMe();
      return true;
    } catch (error) {
      if (this._isUnauthorizedError(error)) {
        return false;
      }
      throw error;
    }
  }

  async _askQuestion(prompt) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise(resolve => {
      rl.question(prompt, answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  async login() {
    try {
      if (await this._isAuthorized()) {
        console.log('Existing session is valid.');
        return true;
      }

      if (!this.phoneNumber) {
        throw new Error('TELEGRAM_PHONE_NUMBER is not configured.');
      }

      await this.client.start({
        phone: this.phoneNumber,
        code: async () => await this._askQuestion('Enter the code you received: '),
        password: async () => {
          const value = await this._askQuestion('Enter your 2FA password (leave empty if not enabled): ');
          return value.length ? value : undefined;
        },
      });

      console.log('Logged in successfully!');
      return true;
    } catch (error) {
      console.error('Error during login:', error);
      return false;
    }
  }

  async ensureLogin() {
    if (!(await this._isAuthorized())) {
      throw new Error('Not logged in to Telegram. Please restart the server.');
    }
    return true;
  }

  async initializeDialogCache() {
    console.log('Initializing dialog list...');
    const loginSuccess = await this.login();
    if (!loginSuccess) {
      throw new Error('Failed to login to Telegram. Cannot proceed.');
    }
    console.log('Dialogs ready.');
    return true;
  }

  async listDialogs(limit = 50) {
    await this.ensureLogin();
    const effectiveLimit = limit && limit > 0 ? limit : Infinity;
    const results = [];

    for await (const dialog of this.client.iterDialogs({})) {
      const peer = dialog.peer;
      if (!peer) continue;

      const id = peer.id.toString();
      const username = 'username' in peer ? peer.username ?? null : null;
      results.push({
        id,
        type: normalizePeerType(peer),
        title: peer.displayName || 'Unknown',
        username,
      });

      if (results.length >= effectiveLimit) {
        break;
      }
    }

    return results;
  }

  async searchDialogs(keyword, limit = 100) {
    const query = sanitizeString(keyword).trim().toLowerCase();
    if (!query) {
      return [];
    }

    await this.ensureLogin();
    const results = [];

    for await (const dialog of this.client.iterDialogs({})) {
      const peer = dialog.peer;
      if (!peer) continue;

      const title = (peer.displayName || '').toLowerCase();
      const username = ('username' in peer && peer.username ? peer.username : '').toLowerCase();

      if (title.includes(query) || username.includes(query)) {
        results.push({
          id: peer.id.toString(),
          type: normalizePeerType(peer),
          title: peer.displayName || 'Unknown',
          username: 'username' in peer ? peer.username ?? null : null,
        });
      }

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  async getMessagesByChannelId(channelId, limit = 100, options = {}) {
    await this.ensureLogin();

    const {
      minId = 0,
      maxId = 0,
      reverse = false,
    } = options;
    const peerRef = normalizeChannelId(channelId);
    const peer = await this.client.resolvePeer(peerRef);

    const effectiveLimit = limit && limit > 0 ? limit : 100;
    const messages = [];

    const iterOptions = {
      limit: effectiveLimit,
      chunkSize: Math.min(effectiveLimit, 100),
      reverse,
    };

    if (minId) {
      iterOptions.minId = minId;
    }

    if (maxId) {
      iterOptions.maxId = maxId;
    }

    for await (const message of this.client.iterHistory(peer, iterOptions)) {
      messages.push(this._serializeMessage(message, peer));
      if (messages.length >= effectiveLimit) {
        break;
      }
    }

    return {
      peerTitle: peer?.displayName || 'Unknown',
      peerId: peer?.id?.toString?.() ?? String(channelId),
      peerType: normalizePeerType(peer),
      messages,
    };
  }

  _serializeMessage(message, peer) {
    const id = typeof message.id === 'number' ? message.id : Number(message.id || 0);
    let dateSeconds = null;
    if (message.date instanceof Date) {
      dateSeconds = Math.floor(message.date.getTime() / 1000);
    } else if (typeof message.date === 'number') {
      dateSeconds = Math.floor(message.date);
    }

    let textContent = '';
    if (typeof message.text === 'string') {
      textContent = message.text;
    } else if (typeof message.message === 'string') {
      textContent = message.message;
    } else if (message.text && typeof message.text.toString === 'function') {
      textContent = message.text.toString();
    }

    const sender = message.sender || message.from || message.author;
    const senderId = sender?.id ? sender.id.toString() : 'unknown';

    return {
      id,
      date: dateSeconds,
      message: textContent,
      text: textContent,
      from_id: senderId,
      peer_type: normalizePeerType(peer),
      peer_id: peer?.id?.toString?.() ?? 'unknown',
      raw: message.raw ?? null,
    };
  }

  filterMessagesByPattern(messages, pattern) {
    if (!Array.isArray(messages)) {
      return [];
    }

    const regex = new RegExp(pattern);
    return messages
      .map(msg => (typeof msg === 'string' ? msg : msg.message || msg.text || ''))
      .filter(text => typeof text === 'string' && regex.test(text));
  }

  async destroy() {
    await this.client.destroy();
  }
}

export default TelegramClient;
