// DeepSeek Web Protocol PoW Challenge
// Fetches PoW challenge from DeepSeek

import { DEEPSEEK, getClientTimezoneOffset } from "./constants.js";
import type { DeepSeekPowChallenge, DeepSeekCredentials, DeepSeekApiResponse } from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";
import { getBrowserIdentity } from "./headers.js";

export async function createPowChallenge(
  credentials: DeepSeekCredentials,
  origin?: string
): Promise<DeepSeekPowChallenge> {
  const baseOrigin = origin || DEEPSEEK.ORIGIN;
  const identity = getBrowserIdentity();

  const headers: Record<string, string> = {
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
    "x-client-version": DEEPSEEK.CLIENT.VERSION,
    "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
    "x-client-timezone-offset": getClientTimezoneOffset(),
    "x-device-id": identity.deviceId,
    "x-device-model": identity.deviceModel,
    "content-type": "application/json",
    accept: "*/*",
    origin: DEEPSEEK.ORIGIN,
    referer: `${DEEPSEEK.ORIGIN}/a/chat`,
  };

  if (credentials.authorization) {
    headers["authorization"] = credentials.authorization;
  }

  if (credentials.cookie) {
    headers["cookie"] = credentials.cookie;
  }

  const response = await fetch(
    `${baseOrigin}${DEEPSEEK.ENDPOINTS.CREATE_POW}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ target_path: DEEPSEEK.ENDPOINTS.COMPLETION }),
    }
  );

  if (!response.ok) {
    throw new DeepSeekProtocolError(
      `DeepSeek PoW challenge failed: HTTP ${response.status}`,
      { kind: "pow", status: response.status }
    );
  }

  const data = (await response.json()) as DeepSeekApiResponse<{ challenge: DeepSeekPowChallenge }>;
  const challenge = data?.data?.biz_data?.challenge;

  if (!challenge) {
    throw new DeepSeekProtocolError(
      "DeepSeek PoW challenge returned invalid response",
      { kind: "pow", raw: data }
    );
  }

  return challenge as DeepSeekPowChallenge;
}