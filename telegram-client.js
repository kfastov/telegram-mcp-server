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
        console.log('Session file found, attempting to validate session.');
        try {
          // Attempt a simple API call to validate the session
          await this.mtproto.call('users.getUsers', {
            id: [{ _: 'inputUserSelf' }],
          });
          console.log('Existing session is valid.');
          return true; // Session is valid
        } catch (error) {
          console.warn(`Session validation failed: ${error.message || JSON.stringify(error)}. Assuming session is invalid.`);
          // Delete the invalid session file
          try {
            fs.unlinkSync(this.sessionPath);
            console.log('Deleted invalid session file.');
          } catch (unlinkError) {
            console.error('Error deleting invalid session file:', unlinkError);
          }
          // Proceed to log in again
        }
      }

      console.log('No valid session found. Starting login process...');
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

  // Helper function to add delay between API calls
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Initialize dialog cache with throttling to avoid FLOOD_WAIT
  async initializeDialogCache(dialogCachePath = './data/dialog_cache.json') {
    try {
      console.log('Initializing dialog cache...');
      
      // First, ensure we are logged in
      const loginSuccess = await this.login();
      if (!loginSuccess) {
        // Throw an error specifically for login failure
        throw new Error('Failed to login to Telegram. Cannot proceed.');
      }
      
      // Try to load existing cache
      let cacheLoaded = false;
      try {
        cacheLoaded = await this.loadDialogCache(dialogCachePath);
        console.log(`Dialog cache ${cacheLoaded ? 'loaded successfully' : 'not found or empty'}`);
      } catch (error) {
        console.log('Error loading dialog cache:', error.message);
      }
      
      // If cache is empty or couldn't be loaded, fetch dialogs with careful throttling
      if (!cacheLoaded || this.dialogCache.size === 0) {
        console.log('Fetching all dialogs with throttling...');
        
        let allChats = new Map(); // Use Map to prevent duplicates
        let lastDate = 0;         // Use date-based pagination
        let lastMsgId = 0;        // Track last message ID for pagination
        let lastPeer = null;      // Last peer for offset
        let hasMore = true;
        let batchSize = 100;
        let retryCount = 0;
        let batchCount = 0;
        const MAX_RETRIES = 3;
        
        while (hasMore && retryCount < MAX_RETRIES) {
          try {
            batchCount++;
            console.log(`Fetching dialogs batch #${batchCount} with date offset ${lastDate || 'none'}...`);
            
            // Call Telegram API with throttling and proper pagination
            const result = await this.mtproto.call('messages.getDialogs', {
              offset_date: lastDate,
              offset_id: lastMsgId,
              offset_peer: lastPeer || { _: 'inputPeerEmpty' },
              limit: batchSize,
              hash: 0
            });
            
            // Process the results
            if (result && result.chats && result.chats.length > 0) {
              const newChatCount = result.chats.length;
              const prevSize = allChats.size;
              
              // Add chats to our Map to de-duplicate
              result.chats.forEach(chat => {
                if (chat && chat.id) {
                  allChats.set(chat.id, chat);
                }
              });
              
              // Update dialog cache
              this._updateDialogCache(result.chats);
              
              console.log(`Retrieved ${newChatCount} chats (${allChats.size - prevSize} new), total unique now: ${allChats.size}`);
              
              // Check if we've reached the end based on received count or no dialogs
              if (!result.dialogs || result.dialogs.length === 0 || result.dialogs.length < batchSize) {
                hasMore = false;
                console.log('Reached end of dialogs (received less than requested)');
              } else if (result.dialogs.length > 0) {
                // Update pagination parameters from the last dialog
                const lastDialog = result.dialogs[result.dialogs.length - 1];
                const lastMessage = result.messages.find(m => m.id === lastDialog.top_message);
                
                if (lastMessage) {
                  lastDate = lastMessage.date;
                  lastMsgId = lastMessage.id;
                  lastPeer = lastDialog.peer;
                  
                  console.log(`Updated pagination: last_date=${lastDate}, last_msg_id=${lastMsgId}`);
                } else {
                  console.log('Could not find last message for pagination, stopping');
                  hasMore = false;
                }
                
                // Add delay to avoid rate limiting
                console.log(`Waiting 2 seconds before next batch...`);
                await this.delay(2000);
              } else {
                // No more dialogs
                hasMore = false;
              }
              
              // Safety check - if we get the same chats multiple times, stop
              if (batchCount > 1 && newChatCount === allChats.size && newChatCount === prevSize) {
                console.log('No new chats in this batch, likely reached the end');
                hasMore = false;
              }
            } else {
              // No results or unexpected response
              hasMore = false;
              console.log('No chats in response or unexpected response format');
            }
            
            // Reset retry counter on success
            retryCount = 0;
          } catch (error) {
            console.error(`Error fetching dialogs: ${error.message || JSON.stringify(error)}`);
            
            // Handle FLOOD_WAIT errors by waiting the specified time
            if (error.error_code === 420 && error.error_message) {
              const waitMatch = error.error_message.match(/FLOOD_WAIT_(\d+)/);
              if (waitMatch && waitMatch[1]) {
                const waitSeconds = parseInt(waitMatch[1], 10);
                console.log(`Rate limited, waiting ${waitSeconds} seconds before retrying...`);
                await this.delay(waitSeconds * 1000);
                retryCount++;
              } else {
                // Unknown flood wait, use exponential backoff
                const backoff = Math.pow(2, retryCount) * 5;
                console.log(`Unknown rate limit, backing off for ${backoff} seconds...`);
                await this.delay(backoff * 1000);
                retryCount++;
              }
            } else {
              // For other errors, back off and retry
              retryCount++;
              await this.delay(5000 * retryCount);
            }
          }
        }
        
        // Extract chats from Map for final count
        const finalChats = Array.from(allChats.values());
        console.log(`Finished fetching dialogs. Found ${finalChats.length} unique chats.`);
        
        // Save the cache after successful fetch
        try {
          await this.saveDialogCache(dialogCachePath);
        } catch (error) {
          console.error('Error saving dialog cache:', error.message);
        }
      }
      
      console.log(`Dialog cache initialized with ${this.dialogCache.size} entries`);
      return true;
    } catch (error) {
      console.error('Failed to initialize dialog cache:', error);
      return false;
    }
  }

  // Simplified login check
  async ensureLogin() {
    // Just verify we have a session
    if (!this.hasSession()) {
      throw new Error('Not logged in to Telegram. Please restart the server.');
    }
    return true;
  }
}

export default TelegramClient; 