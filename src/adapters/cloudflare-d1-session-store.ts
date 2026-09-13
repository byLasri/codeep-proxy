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

  async getByXSessionId(xSessionId: string): Promise<{ chatSessionId: string } | null> {
    const result = await this.db
      .prepare('SELECT chat_session_id FROM x_session_map WHERE x_session_id = ?')
      .bind(xSessionId)
      .first();

    if (!result) {
      return null;
    }

    const row = result as { chat_session_id: string };
    return { chatSessionId: row.chat_session_id };
  }

  async setXSessionMapping(xSessionId: string, chatSessionId: string): Promise<void> {
    const now = Date.now();
    const createdAt = now; // For insert, we set both to now. On update, we preserve created_at.
    // We use the upsert pattern: insert, and on conflict update the chat_session_id and updated_at.
    // We want to keep the original created_at on conflict, so we use excluded for the update but
    // we cannot reference the old created_at directly in the ON CONFLICT clause in SQLite.
    // Instead, we do: INSERT ... ON CONFLICT(x_session_id) DO UPDATE SET
    //   chat_session_id = excluded.chat_session_id,
    //   updated_at = excluded.updated_at
    // But then we lose the original created_at. To preserve it, we need to set created_at to
    // the old value if exists, otherwise the new value.
    // However, SQLite's upsert does not allow referencing the old value in the SET clause directly.
    // We can use a trick: do the insert, and on conflict, we update the chat_session_id and updated_at,
    // and set created_at to the old created_at (which is the value already in the row).
    // But we cannot reference the old value in the SET clause? Actually, we can use `excluded` only for the new values.
    // The old values are not available in the SET clause. So we need to do it differently.
    // Alternatively, we can do a separate query to get the existing created_at, but that's two queries.
    // Another approach: use the `INSERT OR REPLACE` but that would delete and insert, losing the rowid and maybe not preserving created_at if we don't set it.
    // We want to preserve the original created_at on update.
    // Let's do: first try to update, and if no rows affected, then insert.
    // But we are constrained to use parameterized queries and we want to avoid race conditions.
    // However, the task says to use the atomic upsert with ON CONFLICT and preserve created_at.
    // We can use the following SQLite upsert that preserves the original created_at:
    //   INSERT INTO x_session_map (x_session_id, chat_session_id, created_at, updated_at)
    //   VALUES (?, ?, ?, ?)
    //   ON CONFLICT(x_session_id) DO UPDATE SET
    //     chat_session_id = excluded.chat_session_id,
    //     updated_at = excluded.updated_at,
    //     created_at = COALESCE((SELECT created_at FROM x_session_map WHERE x_session_id = excluded.x_session_id), excluded.created_at)
    // But that is not allowed because we cannot use a subquery in the SET clause of an upsert in SQLite? Actually, we can.
    // However, let's keep it simple and use two steps: first update, then if no rows changed, insert.
    // Given the low traffic and that we are in a Cloudflare Worker, we can accept the risk of a race condition?
    // But the task says to use atomic upsert. We'll try to do it in one statement with a subquery.
    // Alternatively, we can note that the created_at is only set on insert and never changed, so we can set it to the same value on update.
    // But then we would be updating created_at to the new value on every update, which we don't want.
    // We want to keep the original created_at.
    // Let's look at the existing `set` method in this class for sessions: it uses
    //   INSERT ... ON CONFLICT DO UPDATE SET parent_message_id = excluded.parent_message_id, updated_at = excluded.updated_at
    // and it does not try to preserve created_at because it sets createdAt = state.created_at ?? now, and then in the upsert it uses excluded.created_at.
    // Wait, in the existing `set` method, we have:
    //   const createdAt = state.created_at ?? now;
    //   ... then in the upsert we use excluded.created_at.
    // So if state.created_at is provided (from an existing state), we use that, otherwise we use now.
    // And then in the upsert, we set created_at to excluded.created_at, which is the value we just computed.
    // So it does update created_at on every upsert to the value we passed in.
    // That means the existing `set` method does not preserve the original created_at if we are updating from a state that doesn't have created_at set.
    // But in our usage, when we set a session, we always pass a state that has created_at (from the store) or we set it to now.
    // So it's okay.
    // For the x_session_map, we want to preserve the original created_at on update, meaning we don't want to change it.
    // So we need to avoid updating created_at on conflict.
    // We can do:
    //   INSERT INTO x_session_map (x_session_id, chat_session_id, created_at, updated_at)
    //   VALUES (?, ?, ?, ?)
    //   ON CONFLICT(x_session_id) DO UPDATE SET
    //     chat_session_id = excluded.chat_session_id,
    //     updated_at = excluded.updated_at
    //   -- and leave created_at alone.
    // But in SQLite, if we don't mention created_at in the SET clause, it will remain unchanged.
    // Let's test: In SQLite, if we do an upsert and do not set a column in the SET clause, it keeps the old value.
    // Yes, that's how it works.
    // So we can simply not include created_at in the SET clause.
    // Therefore, we do:
    await this.db
      .prepare(`
        INSERT INTO x_session_map (x_session_id, chat_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(x_session_id) DO UPDATE SET
          chat_session_id = excluded.chat_session_id,
          updated_at = excluded.updated_at
      `)
      .bind(xSessionId, chatSessionId, now, now)
      .run();
  }

  async deleteXSessionMapping(xSessionId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM x_session_map WHERE x_session_id = ?')
      .bind(xSessionId)
      .run();
  }
}