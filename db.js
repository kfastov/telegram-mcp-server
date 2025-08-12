import pkg from 'pg';
const { Client } = pkg;

export class Database {
  constructor(connectionString) {
    this.client = new Client({ connectionString });
  }

  async connect() {
    await this.client.connect();
  }

  async disconnect() {
    await this.client.end();
  }

  async init() {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id BIGINT PRIMARY KEY,
        title TEXT,
        type TEXT,
        access_hash BIGINT
      );
    `);

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGINT,
        chat_id BIGINT REFERENCES chats(id) ON DELETE CASCADE,
        date TIMESTAMP,
        text TEXT,
        from_id BIGINT,
        PRIMARY KEY (id, chat_id)
      );
    `);
  }

  async saveChat(chat) {
    const { id, title, type, access_hash } = chat;
    await this.client.query(
      `INSERT INTO chats (id, title, type, access_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, type=EXCLUDED.type, access_hash=EXCLUDED.access_hash`,
      [id, title, type, access_hash || null]
    );
  }

  async saveMessage(message) {
    const { id, chat_id, date, text, from_id } = message;
    await this.client.query(
      `INSERT INTO messages (id, chat_id, date, text, from_id)
       VALUES ($1, $2, to_timestamp($3), $4, $5)
       ON CONFLICT (id, chat_id) DO NOTHING`,
      [id, chat_id, date, text, from_id || null]
    );
  }

  async getAllChats() {
    const res = await this.client.query(
      'SELECT id, title, type, access_hash FROM chats'
    );
    return res.rows;
  }
}
