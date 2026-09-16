// DeepSeek Web Protocol Headers
// Centralized DeepSeek-specific header construction

import { DEEPSEEK, getClientTimezoneOffset } from "./constants.js";
import type { DeepSeekCredentials, DeepSeekClientHeaders } from "./types.js";

/**
 * Browser identity state - generated once and persisted across requests.
 * This matches the browser's persistent device fingerprint behavior.
 */
export interface BrowserIdentity {
  deviceId: string;
  deviceModel: string;
}

/**
 * Generate or retrieve a stable device ID.
 * In Cloudflare Workers context, we generate a UUID v4 once per worker instance.
 * For production use with Durable Objects or KV storage, this should be persisted.
 */
function generateDeviceId(): string {
  // Simple UUID v4 generation for Cloudflare Workers runtime
  const randomValues = new Uint8Array(16);
  crypto.getRandomValues(randomValues);
  
  // Set version (4) and variant bits
  randomValues[6] = (randomValues[6] & 0x0f) | 0x40;
  randomValues[8] = (randomValues[8] & 0x3f) | 0x80;
  
  const hex = Array.from(randomValues).map(b => b.toString(16).padStart(2, '0'));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}

// Stable browser identity for this worker instance
let cachedBrowserIdentity: BrowserIdentity | null = null;

export function getBrowserIdentity(): BrowserIdentity {
  if (!cachedBrowserIdentity) {
    cachedBrowserIdentity = {
      deviceId: generateDeviceId(),
      deviceModel: "", // Empty string as observed in browser HAR
    };
  }
  return cachedBrowserIdentity;
}

export function buildClientHeaders(): Omit<DeepSeekClientHeaders, "authorization" | "cookie" | "x-hif-leim" | "x-ds-pow-response" | "accept"> {
  const identity = getBrowserIdentity();
  return {
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
    "x-client-version": DEEPSEEK.CLIENT.VERSION,
    "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
    "x-client-timezone-offset": getClientTimezoneOffset(),
    "x-device-id": identity.deviceId,
    "x-device-model": identity.deviceModel,
    "content-type": "application/json",
  };
}

export function getDeepSeekTimezoneOffset(): string {
  return getClientTimezoneOffset();
}

export function buildAuthenticationHeaders(credentials: DeepSeekCredentials, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...buildClientHeaders(),
    accept: "*/*",
    origin: DEEPSEEK.ORIGIN,
  };

  // Add session-aware Referer if sessionId is provided
  if (sessionId) {
    headers["referer"] = `${DEEPSEEK.ORIGIN}/a/chat/s/${sessionId}`;
  } else {
    // For session creation or other non-session requests, use base referer
    headers["referer"] = `${DEEPSEEK.ORIGIN}/a/chat`;
  }

  if (credentials.authorization) {
    headers["authorization"] = credentials.authorization;
  }

  if (credentials.cookie) {
    headers["cookie"] = credentials.cookie;
  }

  return headers;
}

export function buildCompletionHeaders(
  credentials: DeepSeekCredentials,
  powResponse: string,
  hifLeim?: string,
  sessionId?: string,
): Headers {
  const headers = new Headers(buildAuthenticationHeaders(credentials, sessionId));
  headers.set("accept", "text/event-stream");
  headers.set("x-ds-pow-response", powResponse);

  // HIF-LEIM is now required for all completion requests per the wire contract
  if (hifLeim) {
    headers.set("x-hif-leim", hifLeim);
  }

  return headers;
}

export interface HeaderBuildOptions {
  credentials: DeepSeekCredentials;
  powResponse?: string;
  hifLeim?: string;
  accept?: string;
}

export function buildHeaders(options: HeaderBuildOptions): Headers {
  const headers = new Headers(buildAuthenticationHeaders(options.credentials));

  if (options.accept) {
    headers.set("accept", options.accept);
  }

  if (options.powResponse) {
    headers.set("x-ds-pow-response", options.powResponse);
  }

  if (options.hifLeim) {
    headers.set("x-hif-leim", options.hifLeim);
  }

  return headers;
}