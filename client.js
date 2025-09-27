import dotenv from 'dotenv';
import TelegramClient from './telegram-client.js';

dotenv.config();

async function main() {
  const client = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER,
    './data/session.json'
  );

  await client.initializeDialogCache();

  console.log('Available chats:');
  let index = 1;
  for (const chat of client.dialogCache.values()) {
    if (chat.title) {
      console.log(`${index}. ${chat.title} (ID: ${chat.id})`);
      index += 1;
    }
  }

  const firstChat = client.dialogCache.values().next().value;
  if (!firstChat) {
    console.log('No chats available.');
    return;
  }

  const sampleMessages = await client.getMessagesByChannelId(firstChat.id, 10);
  console.log(`\nLatest messages from "${firstChat.title}":`);
  sampleMessages.forEach(msg => {
    const date = msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown-date';
    console.log(`[${date}] ${msg.text || msg.message || ''}`);
  });
}

main().catch(error => {
  console.error('Error in client example:', error);
});
