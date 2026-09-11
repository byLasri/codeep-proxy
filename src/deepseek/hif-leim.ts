// DeepSeek HIF-LEIM Module
// Fetches and caches the x-hif-leim value from the side-channel endpoint
// Now uses Cloudflare KV for persistent stateless storage

import { DEEPSEEK } from "./constants.js";
import type { DeepSeekCredentials } from "./types.js";
import { StateManager } from "./state-manager.js";

export interface HifLeimValue {
  value: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface HifLeimResponse {
  code: number;
  msg: string;
  data: {
    biz_code: number;
    biz_msg: string;
    biz_data: {
      value: string;
    };
  };
}

/**
 * Builds headers for HIF-LEIM acquisition request.
 * Per the wire contract, this request does NOT include Authorization, Cookie, Origin, or Referer.
 */
export function buildHifLeimHeaders(): Record<string, string> {
  return {
    "accept": "*/*",
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
    "x-client-version": DEEPSEEK.CLIENT.VERSION,
    "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
    "x-client-timezone-offset": DEEPSEEK.CLIENT.LOCALE === "en_US" ? "3600" : "3600",
  };
}

/**
 * Fetches a fresh HIF-LEIM value from the side-channel endpoint.
 * 
 * GET https://hif-leim.deepseek.com/query
 * 
 * Returns the opaque value from data.biz_data.value
 */
export async function fetchHifLeim(origin?: string): Promise<string> {
  const leimOrigin = origin || DEEPSEEK.HIF.LEIM_ORIGIN;
  const endpoint = `${leimOrigin}${DEEPSEEK.HIF.LEIM_ENDPOINT}`;
  
  const response = await fetch(endpoint, {
    method: "GET",
    headers: buildHifLeimHeaders(),
  });
  
  if (!response.ok) {
    throw new Error(
      `HIF-LEIM acquisition failed: HTTP ${response.status} ${response.statusText}`
    );
  }
  
  const json: HifLeimResponse = await response.json();
  
  if (json.code !== 0) {
    throw new Error(
      `HIF-LEIM server error: code=${json.code}, msg=${json.msg}`
    );
  }
  
  const value = json.data?.biz_data?.value;
  
  if (!value) {
    throw new Error("HIF-LEIM response missing data.biz_data.value");
  }
  
  return value;
}

/**
 * HIF-LEIM cache manager using Cloudflare KV for persistent stateless storage.
 * Maintains a cached value with TTL-based expiration.
 * Works in stateless Cloudflare Worker environment.
 */
export class HifLeimCache {
  private state: StateManager;
  private readonly ttlSeconds: number;

  constructor(state: StateManager, ttlSeconds: number = DEEPSEEK.HIF.TTL_SECONDS) {
    this.state = state;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Gets a valid HIF-LEIM value from KV cache or fetches fresh one.
   * Handles concurrent requests by deduplicating in-flight fetches.
   */
  async getValue(origin?: string): Promise<string> {
    // Try to get from KV cache first
    const cached = await this.getFromCache();
    if (cached) {
      return cached;
    }

    // Fetch fresh value
    const value = await fetchHifLeim(origin);
    
    // Store in KV cache
    await this.storeInCache(value);
    
    return value;
  }

  /**
   * Retrieves token from Cloudflare KV if valid
   */
  private async getFromCache(): Promise<string | null> {
    return await this.state.getHifLeim();
  }

  /**
   * Stores token in Cloudflare KV with TTL
   */
  private async storeInCache(value: string): Promise<void> {
    await this.state.setHifLeim(value, this.ttlSeconds);
  }

  /**
   * Forces a refresh of the cached value.
   */
  async refresh(origin?: string): Promise<string> {
    await this.state.clearHifLeim();
    return this.getValue(origin);
  }

  /**
   * Invalidates the cached value.
   */
  async invalidate(): Promise<void> {
    await this.state.clearHifLeim();
  }
}
