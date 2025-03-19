import dotenv from 'dotenv';
import TelegramClient from './telegram-client.js';

// Load environment variables from .env file
dotenv.config();

async function main() {
  // Initialize the Telegram client
  const client = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER,
    './data/session.json'
  );

  // Log in to Telegram
  await client.login();

  try {
    // Get dialogs (chats)
    const dialogsResult = await client.getDialogs();
    
    // Example: Find a specific chat (e.g., "FROGCRYPTO")
    const targetChatName = "FROGCRYPTO"; // This can be changed to any chat name
    const targetChat = dialogsResult.chats.find(chat => 
      chat.title && chat.title.includes(targetChatName)
    );

    if (targetChat) {
      console.log(`Found chat "${targetChat.title}" (ID: ${targetChat.id})`);
      
      // Get messages from the target chat
      const messages = await client.getChatMessages(targetChat);
      
      // Filter messages containing UUIDs
      const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
      const necklaces = client.filterMessagesByPattern(messages, uuidPattern);
      
      console.log(`Found ${necklaces.length} messages containing UUIDs:`, necklaces);
    } else {
      console.log(`No chat found with "${targetChatName}" in the title.`);
      
      // List all available chats
      console.log('Available chats:');
      dialogsResult.chats.forEach((chat, index) => {
        if (chat.title) {
          console.log(`${index + 1}. ${chat.title} (ID: ${chat.id})`);
        }
      });
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the main function
main().catch(console.error);
