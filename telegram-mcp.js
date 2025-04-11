import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import dotenv from 'dotenv';
import TelegramClient from './telegram-client.js';

// Load environment variables
dotenv.config();

// --- Debugging Utility ---
const DEBUG = process.env.DEBUG || true;
function debug(area, message, data = null) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [DEBUG] [${area}] ${message}`);
  if (data !== null) {
    // Avoid circular structure issues with simple console.log for objects
    try {
        console.log(JSON.stringify(data, null, 2));
    } catch (e) {
        console.log('[Could not stringify data]');
    }
  }
}

// --- Telegram Client Setup ---
const telegramClient = new TelegramClient(
  process.env.TELEGRAM_API_ID,
  process.env.TELEGRAM_API_HASH,
  process.env.TELEGRAM_PHONE_NUMBER,
  './data/session.json' // Default session path
);

let isTelegramLoggedIn = false;

// Helper function to ensure the client is logged in
async function ensureLogin() {
  if (!isTelegramLoggedIn) {
    if (telegramClient.hasSession()) {
        debug('AUTH', 'Session file found, attempting to use existing session.');
        // MTProto will internally try to use the session. We need to make a simple call
        // to verify it's still valid *before* declaring logged in.
        try {
            await telegramClient.mtproto.call('users.getUsers', { id: [{ _: 'inputUserSelf' }] });
            debug('AUTH', 'Existing session confirmed valid.');
            isTelegramLoggedIn = true;
            return;
        } catch (sessionError) {
            debug('AUTH', 'Existing session invalid or expired. Need to re-login.', sessionError.message);
            // Proceed to login below
        }
    }

    debug('AUTH', 'No active session or session invalid, attempting interactive login...');
    const loggedIn = await telegramClient.login(); // This is the part that requires user interaction if needed
    if (!loggedIn) {
      const error = 'Failed to log in to Telegram. Please check credentials or complete manual login steps in console.';
      debug('AUTH', 'Login failed', error);
      throw new Error(error);
    }
    debug('AUTH', 'Login successful');
    isTelegramLoggedIn = true;
  } else {
    debug('AUTH', 'Already confirmed logged in during this session.');
  }
}


// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 8080;


// --- MCP Server Initialization ---
const mcpServer = new Server(
  {
    name: "telegram-mcp-server", // Changed name
    version: "1.0.0"
  },
  {
    // **Ensure tools capability is declared**
    capabilities: {
      tools: {},
    }
  }
);

// --- MCP Tool Definitions ---

// 1. List Tools Handler
// **Replacing the example tool list with Telegram tools**
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  debug('MCP', 'Received ListTools request');
  return {
    tools: [
      {
        name: "listChannels",
        description: "Lists available Telegram channels/chats accessible by the account.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of channels to return (default: 50)",
              // optional: true
            }
          }
        }
      },
      {
        name: "searchChannels",
        description: "Searches for channels/chats by keywords in their names.",
        inputSchema: {
          type: "object",
          properties: {
            keywords: {
              type: "string",
              description: "Keywords to search for in channel names"
            },
            limit: {
              type: "number",
              description: "Maximum number of dialogs to fetch for searching (default: 100)",
              // optional: true
            }
          },
          // required: ["keywords"]
        }
      },
      {
        name: "getChannelMessages",
        description: "Retrieves messages from a specific channel/chat by its ID.",
        inputSchema: {
          type: "object",
          properties: {
            channelId: {
              type: "number",
              description: "The numeric ID of the channel/chat to fetch messages from"
            },
            limit: {
              type: "number",
              description: "Maximum number of messages to return (default: 100)",
              // optional: true
            },
            filterPattern: {
              type: "string",
              description: "Optional regex pattern to filter messages by content",
              // optional: true
            }
          },
          // required: ["channelId"]
        }
      }
    ]
  };
});

// 2. Call Tool Handler
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  debug('MCP', `--> Received tool call: ${request.params.name}`, request.params.arguments);
  try {
    // **Ensure login before executing any tool**
    await ensureLogin();
    console.log("--> Login successful");

    const toolName = request.params.name;
    const args = request.params.arguments || {};
    console.log("--> Tool name:", toolName);
    console.log("--> Arguments:", args);

    switch (toolName) {
      case "listChannels": {
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
        return {
          isError: false,
          content: [
            { type: "text", text: `Retrieved ${formattedChats.length} channels/chats.` },
            { type: "json", json: formattedChats }
          ]
        };
      }

      case "searchChannels": {
        const keywords = args.keywords;
        // Fetch a reasonable number of dialogs to search through
        const searchLimit = args.limit || 100;
        if (!keywords) {
           throw new Error("Missing required argument: keywords");
        }
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
        return {
           isError: false,
           content: [
             { type: "text", text: `Found ${matchingChats.length} channels/chats matching "${keywords}" within the first ${searchLimit} dialogs.` },
             { type: "json", json: matchingChats } // todo: only text is supported for now
           ]
         };
      }

      case "getChannelMessages": {
        const channelId = args.channelId;
        const limit = args.limit || 100;
        const filterPattern = args.filterPattern;
         if (!channelId) {
           throw new Error("Missing required argument: channelId");
        }

        // Need to find the chat *object* first to get access_hash etc. for the API call.
        // Fetch a larger number of dialogs if needed, or handle pagination if the chat isn't found.
        // For simplicity, fetch a decent number here.
        const { chats } = await telegramClient.getDialogs(500); // Adjust limit as needed
        const channel = chats.find(chat => chat.id === channelId);

        if (!channel) {
          // Return an error in the MCP format
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Channel/Chat with ID ${channelId} not found or not accessible within the first 500 dialogs.` }]
          };
        }

        // Check if we have access_hash needed for channels
        if ((channel._ === 'channel' || channel._ === 'channelForbidden') && !channel.access_hash) {
             return {
                isError: true,
                content: [{ type: "text", text: `Error: Missing access_hash for channel ID ${channelId}. Cannot fetch history.` }]
             };
        }


        const messages = await telegramClient.getChatMessages(channel, limit);

        // Extract relevant info and handle potential missing fields
        let formattedMessages = messages.map(msg => ({
          id: msg.id,
          date: msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown',
          text: msg.message || '',
          // Attempt to get sender ID robustly
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
             debug('TOOL_ERROR', `Invalid regex pattern provided: ${filterPattern}`, e.message);
             resultText += ` (Failed to apply filter: Invalid regex pattern: ${e.message})`;
             // Decide whether to return error or just proceed without filter. Proceeding here.
          }
        }

        return {
          isError: false,
          content: [
            { type: "text", text: resultText },
            { type: "json", json: formattedMessages }
          ]
        };
      }

      default:
        // Return error in MCP format for unknown tool
        console.log("--> Unknown tool requested:", toolName);
        return {
            isError: true,
            content: [{ type: "text", text: `Error: Unknown tool requested: ${toolName}` }]
        }
    }
  } catch (err) {
    debug('MCP_ERROR', `Error during tool call '${request.params.name}'`, err);
    // Return a generic error in MCP format
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error executing tool '${request.params.name}': ${err.message}`
        }
      ]
    };
  }
});

// --- Run MCP Server with SSE Transport ---
async function runMCPServer() {
  let transport; // Keep transport scoped

  // Set up SSE endpoint
  app.get("/sse", async (req, res) => {
    try {
        debug('SSE', '--> Received SSE connection request', req.url); // Use debug

        // **Crucially, set headers BEFORE creating transport or connecting**
        // res.setHeader('Content-Type', 'text/event-stream');
        // res.setHeader('Cache-Control', 'no-cache');
        // res.setHeader('Connection', 'keep-alive');
        // **Do not call res.flushHeaders() here - let the transport manage writes**

        // Create SSE transport - Pass the POST path relative to server root
        transport = new SSEServerTransport("/message", res); // Path for POST
        debug('SSE', 'New SSE transport created for /message');

        // Connect MCP server to the transport
        await mcpServer.connect(transport);
        debug('MCP', 'MCP Server connected to SSE transport');

        // Optional: Add logging to transport events for debugging
        const originalOnMessage = transport.onmessage;
        const originalOnClose = transport.onclose;
        const originalOnError = transport.onerror;
        
        transport.onmessage = (msg) => {
            debug('SSE_IN', 'Received message from client via transport', msg);
            if (originalOnMessage) originalOnMessage(msg);
        };
        transport.onclose = () => { // Define even if empty
            debug('SSE', 'Transport closed');
            if (originalOnClose) originalOnClose();
        };
        transport.onerror = (err) => { // Define even if empty
            debug('SSE_ERROR', 'Transport error', err);
            if (originalOnError) originalOnError(err);
        };

        // Handle client disconnect
        // req.on('close', async () => {
        //     debug('SSE', 'Client disconnected (request closed)');
        //     if (transport) {
        //         // Disconnect MCP server from transport if client closes connection
        //         await mcpServer.close(); // Let the server handle transport cleanup
        //         transport = null; // Clear reference
        //         debug('MCP', 'MCP Server connection closed due to client disconnect');
        //     }
        // });

        mcpServer.onclose = async () => {
            await mcpServer.close();
            console.log("SSE connection closed");
        };

        // **Do not write initial connection message here - let MCP handle communication**
        debug('SSE', 'SSE connection established and MCP server connected.');

    } catch (err) {
        debug('SSE_ERROR', 'Error setting up SSE endpoint', err);
        // Avoid ERR_HTTP_HEADERS_SENT: Check if headers are *not* sent before sending error
        // if (!res.headersSent) {
        //     res.status(500).send("Server error: failed to setup SSE endpoint");
        // } else {
        //      // If headers sent, we can only try to end the connection abruptly
        //      res.end();
        //      debug('SSE_ERROR', 'Headers already sent, could not send 500 status.');
        // }
        //  // Ensure transport is cleaned up if setup failed mid-way
        // if (transport) {
        //     await mcpServer.close();
        //     transport = null;
        // }
        res.status(500).send("Server error: failed to setup SSE endpoint");
    }
  });

  // Set up message endpoint for POST requests from the client
  app.post("/message", async (req, res) => {
    debug('SSE_POST', '--> Received POST request on /message'); // Log reception
    if (transport?.handlePostMessage) {
      // Let the transport handle the request and response
      await transport.handlePostMessage(req, res);
      debug('SSE_POST', `<-- Response sent for /message with status: ${res.statusCode}`);
    } else {
      debug('SSE_POST_ERROR', 'Transport not initialized or handlePostMessage not available for POST /message');
      res.status(500).send("Server error: transport not initialized or endpoint mismatch");
    }
    console.log("<--", res.statusCode, res.statusMessage);
  });

  //  // Simple health check (optional but good practice)
  //  app.get("/health", (req, res) => {
  //      res.status(200).json({ status: "ok", serverName: mcpServer.name });
  //  });

  // Start the server
  app.listen(PORT, () => {
    debug('SYSTEM', `Telegram MCP Server is running on port ${PORT}`);
    debug('SYSTEM', `SSE Connect Endpoint: http://localhost:${PORT}/sse`);
    debug('SYSTEM', `SSE POST Message Endpoint: http://localhost:${PORT}/message`);
    // Prompt for login check if needed
    if (!telegramClient.hasSession()) {
        console.log("--------------------------------------------------------------------");
        console.log("INFO: No Telegram session found. Server will attempt login.");
        console.log("INFO: You may be prompted for phone code or 2FA password in console.");
        console.log("--------------------------------------------------------------------");
    }
  });
}

// Start the server and handle potential startup errors
runMCPServer().catch(err => {
  console.error('[FATAL] Error starting server:', err);
  process.exit(1); // Exit if server fails to start
});
