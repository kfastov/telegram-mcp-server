import { FastMCP } from "fastmcp";
import { z } from "zod";
import TelegramClient from './telegram-client.js';
import dotenv from 'dotenv';

dotenv.config();

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

server.addTool({
  name: "listChannels",
  description: "Lists available Telegram channels/chats accessible by the account.",
  parameters: z.object({
    limit: z.number().optional().describe("Maximum number of channels to return (default: 50)"),
  }),
  execute: async (args) => {
    await telegramClient.ensureLogin();

    const limit = args.limit || 50;
    const dialogs = await telegramClient.listDialogs(limit);

    return `Retrieved ${dialogs.length} channels/chats.\n${JSON.stringify(dialogs, null, 2)}`;
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

    const keywords = args.keywords;
    const searchLimit = args.limit || 100;
    const matchingChats = await telegramClient.searchDialogs(keywords, searchLimit);

    return `Found ${matchingChats.length} channels/chats matching "${args.keywords}".\n${JSON.stringify(matchingChats, null, 2)}`;
  },
});

server.addTool({
  name: "getChannelMessages",
  description: "Retrieves messages from a specific channel/chat by its ID.",
  parameters: z.object({
    channelId: z.union([
      z.number(),
      z.string().describe("The numeric ID or username of the channel/chat to fetch messages from"),
    ]),
    limit: z.number().optional().describe("Maximum number of messages to return (default: 100)"),
    filterPattern: z.string().optional().describe("Optional regex pattern to filter messages by content"),
  }),
  execute: async (args) => {
    await telegramClient.ensureLogin();

    const channelId = args.channelId;
    const limit = args.limit || 100;
    const filterPattern = args.filterPattern;

    try {
      const { peerTitle, messages } = await telegramClient.getMessagesByChannelId(channelId, limit);

      let formattedMessages = messages.map(msg => ({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown',
        text: msg.text || msg.message || '',
        from_id: msg.from_id || 'unknown',
      }));

      let resultText = `Retrieved ${formattedMessages.length} messages from "${peerTitle}".`;

      if (filterPattern) {
        try {
          const regex = new RegExp(filterPattern);
          const originalCount = formattedMessages.length;
          formattedMessages = formattedMessages.filter(msg => msg.text && regex.test(msg.text));
          resultText = `Retrieved ${originalCount} messages from "${peerTitle}", filtered down to ${formattedMessages.length} matching pattern "${filterPattern}".`;
        } catch (e) {
          resultText += ` (Failed to apply filter: Invalid regex pattern: ${e.message})`;
        }
      }

      return `${resultText}\n${JSON.stringify(formattedMessages, null, 2)}`;
    } catch (error) {
      console.error(`Error fetching messages: ${error.message}`);
      throw error;
    }
  },
});

console.log('Starting server and initializing Telegram dialogs...');
telegramClient.initializeDialogCache().then(success => {
  if (success) {
    console.log('Dialog initialization complete, starting server...');
    server.start({
      transportType: "sse",
      sse: { endpoint: "/sse", port: 8080 },
    });
  } else {
    console.error('Failed to initialize dialog list. Exiting...');
    process.exit(1);
  }
});
