import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import TelegramClient from './telegram-client.js';

// Load environment variables
dotenv.config();

// Enable debug mode
const DEBUG = process.env.DEBUG || true;

// Debug function
export function debug(area, message, data = null) {
  if (!DEBUG) return;
  
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [DEBUG] [${area}] ${message}`);
  if (data) {
    if (typeof data === 'object') {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(data);
    }
    console.log('-----------------------------------');
  }
}

// Create Telegram client instance
const telegramClient = new TelegramClient(
  process.env.TELEGRAM_API_ID,
  process.env.TELEGRAM_API_HASH,
  process.env.TELEGRAM_PHONE_NUMBER,
  './data/session.json'
);

// Helper function to ensure the client is logged in
async function ensureLogin() {
  if (!telegramClient.hasSession()) {
    debug('AUTH', 'No session found, attempting to login');
    const loggedIn = await telegramClient.login();
    if (!loggedIn) {
      const error = 'Failed to log in to Telegram. Please check your credentials.';
      debug('AUTH', 'Login failed', error);
      throw new Error(error);
    }
    debug('AUTH', 'Login successful');
  }
}

// Initialize MCP server
const server = new McpServer({
  name: 'Telegram MCP Server',
  version: '1.0.0',
  description: 'MCP server that provides access to Telegram channels and messages'
});

// Tool: Search for channels by keywords
server.tool(
  'searchChannels',
  { 
    keywords: z.string().describe('Keywords to search for in channel names'),
    limit: z.number().optional().default(100).describe('Maximum number of channels to return')
  },
  async ({ keywords, limit }) => {
    debug('TOOL', `Executing searchChannels with keywords: ${keywords}, limit: ${limit}`);
    
    // Ensure the client is logged in
    await ensureLogin();
    
    // Get all dialogs
    const { chats } = await telegramClient.getDialogs(limit);
    
    // Filter chats by keywords (case-insensitive)
    const keywordsLower = keywords.toLowerCase();
    const matchingChats = chats
      .filter(chat => chat.title && chat.title.toLowerCase().includes(keywordsLower))
      .map(chat => ({
        id: chat.id,
        title: chat.title,
        type: chat._,
        members_count: chat.participants_count || 'unknown'
      }));
    
    const result = {
      content: [
        { 
          type: 'text', 
          text: `Found ${matchingChats.length} channels matching "${keywords}".` 
        },
        {
          type: 'json',
          json: matchingChats
        }
      ]
    };
    
    debug('TOOL', 'searchChannels result', result);
    return result;
  }
);

// Tool: Get messages from a specific channel
server.tool(
  'getChannelMessages',
  { 
    channelId: z.number().describe('Channel ID to fetch messages from'),
    limit: z.number().optional().default(100).describe('Maximum number of messages to return'),
    filterPattern: z.string().optional().describe('Regex pattern to filter messages (optional)')
  },
  async ({ channelId, limit, filterPattern }) => {
    debug('TOOL', `Executing getChannelMessages with channelId: ${channelId}, limit: ${limit}, filterPattern: ${filterPattern || 'none'}`);
    
    // Ensure the client is logged in
    await ensureLogin();
    
    // Get all dialogs to find the channel
    const { chats } = await telegramClient.getDialogs();
    
    // Find the channel by ID
    const channel = chats.find(chat => chat.id === channelId);
    
    if (!channel) {
      const error = `Error: Channel with ID ${channelId} not found.`;
      debug('TOOL', 'getChannelMessages error', error);
      return {
        content: [{ 
          type: 'text', 
          text: error
        }]
      };
    }
    
    // Get messages from the channel
    const messages = await telegramClient.getChatMessages(channel, limit);
    
    // Filter messages if a pattern is provided
    let filteredMessages = messages.map(msg => ({
      id: msg.id,
      date: new Date(msg.date * 1000).toISOString(),
      text: msg.message || '',
      from_id: msg.from_id
    }));

    if (filterPattern) {
      const rawFilteredTexts = telegramClient.filterMessagesByPattern(messages, filterPattern);
      filteredMessages = filteredMessages.filter(msg => 
        rawFilteredTexts.includes(msg.text)
      );
    }
    
    const result = {
      content: [
        { 
          type: 'text', 
          text: `Retrieved ${filteredMessages.length} messages from "${channel.title}".` 
        },
        {
          type: 'json',
          json: filteredMessages
        }
      ]
    };
    
    debug('TOOL', 'getChannelMessages result', result);
    return result;
  }
);

// Tool: List all available channels
server.tool(
  'listChannels',
  { 
    limit: z.number().optional().default(50).describe('Maximum number of channels to return')
  },
  async ({ limit }) => {
    debug('TOOL', `Executing listChannels with limit: ${limit}`);
    
    // Ensure the client is logged in
    await ensureLogin();
    
    // Get all dialogs
    const { chats } = await telegramClient.getDialogs(limit);
    
    // Format chat information
    const formattedChats = chats
      .filter(chat => chat.title) // Only include chats with titles
      .map(chat => ({
        id: chat.id,
        title: chat.title,
        type: chat._,
        members_count: chat.participants_count || 'unknown'
      }));
    
    const result = {
      content: [
        { 
          type: 'text', 
          text: `Retrieved ${formattedChats.length} channels.` 
        },
        {
          type: 'json',
          json: formattedChats
        }
      ]
    };
    
    debug('TOOL', 'listChannels result', result);
    return result;
  }
);

// Export the server for use in HTTP server
export default server; 