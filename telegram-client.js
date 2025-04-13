import MTProto from '@mtproto/core';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';

// Get current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TelegramClient {
  constructor(apiId, apiHash, phoneNumber, sessionPath = './data/session.json') {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.phoneNumber = phoneNumber;
    this.sessionPath = path.resolve(sessionPath);
    
    // Create data directory if it doesn't exist
    const dataDir = path.dirname(this.sessionPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize dialog cache for storing access hashes
    this.dialogCache = new Map();

    // Initialize the MTProto client
    this.mtproto = new MTProto({
      api_id: this.apiId,
      api_hash: this.apiHash,
      storageOptions: {
        path: this.sessionPath,
      },
    });
  }

  // Helper function to prompt for user input
  async _askQuestion(query) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, answer => {
      rl.close();
      resolve(answer);
    }));
  }

  // Check if session exists
  hasSession() {
    return fs.existsSync(this.sessionPath);
  }

  // Log in to Telegram
  async login() {
    try {
      // Check if session file exists
      if (this.hasSession()) {
        console.log('Session file found, attempting to use existing session.');
        // If the session file exists, the MTProto client should automatically use it
        return true;
      }

      // Request to send a code to the user's phone
      const { phone_code_hash } = await this.mtproto.call('auth.sendCode', {
        phone_number: this.phoneNumber,
        settings: {
          _: 'codeSettings',
        },
      });

      // Ask the user to enter the code they received
      const code = await this._askQuestion('Enter the code you received: ');

      let signInResult;
      try {
        // Attempt to sign in using the code
        signInResult = await this.mtproto.call('auth.signIn', {
          phone_number: this.phoneNumber,
          phone_code_hash,
          phone_code: code,
        });
      } catch (error) {
        if (error.error_message === 'SESSION_PASSWORD_NEEDED') {
          // If 2FA is enabled, ask for the password
          const password = await this._askQuestion('Enter your 2FA password: ');

          // Get the password hash
          const { srp_id, current_algo, srp_B } = await this.mtproto.call('account.getPassword');
          const { g, p, salt1, salt2 } = current_algo;

          // Compute the password hash
          const { A, M1 } = await this.mtproto.crypto.getSRPParams({
            g,
            p,
            salt1,
            salt2,
            gB: srp_B,
            password,
          });

          // Complete the sign-in process with the password
          signInResult = await this.mtproto.call('auth.checkPassword', {
            password: {
              _: 'inputCheckPasswordSRP',
              srp_id,
              A,
              M1,
            },
          });
        } else {
          throw error;
        }
      }

      console.log('Logged in successfully!');
      return true;
    } catch (error) {
      console.error('Error during login:', error);
      return false;
    }
  }

  // Get all dialogs (chats)
  async getDialogs(limit = 100, offset = 0) {
    try {
      console.log(`Fetching up to ${limit} dialogs with offset ${offset}`);
      
      const result = await this.mtproto.call('messages.getDialogs', {
        offset,
        limit,
        offset_peer: { _: 'inputPeerSelf' },
      });

      console.log(`Retrieved ${result.chats.length} chats`);
      
      // Update dialog cache with the received chats
      this._updateDialogCache(result.chats);
      
      return {
        chats: result.chats,
        users: result.users,
        messages: result.messages,
        dialogs: result.dialogs
      };
    } catch (error) {
      console.error('Error fetching dialogs:', error);
      throw error;
    }
  }
  
  // Get all dialogs by making multiple requests
  async getAllDialogs(batchSize = 100) {
    try {
      console.log('Fetching all dialogs...');
      
      let allChats = [];
      let allUsers = [];
      let allMessages = [];
      let allDialogs = [];
      
      let offset = 0;
      let hasMore = true;
      
      while (hasMore) {
        const result = await this.mtproto.call('messages.getDialogs', {
          offset,
          limit: batchSize,
          offset_peer: { _: 'inputPeerSelf' },
        });
        
        allChats = [...allChats, ...result.chats];
        allUsers = [...allUsers, ...result.users];
        allMessages = [...allMessages, ...result.messages];
        allDialogs = [...allDialogs, ...result.dialogs];
        
        // Update the dialog cache with the received chats
        this._updateDialogCache(result.chats);
        
        // Check if we received fewer dialogs than requested, which means we've reached the end
        if (result.dialogs.length < batchSize) {
          hasMore = false;
        } else {
          offset += batchSize;
        }
        
        console.log(`Retrieved ${result.chats.length} chats at offset ${offset}`);
      }
      
      console.log(`Total chats retrieved: ${allChats.length}`);
      
      return {
        chats: allChats,
        users: allUsers,
        messages: allMessages,
        dialogs: allDialogs
      };
    } catch (error) {
      console.error('Error fetching all dialogs:', error);
      throw error;
    }
  }
  
  // Update the dialog cache with chat information
  _updateDialogCache(chats) {
    if (!chats || !Array.isArray(chats)) return;
    
    for (const chat of chats) {
      if (!chat || !chat.id) continue;
      
      // Store only channels and users that have access_hash
      if ((chat._ === 'channel' || chat._ === 'user') && chat.access_hash) {
        this.dialogCache.set(chat.id, {
          type: chat._,
          id: chat.id,
          access_hash: chat.access_hash,
          title: chat.title || chat.username || chat.first_name
        });
      } else if (chat._ === 'chat') {
        this.dialogCache.set(chat.id, {
          type: chat._,
          id: chat.id,
          title: chat.title
        });
      }
    }
  }
  
  // Get peer input for a chat by ID
  getPeerInputById(id) {
    const cachedChat = this.dialogCache.get(`${id}`);
    
    if (!cachedChat) {
      throw new Error(`Chat with ID ${id} not found in cache. Run getAllDialogs first.`);
    }
    
    if (cachedChat.type === 'channel') {
      return {
        _: 'inputPeerChannel',
        channel_id: cachedChat.id,
        access_hash: cachedChat.access_hash,
      };
    } else if (cachedChat.type === 'chat') {
      return {
        _: 'inputPeerChat',
        chat_id: cachedChat.id,
      };
    } else if (cachedChat.type === 'user') {
      return {
        _: 'inputPeerUser',
        user_id: cachedChat.id,
        access_hash: cachedChat.access_hash,
      };
    }
    
    throw new Error(`Unsupported chat type: ${cachedChat.type}`);
  }

  // Get messages from a specific chat
  async getChatMessages(chat, limit = 100) {
    try {
      if (!chat || !chat.id) {
        throw new Error('Invalid chat object provided');
      }

      // Determine the correct peer type based on chat properties
      let peer;
      if (chat._ === 'channel' || chat._ === 'channelForbidden') {
        peer = {
          _: 'inputPeerChannel',
          channel_id: chat.id,
          access_hash: chat.access_hash,
        };
      } else if (chat._ === 'chat' || chat._ === 'chatForbidden') {
        peer = {
          _: 'inputPeerChat',
          chat_id: chat.id,
        };
      } else if (chat._ === 'user') {
        peer = {
          _: 'inputPeerUser',
          user_id: chat.id,
          access_hash: chat.access_hash,
        };
      } else {
        throw new Error(`Unsupported chat type: ${chat._}`);
      }

      console.log(`Fetching up to ${limit} messages from chat: ${chat.title || chat.id}`);
      
      const messagesResult = await this.mtproto.call('messages.getHistory', {
        peer,
        offset_id: 0,
        offset_date: 0,
        add_offset: 0,
        limit,
        max_id: 0,
        min_id: 0,
        hash: 0,
      });

      return messagesResult.messages;
    } catch (error) {
      console.error('Error fetching chat messages:', error);
      throw error;
    }
  }

  // Filter messages by a regex pattern
  filterMessagesByPattern(messages, pattern) {
    if (!messages || !Array.isArray(messages)) {
      return [];
    }
    
    const regex = new RegExp(pattern);
    return messages
      .map(msg => msg.message || '')
      .filter(msg => regex.test(msg));
  }

  // Get messages from a specific chat using ID
  async getMessagesByChannelId(channelId, limit = 100) {
    try {
      // Convert string IDs to numbers if necessary
      const id = typeof channelId === 'string' ? parseInt(channelId, 10) : channelId;
      
      if (isNaN(id)) {
        throw new Error('Invalid channel ID provided');
      }
      
      // Get peer input from cache
      const peer = this.getPeerInputById(id);
      const cachedChat = this.dialogCache.get(`${id}`);
      
      console.log(`Fetching up to ${limit} messages from channel ID ${id} (${cachedChat.title || 'Unknown'})`);
      
      const messagesResult = await this.mtproto.call('messages.getHistory', {
        peer,
        offset_id: 0,
        offset_date: 0,
        add_offset: 0,
        limit,
        max_id: 0,
        min_id: 0,
        hash: 0,
      });

      return messagesResult.messages;
    } catch (error) {
      console.error('Error fetching channel messages:', error);
      throw error;
    }
  }
  
  // Save dialog cache to file
  async saveDialogCache(cachePath = './data/dialog_cache.json') {
    try {
      const resolvedPath = path.resolve(cachePath);
      const cacheDir = path.dirname(resolvedPath);
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      
      // Convert Map to object for serialization
      const cacheObject = Object.fromEntries(this.dialogCache);
      
      fs.writeFileSync(resolvedPath, JSON.stringify(cacheObject, null, 2));
      console.log(`Dialog cache saved to ${resolvedPath}`);
      
      return true;
    } catch (error) {
      console.error('Error saving dialog cache:', error);
      return false;
    }
  }
  
  // Load dialog cache from file
  async loadDialogCache(cachePath = './data/dialog_cache.json') {
    try {
      const resolvedPath = path.resolve(cachePath);
      
      if (!fs.existsSync(resolvedPath)) {
        console.log(`Dialog cache file not found at ${resolvedPath}`);
        return false;
      }
      
      const cacheData = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      
      // Convert object back to Map
      this.dialogCache = new Map(Object.entries(cacheData));
      
      console.log(`Dialog cache loaded from ${resolvedPath} with ${this.dialogCache.size} entries`);

      return true;
    } catch (error) {
      console.error('Error loading dialog cache:', error);
      return false;
    }
  }
}

export default TelegramClient; 