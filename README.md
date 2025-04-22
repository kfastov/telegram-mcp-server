# Telegram Client Library and MCP Server

This project provides both a Telegram client library (`telegram-client.js`) and an MCP (Model Context Protocol) server (`mcp-server.js`) enabling AI assistants (such as Claude, Cline, or Cursor) to interact with Telegram via the user client API (not bot API). This enables capabilities such as reading message history from channels and chats, with potential for sending messages on behalf of users in future updates. The server component is built using the **FastMCP** library.

For detailed information about the Telegram client library, see [LIBRARY.md](LIBRARY.md).

## Features

### MCP Server (`mcp-server.js`)

- Provides MCP tools for AI agents:
  - **listChannels**: Lists cached channels/chats.
  - **searchChannels**: Searches cached channels/chats by keywords.
  - **getChannelMessages**: Retrieves messages from a specific channel/chat using its ID, with optional regex filtering.
- Communicates using the Model Context Protocol over Server-Sent Events (SSE).
- Initializes and maintains a cache of Telegram dialogs (`./data/dialog_cache.json`) for faster responses and reduced API calls.

## Setup

### Obtaining Telegram API Credentials

1. **Obtain API credentials**

   - Create a new app at [https://core.telegram.org/api/obtaining_api_id](https://core.telegram.org/api/obtaining_api_id)
   - Fill out the form to receive your `api_id` and `api_hash`

2. **Prepare your Telegram account**
   Because this MCP server is technically a custom Telegram app, your account needs to have Two-Step Verification set up:
   - Go to Settings → Privacy and Security
   - Enable Two-Step Verification and set your password

### Configuration and Installation

1. Configure the following environment variables with your Telegram API credentials:

   ```
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   TELEGRAM_PHONE_NUMBER=your_phone_number
   # PORT=8080 # Optional: The MCP server defaults to 8080 if not set here or overridden in code
   ```

   These variables can be set in your environment or placed in a `.env` file in the project root.

2. Install dependencies:

   ```bash
   npm install
   ```

## Usage

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

## Files in this Repository

- `client.js`: An example script demonstrating usage of the `telegram-client.js` library.
- `telegram-client.js`: The core Telegram client library handling authentication and API interaction.
- `mcp-server.js`: The MCP server implementation (using FastMCP) providing Telegram tools over SSE.
- `LIBRARY.md`: Detailed documentation for the Telegram client library.

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
