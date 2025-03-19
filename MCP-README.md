# Telegram MCP Server

This server provides LLM (Large Language Model) access to Telegram channels and messages using the Model Context Protocol (MCP).

## Features

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
PORT=3000  # Optional, defaults to 3000
```

2. Install dependencies:

```bash
npm install
```

3. Start the MCP server:

```bash
npm start
```

The first time you run the server, you'll need to authenticate with Telegram. The server will prompt you to enter the authentication code sent to your Telegram account.

## Using the MCP Server

### MCP Endpoint

The MCP server runs at:

```
http://localhost:3000/mcp
```

### Available Tools

#### 1. listChannels

Lists all available Telegram channels that your account has access to.

Parameters:

- `limit` (optional, default: 50) - Maximum number of channels to return

Example response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Retrieved 15 channels."
    },
    {
      "type": "json",
      "json": [
        {
          "id": 1234567890,
          "title": "My Channel",
          "type": "channel",
          "members_count": 1500
        },
        ...
      ]
    }
  ]
}
```

#### 2. searchChannels

Searches for channels by keywords in their names.

Parameters:

- `keywords` (required) - Keywords to search for in channel names
- `limit` (optional, default: 100) - Maximum number of channels to search through

Example response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 3 channels matching \"crypto\"."
    },
    {
      "type": "json",
      "json": [
        {
          "id": 1234567890,
          "title": "CryptoNews",
          "type": "channel",
          "members_count": 5000
        },
        ...
      ]
    }
  ]
}
```

#### 3. getChannelMessages

Retrieves messages from a specific channel.

Parameters:

- `channelId` (required) - The ID of the channel to fetch messages from
- `limit` (optional, default: 100) - Maximum number of messages to return
- `filterPattern` (optional) - Regex pattern to filter messages

Example response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Retrieved 50 messages from \"CryptoNews\"."
    },
    {
      "type": "json",
      "json": [
        {
          "id": 12345,
          "date": "2023-05-15T14:30:00.000Z",
          "text": "Bitcoin price hits new high!",
          "from_id": 9876543210
        },
        ...
      ]
    }
  ]
}
```

## Using with Claude or other MCP-compatible Assistants

This server can be used with Claude or other MCP-compatible assistants. When connected, the assistant will have access to your Telegram channels and messages through the tools described above.

### Example Workflow

1. Start the MCP server
2. Connect Claude to the MCP server using the MCP URL
3. Ask Claude to:
   - "Show me all available Telegram channels"
   - "Search for channels about crypto"
   - "Get the last 10 messages from channel 1234567890"
   - "Find messages containing UUIDs in the CryptoFrog channel"

## Advanced Usage

### Filtering Messages with Regular Expressions

You can use the `filterPattern` parameter with `getChannelMessages` to find specific types of messages. Some examples:

- `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` - Find UUIDs
- `https?://\\S+` - Find URLs
- `#[a-zA-Z0-9]+` - Find hashtags

## Troubleshooting

- **Authentication Issues**: If you encounter authentication problems, delete the session file in the `data/` directory and restart the server to re-authenticate.
- **Server Crashes**: Check your environment variables and ensure your Telegram API credentials are correct.
- **Access Denied to Channels**: Ensure your Telegram account has access to the channels you're trying to query.
