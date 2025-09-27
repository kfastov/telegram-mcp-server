import { FastMCP } from "fastmcp";
import { z } from "zod"; // Or any validation library that supports Standard Schema
import TelegramClient from './telegram-client.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Telegram client
const telegramClient = new TelegramClient(
  process.env.TELEGRAM_API_ID,
  process.env.TELEGRAM_API_HASH,
  process.env.TELEGRAM_PHONE_NUMBER,
  './data/session.json'
);

const server = new FastMCP({
  name: "My Server",
  version: "1.0.0",
});

// Telegram tools
server.addTool({
  name: "listChannels",
  description: "Lists available Telegram channels/chats accessible by the account.",
  parameters: z.object({
    limit: z.number().optional().describe("Maximum number of channels to return (default: 50)"),
  }),
  execute: async (args) => {
    await telegramClient.ensureLogin();
    
    const limit = args.limit || 50;
    // Get from cache instead of making a new request
    const chatEntries = Array.from(telegramClient.dialogCache.entries()).slice(0, limit);
    const formattedChats = chatEntries.map(([id, chat]) => {
      const numericId = Number(id);
      return {
        id: Number.isNaN(numericId) ? id : numericId,
        title: chat.title || 'Unknown',
        type: chat.type,
        access_hash: chat.access_hash || 'N/A'
      };
    });
    
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
    await telegramClient.ensureLogin();
    
    const keywords = args.keywords.toLowerCase();
    const searchLimit = args.limit || 100;
    
    // Search from cache instead of making a new request
    const chatEntries = Array.from(telegramClient.dialogCache.entries());
    const matchingChats = chatEntries
      .filter(([_, chat]) => chat.title && chat.title.toLowerCase().includes(keywords))
      .slice(0, searchLimit)
      .map(([id, chat]) => {
        const numericId = Number(id);
        return {
          id: Number.isNaN(numericId) ? id : numericId,
          title: chat.title || 'Unknown',
          type: chat.type,
          access_hash: chat.access_hash || 'N/A'
        };
      });
    
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
    await telegramClient.ensureLogin();
    
    const channelId = args.channelId;
    const limit = args.limit || 100;
    const filterPattern = args.filterPattern;

    try {
      // Use the new getMessagesByChannelId method which uses the cache
      const messages = await telegramClient.getMessagesByChannelId(channelId, limit);
      
      // Get channel details from cache
      const cachedChat = telegramClient.dialogCache.get(String(channelId));
      if (!cachedChat) {
        throw new Error(`Channel with ID ${channelId} not found in cache.`);
      }
      
      // Extract relevant info and handle potential missing fields
      let formattedMessages = messages.map(msg => ({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown',
        text: msg.text || msg.message || '',
        from_id: typeof msg.from_id === 'string' ? msg.from_id :
                  msg.from_id?.user_id
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
telegramClient.initializeDialogCache().then(success => {
  if (success) {
    console.log('Dialog cache initialization complete, starting server...');
    server.start({
      transportType: "sse",
      sse: {endpoint: "/sse", port: 8080},
    });
  } else {
    console.error('Failed to initialize dialog cache. Exiting...');
    process.exit(1); // Exit with a non-zero code indicating failure
  }
});
