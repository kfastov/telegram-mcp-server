import { TelegramClient as MtCuteClient } from '@mtcute/node';
import readline from 'readline';
import path from 'path';
import fs from 'fs';

function sanitizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value;
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
  const type = peer.type;
  if (type === 'user' || type === 'bot') return 'user';
  if (type === 'channel') return 'channel';
  return 'chat';
}

class TelegramClient {
  constructor(apiId, apiHash, phoneNumber, sessionPath = './data/session.json') {
    this.apiId = coerceApiId(apiId);
    this.apiHash = sanitizeString(apiHash);
    this.phoneNumber = sanitizeString(phoneNumber);
    this.sessionPath = path.resolve(sessionPath);

    const sessionDir = path.dirname(this.sessionPath);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    this.client = new MtCuteClient({
      apiId: this.apiId,
      apiHash: this.apiHash,
      storage: this.sessionPath,
    });

    this.dialogCache = new Map();
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
    const authorized = await this._isAuthorized();
    if (!authorized) {
      throw new Error('Not logged in to Telegram. Please restart the server.');
    }
    return true;
  }

  async initializeDialogCache() {
    console.log('Initializing dialog cache...');
    const loginSuccess = await this.login();
    if (!loginSuccess) {
      throw new Error('Failed to login to Telegram. Cannot proceed.');
    }

    await this._refreshDialogCache();

    console.log(`Dialog cache initialized with ${this.dialogCache.size} entries`);
    return true;
  }

  async _refreshDialogCache(limit = 0) {
    this.dialogCache.clear();
    let processed = 0;

    for await (const dialog of this.client.iterDialogs({})) {
      const peer = dialog.peer;
      if (!peer) {
        continue;
      }

      const id = peer.id.toString();
      const title = peer.displayName || 'Unknown';
      const username = 'username' in peer ? peer.username ?? null : null;

      this.dialogCache.set(id, {
        id,
        type: normalizePeerType(peer),
        title,
        username,
        access_hash: 'N/A',
      });

      processed += 1;
      if (limit > 0 && processed >= limit) {
        break;
      }
    }

    console.log(`Loaded ${this.dialogCache.size} dialogs into cache`);
    return this.dialogCache.size;
  }

  _getCachedChat(channelId) {
    const cacheKey = String(channelId);
    const cachedChat = this.dialogCache.get(cacheKey);
    if (!cachedChat) {
      throw new Error(`Channel with ID ${channelId} not found in cache.`);
    }
    return cachedChat;
  }

  async getMessagesByChannelId(channelId, limit = 100) {
    let cachedChat = this.dialogCache.get(String(channelId));
    if (!cachedChat) {
      await this._refreshDialogCache();
      cachedChat = this.dialogCache.get(String(channelId));
      if (!cachedChat) {
        throw new Error(`Channel with ID ${channelId} not found in cache.`);
      }
    }
    let peerRef = cachedChat.username || cachedChat.id;
    const numericId = Number(cachedChat.id);
    if (!cachedChat.username && !Number.isNaN(numericId)) {
      peerRef = numericId;
    }

    const peer = await this.client.resolvePeer(peerRef);

    const messages = [];
    for await (const message of this.client.iterHistory(peer, { limit })) {
      messages.push(this._serializeMessage(message, cachedChat));
      if (messages.length >= limit) {
        break;
      }
    }

    return messages;
  }

  _serializeMessage(message, cachedChat) {
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
      peer_type: cachedChat.type,
      peer_id: cachedChat.id,
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
}

export default TelegramClient;
