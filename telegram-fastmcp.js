import { FastMCP } from "fastmcp";
import { z } from "zod"; // Or any validation library that supports Standard Schema
import TelegramClient from './telegram-client.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Cache path for dialog data
const DIALOG_CACHE_PATH = './data/dialog_cache.json';

// Initialize Telegram client
const telegramClient = new TelegramClient(
  process.env.TELEGRAM_API_ID,
  process.env.TELEGRAM_API_HASH,
  process.env.TELEGRAM_PHONE_NUMBER,
  './data/session.json'
);

// Helper function to add delay between API calls
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Initialize dialog cache with throttling to avoid FLOOD_WAIT
async function initializeDialogCache() {
  try {
    console.log('Initializing dialog cache...');
    
    // First, try to login if needed
    if (!telegramClient.hasSession()) {
      const loginSuccess = await telegramClient.login();
      if (!loginSuccess) {
        throw new Error('Failed to login to Telegram');
      }
    }
    
    // Try to load existing cache
    let cacheLoaded = false;
    try {
      cacheLoaded = await telegramClient.loadDialogCache(DIALOG_CACHE_PATH);
      console.log(`Dialog cache ${cacheLoaded ? 'loaded successfully' : 'not found or empty'}`);
    } catch (error) {
      console.log('Error loading dialog cache:', error.message);
    }
    
    // If cache is empty or couldn't be loaded, fetch dialogs with careful throttling
    if (!cacheLoaded || telegramClient.dialogCache.size === 0) {
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
          const result = await telegramClient.mtproto.call('messages.getDialogs', {
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
            telegramClient._updateDialogCache(result.chats);
            
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
              await delay(2000);
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
              await delay(waitSeconds * 1000);
              retryCount++;
            } else {
              // Unknown flood wait, use exponential backoff
              const backoff = Math.pow(2, retryCount) * 5;
              console.log(`Unknown rate limit, backing off for ${backoff} seconds...`);
              await delay(backoff * 1000);
              retryCount++;
            }
          } else {
            // For other errors, back off and retry
            retryCount++;
            await delay(5000 * retryCount);
          }
        }
      }
      
      // Extract chats from Map for final count
      const finalChats = Array.from(allChats.values());
      console.log(`Finished fetching dialogs. Found ${finalChats.length} unique chats.`);
      
      // Save the cache after successful fetch
      try {
        const cacheDir = path.dirname(DIALOG_CACHE_PATH);
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
        
        // Convert Map to object for serialization
        const cacheObject = Object.fromEntries(telegramClient.dialogCache);
        fs.writeFileSync(DIALOG_CACHE_PATH, JSON.stringify(cacheObject, null, 2));
        console.log(`Dialog cache saved with ${telegramClient.dialogCache.size} entries`);
      } catch (error) {
        console.error('Error saving dialog cache:', error.message);
      }
    }
    
    console.log(`Dialog cache initialized with ${telegramClient.dialogCache.size} entries`);
    return true;
  } catch (error) {
    console.error('Failed to initialize dialog cache:', error);
    return false;
  }
}

// Simplified login check for tools (cache already loaded at startup)
async function ensureLogin() {
  // Just verify we have a session, cache is already loaded at startup
  if (!telegramClient.hasSession()) {
    throw new Error('Not logged in to Telegram. Please restart the server.');
  }
  return true;
}

const server = new FastMCP({
  name: "My Server",
  version: "1.0.0",
});

server.addTool({
  name: "add",
  description: "Add two numbers",
  parameters: z.object({
    a: z.number(),
    b: z.number(),
  }),
  execute: async (args) => {
    return String(args.a + args.b);
  },
});

// Telegram tools
server.addTool({
  name: "listChannels",
  description: "Lists available Telegram channels/chats accessible by the account.",
  parameters: z.object({
    limit: z.number().optional().describe("Maximum number of channels to return (default: 50)"),
  }),
  execute: async (args) => {
    await ensureLogin();
    
    const limit = args.limit || 50;
    // Get from cache instead of making a new request
    const chatEntries = Array.from(telegramClient.dialogCache.entries()).slice(0, limit);
    const formattedChats = chatEntries.map(([id, chat]) => ({
      id: id,
      title: chat.title || 'Unknown',
      type: chat.type,
      access_hash: chat.access_hash || 'N/A'
    }));
    
    return `Retrieved ${formattedChats.length} channels/chats from cache (total in cache: ${telegramClient.dialogCache.size}).\n${JSON.stringify(formattedChats, null, 2)}`;
  },
});

