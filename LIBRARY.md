# Telegram Client Library

This library (`telegram-client.js`) enables programmatic interaction with Telegram via the user client API (not bot API).

## Features

- Authentication with Telegram (including 2FA support)
- Session management (automatic reuse of existing sessions)
- Retrieving chats/dialogs on demand
- Fetching messages from specific chats
- Filtering messages by pattern (e.g., regex)

## Usage

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

  await client.initializeDialogCache();

  const dialogs = await client.listDialogs(20);

  dialogs.forEach((chat) => {
    console.log(`Chat: ${chat.title} (ID: ${chat.id})`);
  });

  // Example: Get messages (replace 'your_channel_id' with an actual ID)
  // const { messages } = await client.getMessagesByChannelId('your_channel_id', 50);
  // console.log(messages);
}

main().catch(console.error);
```

Run the standalone client example:

```bash
node client.js
```

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

- `login()`: Authenticates with Telegram (handles new logins, 2FA, and session reuse).
- `initializeDialogCache()`: Ensures authentication with Telegram.
- `listDialogs(limit?)`: Returns the first `limit` dialogs as simple metadata objects.
- `searchDialogs(keyword, limit?)`: Searches dialogs by title or username.
- `ensureLogin()`: Throws if the client is not currently authorized.
- `getMessagesByChannelId(channelId, limit)`: Returns `{ peerTitle, peerId, peerType, messages }` for the requested chat/channel.
- `filterMessagesByPattern(messages, pattern)`: Filters an array of message _strings_ by a regex pattern.
- `destroy()`: Closes the underlying MTProto connection (useful for short-lived scripts).
