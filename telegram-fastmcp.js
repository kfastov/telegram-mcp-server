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

// Ensure client is logged in before executing tools
async function ensureLogin() {
  if (!telegramClient.hasSession()) {
    return await telegramClient.login();
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
    const { chats } = await telegramClient.getDialogs(limit);
    const formattedChats = chats
      .filter(chat => chat.title) // Only include chats with titles
      .map(chat => ({
        id: chat.id,
        title: chat.title,
        type: chat._, // e.g., 'channel', 'chat'
        members_count: chat.participants_count || chat.members_count || 'unknown'
      }));
    return `Retrieved ${formattedChats.length} channels/chats.\n${JSON.stringify(formattedChats, null, 2)}`;
  },
});

server.addTool({
  name: "searchChannels",
  description: "Searches for channels/chats by keywords in their names.",
  parameters: z.object({
    keywords: z.string().describe("Keywords to search for in channel names"),
    limit: z.number().optional().describe("Maximum number of dialogs to fetch for searching (default: 100)"),
  }),
  execute: async (args) => {
    await ensureLogin();
    
    const keywords = args.keywords;
    const searchLimit = args.limit || 100;
    
    // Note: Telegram API doesn't have server-side search by title.
    // We fetch dialogs and filter locally.
    const { chats } = await telegramClient.getDialogs(searchLimit);
    const keywordsLower = keywords.toLowerCase();
    const matchingChats = chats
      .filter(chat => chat.title && chat.title.toLowerCase().includes(keywordsLower))
      .map(chat => ({
        id: chat.id,
        title: chat.title,
        type: chat._,
        members_count: chat.participants_count || chat.members_count || 'unknown'
      }));
    return `Found ${matchingChats.length} channels/chats matching "${keywords}" within the first ${searchLimit} dialogs.\n${JSON.stringify(matchingChats, null, 2)}`;
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

    // Need to find the chat *object* first to get access_hash etc. for the API call.
    const { chats } = await telegramClient.getDialogs(500);
    const channel = chats.find(chat => chat.id === channelId);

    if (!channel) {
      throw new Error(`Channel/Chat with ID ${channelId} not found or not accessible within the first 500 dialogs.`);
    }

    // Check if we have access_hash needed for channels
    if ((channel._ === 'channel' || channel._ === 'channelForbidden') && !channel.access_hash) {
      throw new Error(`Missing access_hash for channel ID ${channelId}. Cannot fetch history.`);
    }

    const messages = await telegramClient.getChatMessages(channel, limit);

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

    let resultText = `Retrieved ${formattedMessages.length} messages from "${channel.title}".`;

    if (filterPattern) {
      try {
        const regex = new RegExp(filterPattern);
        const originalCount = formattedMessages.length;
        formattedMessages = formattedMessages.filter(msg => msg.text && regex.test(msg.text));
        resultText = `Retrieved ${originalCount} messages from "${channel.title}", filtered down to ${formattedMessages.length} matching pattern "${filterPattern}".`;
      } catch (e) {
        resultText += ` (Failed to apply filter: Invalid regex pattern: ${e.message})`;
      }
    }

    return `${resultText}\n${JSON.stringify(formattedMessages, null, 2)}`;
  },
});

server.start({
  transportType: "sse",
  sse: {endpoint: "/sse", port: 8080},
});