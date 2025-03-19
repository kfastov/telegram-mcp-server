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
}

export default TelegramClient; 