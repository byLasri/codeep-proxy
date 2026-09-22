// DeepSeek Android Protocol Identity
// Owns Android-style persistent device identity.
//
// The Android client identifies itself with:
//   x-device-id: base64 device identifier (server-issued on real devices)
//   x-device-model: real device model string
//   x-rangers-id: large numeric string
//
// The proxy generates and persists an Android-shaped identity rather than
// replaying the captured sample device's identity. The captured values are a
// protocol reference only.

import type { ProtocolStateStore } from "./state-store.js";
import { PROTOCOL_STATE_KEYS } from "./state-store.js";

/**
 * Android profile device model, as observed in the Android 2.5.3 capture.
 * This is an explicit Android-profile value, not the browser's empty model.
 */
export const ANDROID_DEVICE_MODEL = "NX809J";

/**
 * Number of random bytes used for the generated device identifier.
 * The captured identifier is a base64 string over binary/random data.
 */
const DEVICE_ID_BYTES = 32;

/**
 * Upper bound (exclusive) for the generated rangers id.
 * The captured value (7685111460929750020) is a 19-digit integer that exceeds
 * Number.MAX_SAFE_INTEGER, so we represent it as a decimal string.
 */
const RANGERS_ID_DIGITS = 19;

export interface AndroidDeviceIdentity {
  deviceId: string;
  deviceModel: string;
  rangersId: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Generates an Android-shaped base64 device identifier.
 * 32 random bytes encoded as base64, matching the captured shape
 * (e.g. "wR1495uB7x9nBHSk79oHsBaxTtihyhspsZQSm6SeHYk=").
 */
export function generateAndroidDeviceId(): string {
  const bytes = new Uint8Array(DEVICE_ID_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

/**
 * Generates a persistent Android-like large numeric rangers id as a decimal
 * string. A leading non-zero digit keeps the shape close to the captured value.
 */
export function generateAndroidRangersId(): string {
  const digits: string[] = [];
  // First digit 1-9, remaining digits 0-9.
  digits.push(String(1 + Math.floor(Math.random() * 9)));
  for (let i = 1; i < RANGERS_ID_DIGITS; i += 1) {
    digits.push(String(Math.floor(Math.random() * 10)));
  }
  return digits.join("");
}

function isAndroidDeviceIdentity(value: unknown): value is AndroidDeviceIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // deviceModel is a profile constant and optional in the persisted record;
  // it is always normalized to ANDROID_DEVICE_MODEL on read.
  return (
    typeof v.deviceId === "string" &&
    v.deviceId.length > 0 &&
    typeof v.rangersId === "string" &&
    /^\d{1,20}$/.test(v.rangersId)
  );
}

/**
 * Resolves the persistent Android device identity from the protocol state store.
 *
 * On first use, a new identity is generated and persisted. On subsequent calls
 * the stored identity is reused, so the identity survives Worker instance
 * changes. The device model is always the Android-profile constant.
 */
export async function getAndroidIdentity(
  stateStore: ProtocolStateStore
): Promise<AndroidDeviceIdentity> {
  const stored = await stateStore.get(PROTOCOL_STATE_KEYS.ANDROID_IDENTITY);

  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (isAndroidDeviceIdentity(parsed)) {
        return {
          deviceId: parsed.deviceId,
          deviceModel: ANDROID_DEVICE_MODEL,
          rangersId: parsed.rangersId,
        };
      }
    } catch {
      // Corrupt state falls through to regeneration.
    }
  }

  const identity: AndroidDeviceIdentity = {
    deviceId: generateAndroidDeviceId(),
    deviceModel: ANDROID_DEVICE_MODEL,
    rangersId: generateAndroidRangersId(),
  };

  await stateStore.set(
    PROTOCOL_STATE_KEYS.ANDROID_IDENTITY,
    JSON.stringify({
      deviceId: identity.deviceId,
      deviceModel: identity.deviceModel,
      rangersId: identity.rangersId,
    })
  );

  return identity;
}
