// ProtocolSessionStore: Generic session storage abstraction for DeepSeek protocol
// This interface allows the DeepSeek module to remain platform-independent
// while supporting various storage backends (D1, KV, in-memory, etc.)

import type { DeepSeekConversationState } from "./types.js";

export interface ProtocolSessionStore {
  /**
   * Retrieve conversation state by chat session ID.
   * Returns null if the session does not exist.
   */
  get(chatSessionId: string): Promise<DeepSeekConversationState | null>;

  /**
   * Store or update conversation state.
   */
  set(chatSessionId: string, state: DeepSeekConversationState): Promise<void>;

  /**
   * Delete a session by chat session ID.
   * Optional operation - some backends may not need explicit deletion.
   */
  delete?(chatSessionId: string): Promise<void>;
}