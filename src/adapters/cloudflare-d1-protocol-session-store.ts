import type { D1Database } from '@cloudflare/workers-types';
import type { ProtocolSession, ProtocolSessionStore } from '../deepseek_api/session-store.js';

export class CloudflareD1ProtocolSessionStore implements ProtocolSessionStore {
  constructor(private readonly db: D1Database) {}

  async initialize(): Promise<void> {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_session_id TEXT PRIMARY KEY,
        parent_message_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run()
  }

  async get(chatSessionId: string): Promise<ProtocolSession | null> {
    const row = await this.db
      .prepare(`
        SELECT chat_session_id, parent_message_id, created_at, updated_at
        FROM sessions
        WHERE chat_session_id = ?
      `)
      .bind(chatSessionId)
      .first<ProtocolSession>()

    return row ?? null
  }

  async create(chatSessionId: string): Promise<void> {
    const now = Date.now()
    await this.db
      .prepare(`
        INSERT INTO sessions (chat_session_id, parent_message_id, created_at, updated_at)
        VALUES (?, NULL, ?, ?)
      `)
      .bind(chatSessionId, now, now)
      .run()
  }

  async advance(chatSessionId: string, parentMessageId: number): Promise<void> {
    const result = await this.db
      .prepare(`
        UPDATE sessions
        SET parent_message_id = ?, updated_at = ?
        WHERE chat_session_id = ?
      `)
      .bind(parentMessageId, Date.now(), chatSessionId)
      .run()

    if (!result.meta.changes) {
      throw new Error(`Protocol session not found: ${chatSessionId}`)
    }
  }
}
