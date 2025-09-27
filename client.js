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

  const dialogs = await client.listDialogs(50);

  console.log('Available chats:');
  dialogs.forEach((chat, index) => {
    console.log(`${index + 1}. ${chat.title} (ID: ${chat.id})`);
  });

  const firstChat = dialogs[0];
  if (!firstChat) {
    console.log('No chats available.');
    return;
  }

  const { peerTitle, messages } = await client.getMessagesByChannelId(firstChat.id, 10);
  console.log(`\nLatest messages from "${peerTitle}":`);
  messages.forEach(msg => {
    const date = msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown-date';
    console.log(`[${date}] ${msg.text || msg.message || ''}`);
  });

  await client.destroy();
}

main().catch(error => {
  console.error('Error in client example:', error);
});
