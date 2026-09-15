// ProtocolSessionStore: Generic session storage abstraction for DeepSeek protocol
// This interface allows the DeepSeek module to remain platform-independent
// while supporting various storage backends (D1, KV, in-memory, etc.)

export interface ProxySessionState {
  x_session_id: string;
  chat_session_id: string;
  parent_message_id: number | null;
  turn_count: number;
  created_at: number;
  updated_at: number;
}

export interface ProtocolSessionStore {
  /**
   * Retrieve session state by X-Session-Id.
   * Returns null if the session does not exist.
   */
  get(xSessionId: string): Promise<ProxySessionState | null>;

  /**
   * Store or update session state.
   */
  set(xSessionId: string, state: ProxySessionState): Promise<void>;

  /**
   * Delete a session by X-Session-Id.
   * Optional operation - some backends may not need explicit deletion.
   */
  delete?(xSessionId: string): Promise<void>;
}
