// Cloudflare D1 implementation of ProtocolSessionStore
// This adapter lives in the Worker layer, not in the DeepSeek module

import type { D1Database } from '@cloudflare/workers-types';
import type { ProtocolSessionStore, ProxySessionState } from '../deepseek_api/session-store.js';

export class CloudflareD1SessionStore implements ProtocolSessionStore {
  constructor(private readonly db: D1Database) {}

  async get(xSessionId: string): Promise<ProxySessionState | null> {
    const result = await this.db
      .prepare('SELECT * FROM proxy_sessions WHERE x_session_id = ?')
      .bind(xSessionId)
      .first();

    if (!result) {
      return null;
    }

    const row = result as {
      x_session_id: string;
      chat_session_id: string;
      parent_message_id: number;
      turn_count: number;
      created_at: number;
      updated_at: number;
    };

    return {
      x_session_id: row.x_session_id,
      chat_session_id: row.chat_session_id,
      // 0 is the D1 sentinel for first-turn null (column is INTEGER NOT NULL)
      parent_message_id: row.parent_message_id === 0 ? null : row.parent_message_id,
      turn_count: row.turn_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async set(xSessionId: string, state: ProxySessionState): Promise<void> {
    const now = Date.now();
    const parentMessageId = state.parent_message_id ?? 0;
    const createdAt = state.created_at ?? now;
    const updatedAt = now;

    await this.db
      .prepare(`
        INSERT INTO proxy_sessions (x_session_id, chat_session_id, parent_message_id, turn_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(x_session_id) DO UPDATE SET
          chat_session_id = excluded.chat_session_id,
          parent_message_id = excluded.parent_message_id,
          turn_count = excluded.turn_count,
          updated_at = excluded.updated_at
      `)
      .bind(xSessionId, state.chat_session_id, parentMessageId, state.turn_count, createdAt, updatedAt)
      .run();
  }

  async delete(xSessionId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM proxy_sessions WHERE x_session_id = ?')
      .bind(xSessionId)
      .run();
  }

  
}
