// DeepSeek HIF-LEIM Module
// Fetches and caches the x-hif-leim value from the side-channel endpoint
// Uses platform-independent ProtocolStateStore for storage

import { DEEPSEEK } from "./constants.js";
import type { ProtocolStateStore } from "./state-store.js";
import { PROTOCOL_STATE_KEYS } from './state-store.js';

function logHif(message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const prefix = `[HIF-LEIM] ${timestamp}`;
  if (meta) {
    console.log(`${prefix} ${message}`, JSON.stringify(meta));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

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
 * HIF-LEIM cache manager using ProtocolStateStore for platform-independent storage.
 * Maintains a cached value with TTL-based expiration (600 seconds per protocol spec).
 * Implements in-flight request deduplication to prevent redundant fetches.
 */
export class HifLeimCache {
  private state: ProtocolStateStore;
  private readonly ttlSeconds: number;
  private inFlight: Promise<string> | null = null;

  constructor(state: ProtocolStateStore, ttlSeconds: number = DEEPSEEK.HIF.TTL_SECONDS) {
    this.state = state;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Gets a valid HIF-LEIM value from cache or fetches fresh one.
   * Deduplicates concurrent cache-miss requests to avoid redundant network calls.
   */
  async getValue(origin?: string): Promise<string> {
    // Try to get from cache first
    const cached = await this.getFromCache();
    if (cached) {
      logHif("Cache HIT - returning cached value", { length: cached.length, prefix: cached.slice(0, 20) });
      return cached;
    }

    logHif("Cache MISS - fetching fresh value");

    // Check if there's already an in-flight fetch
    if (this.inFlight) {
      logHif("In-flight fetch detected - deduplicating");
      return this.inFlight;
    }

    // Fetch fresh value with deduplication
    try {
      this.inFlight = this.fetchAndStore(origin);
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Retrieves token from cache if valid
   */
  private async getFromCache(): Promise<string | null> {
    return await this.state.get(PROTOCOL_STATE_KEYS.HIF_LEIM);
  }

  /**
   * Fetches fresh value and stores in cache
   */
  private async fetchAndStore(origin?: string): Promise<string> {
    logHif("Fetching fresh HIF-LEIM from side-channel");
    const value = await fetchHifLeim(origin);
    await this.storeInCache(value);
    logHif("Stored fresh HIF-LEIM in cache", { length: value.length, prefix: value.slice(0, 20) });
    return value;
  }

  /**
   * Stores token in cache with TTL
   */
  private async storeInCache(value: string): Promise<void> {
    await this.state.set(PROTOCOL_STATE_KEYS.HIF_LEIM, value, this.ttlSeconds);
  }

  /**
   * Forces a refresh of the cached value.
   */
  async refresh(origin?: string): Promise<string> {
    logHif("Manual refresh requested");
    await this.invalidate();
    return this.getValue(origin);
  }

  /**
   * Invalidates the cached value.
   */
  async invalidate(): Promise<void> {
    logHif("Invalidating cached HIF-LEIM");
    if (this.state.delete) {
      await this.state.delete(PROTOCOL_STATE_KEYS.HIF_LEIM);
    } else {
      // For backends without delete, set empty value with short TTL
      await this.state.set(PROTOCOL_STATE_KEYS.HIF_LEIM, '', 1);
    }
  }
}
