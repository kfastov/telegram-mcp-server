# Telegram MCP Server

An MCP server allowing AI assistants (like Claude or Cursor) to interact with your Telegram account using the user client API (not the bot API). The stack rides on the official `@modelcontextprotocol/sdk` Streamable HTTP transport and exposes Telegram-oriented tools for listing dialogs, fetching messages, and managing background sync jobs.

## Tools

| Tool | Description |
| --- | --- |
| `listChannels` | Lists available dialogs/channels (limit configurable). |
| `searchChannels` | Searches dialogs by title or username. |
| `getChannelMessages` | Fetches recent messages (ID or username, optional regex filter). |
| `scheduleMessageSync` | Schedules a background job to archive a dialog into SQLite. |
| `listMessageSyncJobs` | Displays tracked sync jobs, cursors, and statuses. |

## Prerequisites

1.  **Node.js:** Version 18 or later recommended.
2.  **Telegram Account:**
    - You need an active Telegram account.
    - **Two-Step Verification (2FA)** must be enabled on your account (Settings → Privacy and Security → Two-Step Verification).
3.  **Telegram API Credentials:**
    - Obtain an `api_id` and `api_hash` by creating a new application at [https://core.telegram.org/api/obtaining_api_id](https://core.telegram.org/api/obtaining_api_id).

## Installation

1.  Clone this repository:
    ```bash
    git clone https://github.com/your-username/telegram-mcp-server.git # Replace with your repo URL
    cd telegram-mcp-server
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```

## Configuration

There are two separate configurations that need to be set up:

1. **MCP Server Configuration:**

   Configure the Telegram MCP server using environment variables (in a `.env` file or directly in your environment):

   ```dotenv
   TELEGRAM_API_ID=YOUR_API_ID
   TELEGRAM_API_HASH=YOUR_API_HASH
   TELEGRAM_PHONE_NUMBER=YOUR_PHONE_NUMBER_WITH_COUNTRY_CODE # e.g., +15551234567
   ```

   Replace the placeholder values with your actual credentials.

2. **MCP Client Configuration:**

   Configure client software (Claude Desktop, Cursor, etc.) to connect to the MCP server by modifying their configuration files:

   ```json
   {
     "mcpServers": {
       "telegram": {
       "url": "http://localhost:8080/mcp",
         "disabled": false,
         "timeout": 30
       }
     }
   }
   ```

   For Claude Desktop, the config file is located at:

   - On macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

   **Important:** Restart your MCP client to apply the changes.

## Running the Server

1.  Run the server:

    ```bash
    npm start
    ```

    On the first run the server will authenticate via MTProto. Enter the login code from Telegram and (if enabled) your 2FA password. After a successful login a persistent session file is saved under `./data/session.json`, so restarts won't prompt again unless the session is revoked.

2.  Point your MCP client at the same URL. Cursor/Claude will send the standard `initialize → notifications/initialized → tools/list` sequence, which the SDK transport handles automatically. Once connected you should see the Telegram toolset in the client UI.

## Background Message Sync

- Jobs and archived messages are stored in `data/messages.db` (SQLite).
- The server processes sync jobs sequentially and waits between requests to avoid hitting Telegram rate limits.
- Use the MCP tools to manage jobs:

  ```
  scheduleMessageSync { "channelId": -1001234567890 }
  listMessageSyncJobs {}
  ```

  You can supply either the numeric chat ID or the public username as `channelId`. Jobs resume automatically when the server restarts. Job statuses transition through `pending → in_progress → idle`, moving to `error` if retries are required.

## Troubleshooting

- **Login Prompts:** If the server keeps prompting for login codes/passwords when started by the MCP client, ensure the `data/session.json` file exists and is valid. You might need to run `npm start` manually once to refresh the session. Also, check that the file permissions allow the user running the MCP client to read/write the `data` directory.
- **Cache Issues:** If channels seem outdated or missing, restart the server; it will refresh the chat list on boot.
- **Cannot Find Module:** Ensure you run `npm install` in the project directory. If the MCP client starts the server, make sure the working directory is set correctly or use absolute paths.
- **Other Issues:** If you encounter any other problems, feel free to open an issue in [this server repo](https://github.com/kfastov/telegram-mcp-server).

## Telegram Client Library

This repository also contains the underlying `telegram-client.js` library used by the MCP server. For details on using the library directly (e.g., for custom scripting), see [LIBRARY.md](LIBRARY.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
