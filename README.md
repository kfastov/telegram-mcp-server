# Telegram Client Library and MCP Server

This project provides both a Telegram client library (`telegram-client.js`) and an MCP (Model Context Protocol) server (`mcp-server.js`) enabling AI assistants (such as Claude, Cline, or Cursor) to interact with Telegram via the user client API (not bot API). This enables capabilities such as reading message history from channels and chats, with potential for sending messages on behalf of users in future updates. The server component is built using the **FastMCP** library.

## Features

### Telegram Client Library (`telegram-client.js`)

- Authentication with Telegram (including 2FA support)
- Session management (automatic reuse of existing sessions)
- Retrieving chats/dialogs (with caching)
- Fetching messages from specific chats (using cached IDs)
- Filtering messages by pattern (e.g., regex)

### MCP Server (`mcp-server.js`)

- Provides MCP tools for AI agents:
  - **listChannels**: Lists cached channels/chats.
  - **searchChannels**: Searches cached channels/chats by keywords.
  - **getChannelMessages**: Retrieves messages from a specific channel/chat using its ID, with optional regex filtering.
- Communicates using the Model Context Protocol over Server-Sent Events (SSE).
- Initializes and maintains a cache of Telegram dialogs (`./data/dialog_cache.json`) for faster responses and reduced API calls.

## Setup

1.  Create a `.env` file with your Telegram API credentials:

    ```dotenv
    TELEGRAM_API_ID=your_api_id
    TELEGRAM_API_HASH=your_api_hash
    TELEGRAM_PHONE_NUMBER=your_phone_number
    # PORT=8080 # Optional: The MCP server defaults to 8080 if not set here or overridden in code
    ```

2.  Install dependencies:

    ```bash
    npm install
    ```

## Usage

### Using the Telegram Client Library (`telegram-client.js`)

This library allows direct programmatic interaction with Telegram.

```javascript
// Example using the client library (see client.js for a more complete example)
import TelegramClient from "./telegram-client.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  // Create a new client instance
  const client = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER
    // Optional: specify session path, default is './data/session.json'
  );

  // Login to Telegram (will prompt for code/password if needed)
  await client.login();

  // Load dialog cache (optional, but recommended for performance)
  // Or use getAllDialogs() to fetch and populate the cache
  await client.loadDialogCache(); // Default path: './data/dialog_cache.json'
  if (client.dialogCache.size === 0) {
    console.log("Cache empty, fetching all dialogs to build cache...");
    await client.getAllDialogs(); // Fetches all dialogs and populates cache
    await client.saveDialogCache(); // Save cache for next time
  }

  // Get dialogs from the cache
  const dialogs = Array.from(client.dialogCache.values());

  // Print all cached chats
  dialogs.forEach((chat) => {
    if (chat.title) {
      console.log(`Chat: ${chat.title} (ID: ${chat.id})`);
    }
  });

  // Example: Get messages (replace 'your_channel_id' with an actual ID from the cache)
  // const messages = await client.getMessagesByChannelId('your_channel_id', 50);
  // console.log(messages);
}

main().catch(console.error);
```

Run the standalone client example:

```bash
node client.js
```

### Using the MCP Server (`mcp-server.js`)

This server exposes Telegram interactions as tools for MCP-compatible AI assistants (like Claude).

1.  Start the MCP server:
    _(First, ensure you have logged in at least once via the client or by running the server previously, creating `./data/session.json`)_

    ```bash
    npm start
    ```

2.  The server will initialize the Telegram client and attempt to load/build the dialog cache (`./data/dialog_cache.json`). This might take time on the first run.
3.  The MCP server endpoint will be available via Server-Sent Events (SSE) at:

    ```
    http://localhost:8080/sse
    ```

4.  You can connect an MCP-compatible client (like an AI assistant) to this endpoint.

## API Reference (`telegram-client.js`)

### TelegramClient

#### Constructor

```javascript
const client = new TelegramClient(apiId, apiHash, phoneNumber, sessionPath);
```

- `apiId`: Your Telegram API ID
- `apiHash`: Your Telegram API Hash
- `phoneNumber`: Your phone number in international format
- `sessionPath`: (Optional) Path to save the session file (default: './data/session.json')

#### Methods

- `login()`: Authenticates with Telegram (handles new logins, 2FA, and session reuse).
- `hasSession()`: Checks if a valid session file exists.
- `getDialogs(limit, offset)`: Gets a batch of dialogs (chats) directly from Telegram API.
- `getAllDialogs(batchSize)`: Fetches all dialogs progressively, populating the internal cache (`dialogCache`).
- `_updateDialogCache(chats)`: Internal method to update the cache.
- `getPeerInputById(id)`: Gets the necessary `InputPeer` object from the cache for API calls.
- `getChatMessages(chatObject, limit)`: Gets messages from a specific chat _object_ (less commonly used now).
- `getMessagesByChannelId(channelId, limit)`: Gets messages from a specific chat/channel using its ID (uses cached peer info).
- `filterMessagesByPattern(messages, pattern)`: Filters an array of message _strings_ by a regex pattern.
- `saveDialogCache(cachePath)`: Saves the internal `dialogCache` Map to a JSON file (default: `./data/dialog_cache.json`).
- `loadDialogCache(cachePath)`: Loads the `dialogCache` Map from a JSON file.

## Files in this Repository

- `client.js`: An example script demonstrating usage of the `telegram-client.js` library.
- `telegram-client.js`: The core Telegram client library handling authentication and API interaction.
- `mcp-server.js`: The MCP server implementation (using FastMCP) providing Telegram tools over SSE.

## Using with Claude or other MCP-compatible Assistants

The MCP server (`mcp-server.js`) can be used with Claude or other assistants supporting the Model Context Protocol over Server-Sent Events.

Example workflow:

1.  Start the MCP server (`npm start`).
2.  Connect Claude (or another assistant) to the MCP server using the SSE endpoint: `http://localhost:8080/sse`.
3.  The assistant can now use the available tools:
    - `listChannels`
    - `searchChannels`
    - `getChannelMessages` (optionally with `filterPattern`)

### Example Interactions with Claude

When connected to the MCP server, you can ask Claude natural language questions like:

- "Show me all available Telegram channels"
- "Search for channels about crypto"
- "Get the last 10 messages from channel 1234567890"
- "Find messages containing UUIDs in the CryptoFrog channel"

### Advanced Usage

#### Filtering Messages with Regular Expressions

You can use the `filterPattern` parameter with `getChannelMessages` to find specific types of messages. Some examples:

- `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` - Find UUIDs
- `https?://\\S+` - Find URLs
- `#[a-zA-Z0-9]+` - Find hashtags

## Troubleshooting

- **Authentication Issues**: If you encounter authentication problems, delete the session file in the `data/` directory and restart the server to re-authenticate.
- **Server Crashes**: Check your environment variables and ensure your Telegram API credentials are correct.
- **Access Denied to Channels**: Ensure your Telegram account has access to the channels you're trying to query.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
