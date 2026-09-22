// DeepSeek Android Protocol Headers
// Builds the Android-shaped application header set for DeepSeek API calls.
//
// Values are taken from the captured Android 2.5.3 request profile
// (mobile_protocol_capture.md). This is a dedicated Android header path and
// intentionally does NOT reuse the web header builders.
//
// The Android completion request MUST NOT send:
//   origin
//   referer
//   x-hif-leim
//   cookie

import { DEEPSEEK } from "./constants.js";
import type { DeepSeekCredentials } from "./types.js";
import type { AndroidDeviceIdentity } from "./android-identity.js";

export const ANDROID_PROFILE = {
  PLATFORM: "android",
  VERSION: "2.5.3",
  LOCALE: "en_US",
  TIMEZONE_OFFSET: "28800",
  USER_AGENT: "DeepSeek/2.5.3 Android/28",
  ACCEPT: "application/json",
  ACCEPT_CHARSET: "UTF-8",
  ACCEPT_ENCODING: "gzip",
} as const;

/**
 * Application-level Android client headers shared by all Android API calls.
 * Does not include credentials, PoW, or request-specific headers.
 */
export function buildAndroidClientHeaders(
  identity: AndroidDeviceIdentity
): Record<string, string> {
  return {
    "x-client-platform": ANDROID_PROFILE.PLATFORM,
    "x-client-version": ANDROID_PROFILE.VERSION,
    "x-client-locale": ANDROID_PROFILE.LOCALE,
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-rangers-id": identity.rangersId,
    "x-client-timezone-offset": ANDROID_PROFILE.TIMEZONE_OFFSET,
    "x-device-model": identity.deviceModel,
    "x-device-id": identity.deviceId,
    "user-agent": ANDROID_PROFILE.USER_AGENT,
    accept: ANDROID_PROFILE.ACCEPT,
    "accept-charset": ANDROID_PROFILE.ACCEPT_CHARSET,
    "accept-encoding": ANDROID_PROFILE.ACCEPT_ENCODING,
  };
}

/**
 * Android headers for authenticated JSON API calls (session create, PoW, etc.).
 */
export function buildAndroidApiHeaders(
  credentials: DeepSeekCredentials,
  identity: AndroidDeviceIdentity
): Record<string, string> {
  const headers = buildAndroidClientHeaders(identity);
  headers["content-type"] = "application/json";
  if (credentials.authorization) {
    headers["authorization"] = credentials.authorization;
  }
  return headers;
}

/**
 * Android headers for POST /api/v0/chat/completion.
 * Adds the PoW response. Deliberately omits origin, referer, x-hif-leim and
 * cookie.
 */
export function buildAndroidCompletionHeaders(
  credentials: DeepSeekCredentials,
  identity: AndroidDeviceIdentity,
  powResponse: string
): Headers {
  const headers = new Headers(buildAndroidApiHeaders(credentials, identity));
  headers.set("x-ds-pow-response", powResponse);
  return headers;
}
