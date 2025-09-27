# Telegram MCP Server

An MCP server allowing AI assistants (like Claude) to interact with your Telegram account using the user client API (not the bot API). Built with `@mtproto/core` and the **FastMCP** framework.

## Features

### Tools

- `listChannels`

  - Lists available Telegram channels/chats accessible by the account, based on the server's cache.
  - Parameters:
    - `limit` (number, optional): Maximum number of channels to return (default: 50).
  - Output: A list of channels/chats with their ID, title, type, and access hash (if applicable).

- `searchChannels`

  - Searches the cached channels/chats by keywords in their names.
  - Parameters:
    - `keywords` (string): Keywords to search for in channel names.
    - `limit` (number, optional): Maximum number of results to return (default: 100).
  - Output: A list of matching channels/chats.

- `getChannelMessages`
  - Retrieves recent messages from a specific channel/chat using its ID.
  - Parameters:
    - `channelId` (number): The numeric ID of the channel/chat (obtained from `listChannels` or `searchChannels`).
    - `limit` (number, optional): Maximum number of messages to return (default: 100).
    - `filterPattern` (string, optional): A JavaScript-compatible regular expression to filter messages by their text content.
  - Output: A list of messages containing ID, date, text, and sender ID.

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
         "url": "http://localhost:8080/sse",
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

1.  **Initial Login (Important First Step):**
    The first time you run the server (or if your session expires/is invalid), it needs to authenticate with Telegram. Run it directly from your terminal:

    ```bash
    npm start
    ```

    - The server will use the credentials from your `.env` file.
    - It will prompt you in the terminal to enter the login code sent to your Telegram account and your 2FA password if required.
    - Upon successful login, a session file (`./data/session.json`) will be created. This file allows the server to log in automatically in the future without requiring codes/passwords.
    - The server will enumerate your chats after login. This can take some time on the first run, especially with many chats.

2.  **Normal Operation:**
    You'll need to start the server manually by running `npm start` in the project directory.

    Once the server is running, your MCP client (e.g., Claude Desktop) will connect to it via the URL specified in its configuration (`http://localhost:8080/sse` by default).

## Troubleshooting

- **Login Prompts:** If the server keeps prompting for login codes/passwords when started by the MCP client, ensure the `data/session.json` file exists and is valid. You might need to run `npm start` manually once to refresh the session. Also, check that the file permissions allow the user running the MCP client to read/write the `data` directory.
- **Cache Issues:** If channels seem outdated or missing, restart the server; it will refresh the chat list on boot.
- **Cannot Find Module:** Ensure you run `npm install` in the project directory. If the MCP client starts the server, make sure the working directory is set correctly or use absolute paths.
- **Other Issues:** If you encounter any other problems, feel free to open an issue in [this server repo](https://github.com/kfastov/telegram-mcp-server).

## Telegram Client Library

This repository also contains the underlying `telegram-client.js` library used by the MCP server. For details on using the library directly (e.g., for custom scripting), see [LIBRARY.md](LIBRARY.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
