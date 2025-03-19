# Telegram Client Library and MCP Server

This project provides both a Telegram client library and an MCP (Model Context Protocol) server for AI assistants to interact with Telegram.

## Features

### Telegram Client Library

- Authentication with Telegram (including 2FA support)
- Session management (automatic reuse of existing sessions)
- Retrieving chats/dialogs
- Fetching messages from specific chats
- Filtering messages by pattern (e.g., regex)

### MCP Server

- **Search channels by keywords** - Find Telegram channels by searching for keywords in their names
- **List available channels** - View all accessible channels
- **Get messages from channels** - Retrieve messages from any accessible channel
- **Filter messages by pattern** - Apply regex patterns to filter messages

## Setup

1. Create a `.env` file with your Telegram API credentials:

```
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_PHONE_NUMBER=your_phone_number
PORT=3000  # Optional, defaults to 3000 for MCP server
```

2. Install dependencies:

```bash
npm install
```

## Usage

### Using the Telegram Client Library

```javascript
const TelegramClient = require("./telegram-client");
const dotenv = require("dotenv");

dotenv.config();

async function main() {
  // Create a new client instance
  const client = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER
  );

  // Login to Telegram
  await client.login();

  // Get all chats/dialogs
  const { chats } = await client.getDialogs();

  // Print all chats
  chats.forEach((chat) => {
    if (chat.title) {
      console.log(`Chat: ${chat.title}`);
    }
  });
}

main().catch(console.error);
```

Run the example client:

```bash
npm run client
```

### Using the MCP Server

1. Start the MCP server:

```bash
npm start
```

2. The MCP server will be available at:

```
http://localhost:3000/mcp
```

3. You can test the MCP server using the included client:

```bash
npm run mcp-client
```

For more details about the MCP server, see [MCP-README.md](MCP-README.md).  
For information about the code architecture, see [CODE_STRUCTURE.md](CODE_STRUCTURE.md).

## API Reference

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

- `login()`: Authenticates with Telegram (handles both new logins and session reuse)
- `getDialogs(limit, offset)`: Gets a list of dialogs (chats)
- `getChatMessages(chat, limit)`: Gets messages from a specific chat
- `filterMessagesByPattern(messages, pattern)`: Filters an array of messages by a regex pattern
- `hasSession()`: Checks if a valid session exists

## Files in this Repository

- `telegram-client.js`: The main client library
- `client.js`: An example client with additional helper functions
- `index.js`: Original example using the client library
- `mcp-server.js`: The MCP server main entry point
- `telegram-mcp.js`: The MCP server implementation with Telegram tools
- `http-server.js`: The HTTP/SSE server transport layer
- `mcp-client-example.js`: A simple client to test the MCP server

## Using with Claude or other MCP-compatible Assistants

The MCP server can be used with Claude or other MCP-compatible assistants. When connected, the assistant will have access to your Telegram channels and messages through the tools provided by the server.

Example workflow:

1. Start the MCP server
2. Connect Claude to the MCP server using the MCP URL
3. Ask Claude to search for channels, retrieve messages, or filter messages by pattern

## License

MIT
