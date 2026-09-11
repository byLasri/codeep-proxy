// ProtocolStateStore: Generic storage abstraction for DeepSeek protocol state
// This interface allows the DeepSeek module to remain platform-independent
// while supporting various storage backends (KV, Cache API, in-memory, etc.)

export interface ProtocolStateStore {
  /**
   * Retrieve a value by key.
   * Returns null if the key does not exist or has expired.
   */
  get(key: string): Promise<string | null>;

  /**
   * Store a value with TTL-based expiration.
   * @param key - Storage key
   * @param value - Value to store
   * @param ttlSeconds - Time-to-live in seconds (optional, backend-dependent)
   */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a value by key.
   * Optional operation - some backends may use TTL-only expiration.
   */
  delete?(key: string): Promise<void>;
}

/**
 * Protocol-defined storage keys for DeepSeek state.
 * The DeepSeek module owns these key definitions.
 * 
 * AUTH is the single canonical credential record containing:
 * { authorizationToken?: string, cookies?: Array<{name: string, value: string}> }
 */
export const PROTOCOL_STATE_KEYS = {
  AUTH: 'deepseek:auth',
  HIF_LEIM: 'deepseek:hif:leim',
} as const;
