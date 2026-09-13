// Cloudflare D1 implementation of ProtocolSessionStore
// This adapter lives in the Worker layer, not in the DeepSeek module

import type { D1Database } from '@cloudflare/workers-types';
import type { ProtocolSessionStore } from '../deepseek_api/session-store.js';
import type { DeepSeekConversationState } from '../deepseek_api/types.js';

export class CloudflareD1SessionStore implements ProtocolSessionStore {
  constructor(private readonly db: D1Database) {}

  async get(chatSessionId: string): Promise<DeepSeekConversationState | null> {
    const result = await this.db
      .prepare('SELECT * FROM sessions WHERE chat_session_id = ?')
      .bind(chatSessionId)
      .first();

    if (!result) {
      return null;
    }

    const row = result as {
      chat_session_id: string;
      parent_message_id: number;
      created_at: number;
      updated_at: number;
    };

    return {
      chat_session_id: row.chat_session_id,
      // 0 is the D1 sentinel for first-turn null (column is INTEGER NOT NULL)
      parent_message_id: row.parent_message_id === 0 ? null : row.parent_message_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async set(chatSessionId: string, state: DeepSeekConversationState): Promise<void> {
    const now = Date.now();
    const parentMessageId = state.parent_message_id ?? 0;
    const createdAt = state.created_at ?? now;
    const updatedAt = now;

    await this.db
      .prepare(`
        INSERT INTO sessions (chat_session_id, parent_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_session_id) DO UPDATE SET
          parent_message_id = excluded.parent_message_id,
          updated_at = excluded.updated_at
      `)
      .bind(chatSessionId, parentMessageId, createdAt, updatedAt)
      .run();
  }

  async delete(chatSessionId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM sessions WHERE chat_session_id = ?')
      .bind(chatSessionId)
      .run();
  }
}