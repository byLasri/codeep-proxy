// Cloudflare KV implementation of ProtocolStateStore
// This adapter lives in the Worker layer, not in the DeepSeek module

import type { KVNamespace } from '@cloudflare/workers-types';
import type { ProtocolStateStore } from '../deepseek_api/state-store.js';

export class CloudflareKVStateStore implements ProtocolStateStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const options = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
    await this.kv.put(key, value, options);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