server.addTool({
  name: "searchChannels",
  description: "Searches for channels/chats by keywords in their names.",
  parameters: z.object({
    keywords: z.string().describe("Keywords to search for in channel names"),
    limit: z.number().optional().describe("Maximum number of results to return (default: 100)"),
  }),
  execute: async (args) => {
    await ensureLogin();
    
    const keywords = args.keywords.toLowerCase();
    const searchLimit = args.limit || 100;
    
    // Search from cache instead of making a new request
    const chatEntries = Array.from(telegramClient.dialogCache.entries());
    const matchingChats = chatEntries
      .filter(([_, chat]) => chat.title && chat.title.toLowerCase().includes(keywords))
      .slice(0, searchLimit)
      .map(([id, chat]) => ({
        id: id,
        title: chat.title || 'Unknown',
        type: chat.type,
        access_hash: chat.access_hash || 'N/A'
      }));
    
    return `Found ${matchingChats.length} channels/chats matching "${args.keywords}" in the cache (total in cache: ${telegramClient.dialogCache.size}).\n${JSON.stringify(matchingChats, null, 2)}`;
  },
});

server.addTool({
  name: "getChannelMessages",
  description: "Retrieves messages from a specific channel/chat by its ID.",
  parameters: z.object({
    channelId: z.number().describe("The numeric ID of the channel/chat to fetch messages from"),
    limit: z.number().optional().describe("Maximum number of messages to return (default: 100)"),
    filterPattern: z.string().optional().describe("Optional regex pattern to filter messages by content"),
  }),
  execute: async (args) => {
    await ensureLogin();
    
    const channelId = args.channelId;
    const limit = args.limit || 100;
    const filterPattern = args.filterPattern;

    try {
      // Use the new getMessagesByChannelId method which uses the cache
      const messages = await telegramClient.getMessagesByChannelId(channelId, limit);
      
      // Get channel details from cache
      const cachedChat = telegramClient.dialogCache.get(`${channelId}`);
      if (!cachedChat) {
        throw new Error(`Channel with ID ${channelId} not found in cache.`);
      }
      
      // Extract relevant info and handle potential missing fields
      let formattedMessages = messages.map(msg => ({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown',
        text: msg.message || '',
        from_id: msg.from_id?.user_id
                  || msg.from_id?.channel_id
                  || msg.peer_id?.user_id
                  || msg.peer_id?.channel_id
                  || msg.peer_id?.chat_id
                  || 'unknown'
      }));

      let resultText = `Retrieved ${formattedMessages.length} messages from "${cachedChat.title}".`;

      if (filterPattern) {
        try {
          const regex = new RegExp(filterPattern);
          const originalCount = formattedMessages.length;
          formattedMessages = formattedMessages.filter(msg => msg.text && regex.test(msg.text));
          resultText = `Retrieved ${originalCount} messages from "${cachedChat.title}", filtered down to ${formattedMessages.length} matching pattern "${filterPattern}".`;
        } catch (e) {
          resultText += ` (Failed to apply filter: Invalid regex pattern: ${e.message})`;
        }
      }

      return `${resultText}\n${JSON.stringify(formattedMessages, null, 2)}`;
    } catch (error) {
      // If cache-based method fails, log error and throw
      console.error(`Error fetching messages using cache: ${error.message}`);
      throw error;
    }
  },
});

// Initialize dialog cache at server startup
console.log('Starting server and initializing Telegram dialog cache...');
initializeDialogCache().then(success => {
  if (success) {
    console.log('Dialog cache initialization complete, starting server...');
  } else {
    console.error('Failed to initialize dialog cache. Starting server anyway...');
  }
  server.start({
    transportType: "sse",
    sse: {endpoint: "/sse", port: 8080},
  });
});