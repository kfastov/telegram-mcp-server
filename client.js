import dotenv from 'dotenv';
import TelegramClient from './telegram-client.js';

// Load environment variables from .env file
dotenv.config();

// Example usage of the TelegramClient class
async function main() {
  // Create a new TelegramClient instance
  const client = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER,
    './data/session.json'
  );

  // Log in to Telegram
  const loggedIn = await client.login();
  if (!loggedIn) {
    console.error('Failed to log in. Exiting...');
    return;
  }

  try {
    // Get all dialogs (chats)
    const dialogsResult = await client.getDialogs(100, 0);
    console.log(`Found ${dialogsResult.chats.length} chats`);

    // Example: Find a specific chat by title
    const findChatByTitle = (title) => {
      const chat = dialogsResult.chats.find(chat => 
        chat.title && chat.title.includes(title)
      );
      
      if (chat) {
        console.log(`Found chat "${chat.title}" (ID: ${chat.id})`);
      } else {
        console.log(`No chat found with "${title}" in the title.`);
      }
      
      return chat;
    };

    // Example: Get messages from a specific chat
    const getMessagesFromChat = async (chatTitle) => {
      const chat = findChatByTitle(chatTitle);
      if (!chat) return [];

      const messages = await client.getChatMessages(chat, 100);
      console.log(`Retrieved ${messages.length} messages from "${chat.title}"`);
      return messages;
    };

    // Example: Filter messages by a pattern (e.g., UUIDs)
    const filterMessagesWithUUIDs = async (chatTitle) => {
      const messages = await getMessagesFromChat(chatTitle);
      
      // UUID regex pattern
      const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
      const filteredMessages = client.filterMessagesByPattern(messages, uuidPattern);
      
      console.log(`Found ${filteredMessages.length} messages containing UUIDs`);
      return filteredMessages;
    };

    // Example usage: Replace 'YOUR_CHAT_NAME' with the chat you want to search
    // const uuidMessages = await filterMessagesWithUUIDs('YOUR_CHAT_NAME');
    // console.log('Messages with UUIDs:', uuidMessages);

    // List all chats
    console.log('Available chats:');
    dialogsResult.chats.forEach((chat, index) => {
      if (chat.title) {
        console.log(`${index + 1}. ${chat.title} (ID: ${chat.id})`);
      }
    });

  } catch (error) {
    console.error('Error in client application:', error);
  }
}

// Run the main function
main().catch(console.error); 