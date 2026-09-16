// DeepSeek Web Protocol Edit Message Request Builder
// Builds the exact DeepSeek wire request for /api/v0/chat/edit_message
// Observed browser HAR body shape:
// {
//   "chat_session_id": "<same session>",
//   "message_id": <original request message id>,
//   "ref_file_ids": [],
//   "prompt": "<edited prompt>",
//   "search_enabled": false,
//   "thinking_enabled": true,
//   "action": null
// }
// Important: No parent_message_id field

import type {
  DeepSeekCredentials,
  DeepSeekApiResponse,
} from "./types.js";
import { DEEPSEEK, getClientTimezoneOffset } from "./constants.js";
import { DeepSeekProtocolError } from "./errors.js";
import { getBrowserIdentity, buildAuthenticationHeaders } from "./headers.js";
import { createPowChallenge } from "./pow-challenge.js";
import { solvePow, encodePowResponse } from "./pow.js";
import { fetchHifLeim } from "./hif-leim.js";

export interface DeepSeekEditMessageRequest {
  chat_session_id: string;
  message_id: number;
  ref_file_ids: string[];
  prompt: string;
  search_enabled: boolean;
  thinking_enabled: boolean;
  action: null;
}

export interface DeepSeekEditMessageResult {
  request_message_id: number;
  response_message_id: number;
}

export interface EditMessageOptions {
  model_type?: string | null;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
}

/**
 * Builds edit message request with strict protocol constants.
 * - action: ALWAYS null (fixed)
 * - ref_file_ids: ALWAYS [] (fixed)
 * - message_id: from caller (the original message being edited)
 */
export function buildEditMessageRequest(
  chatSessionId: string,
  messageId: number,
  prompt: string,
  options: EditMessageOptions = {}
): DeepSeekEditMessageRequest {
  const FIXED_ACTION = null;
  const FIXED_REF_FILE_IDS: string[] = [];

  return {
    chat_session_id: chatSessionId,
    message_id: messageId,
    ref_file_ids: FIXED_REF_FILE_IDS,
    prompt,
    search_enabled: options.search_enabled ?? false,
    thinking_enabled: options.thinking_enabled ?? true,
    action: FIXED_ACTION,
  };
}

/**
 * Executes the edit_message flow:
 * 1. Fetch fresh PoW challenge (session-aware)
 * 2. Fetch HIF-LEIM
 * 3. POST /api/v0/chat/edit_message
 * 4. Parse response to extract request_message_id and response_message_id
 */
export async function editMessage(
  credentials: DeepSeekCredentials,
  chatSessionId: string,
  messageId: number,
  prompt: string,
  options: EditMessageOptions = {},
  origin?: string
): Promise<DeepSeekEditMessageResult> {
  const baseOrigin = origin || DEEPSEEK.ORIGIN;

  // Fetch HIF-LEIM (cached)
  // Note: We need a stateStore for HIF-LEIM cache, but editMessage is a low-level function
  // For now, we fetch without caching here; the caller can manage HIF-LEIM if needed
  let hifLeim: string | undefined;
  try {
    // Attempt to fetch HIF-LEIM without cache (stateStore not available at this level)
    // This is a simplified approach; production should pass stateStore or HIF value
    const hifResponse = await fetchHifLeimWithoutCache(credentials, baseOrigin);
    hifLeim = hifResponse?.value;
  } catch {
    // HIF-LEIM may be optional for edit_message; continue without it if fetch fails
    hifLeim = undefined;
  }

  // Create fresh PoW challenge with session ID for session-aware Referer
  const challenge = await createPowChallenge(credentials, baseOrigin, chatSessionId);

  // Solve PoW
  const solution = solvePow(challenge);

  // Encode PoW response
  const powHeader = encodePowResponse(solution);

  // Build headers using centralized browser identity with session-aware Referer
  const headers = buildEditHeaders(credentials, powHeader, hifLeim, chatSessionId);

  // Build request body
  const requestBody = buildEditMessageRequest(chatSessionId, messageId, prompt, options);

  // Send edit_message request
  const response = await fetch(`${baseOrigin}${DEEPSEEK.ENDPOINTS.EDIT_MESSAGE}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new DeepSeekProtocolError(
      `DeepSeek edit_message failed: HTTP ${response.status}`,
      { kind: "edit_message", status: response.status }
    );
  }

  if (!response.body) {
    throw new DeepSeekProtocolError(
      "DeepSeek edit_message returned no body",
      { kind: "edit_message", status: 502 }
    );
  }

  // Parse SSE stream to extract request_message_id and response_message_id
  return parseEditMessageResponse(response.body);
}

function buildEditHeaders(
  credentials: DeepSeekCredentials,
  powResponse: string,
  hifLeim?: string,
  sessionId?: string
): Headers {
  const headers = new Headers(buildAuthenticationHeaders(credentials, sessionId));
  headers.set("accept", "text/event-stream");
  headers.set("x-ds-pow-response", powResponse);

  if (hifLeim) {
    headers.set("x-hif-leim", hifLeim);
  }

  return headers;
}

async function parseEditMessageResponse(
  body: ReadableStream<Uint8Array>
): Promise<DeepSeekEditMessageResult> {
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let result: DeepSeekEditMessageResult | null = null;

  const reader = body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseEditMessageLine(line);
        if (parsed) {
          result = parsed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Process any remaining buffer
  if (sseBuffer.trim()) {
    const parsed = parseEditMessageLine(sseBuffer);
    if (parsed && !result) {
      result = parsed;
    }
  }

  if (!result) {
    throw new DeepSeekProtocolError(
      "DeepSeek edit_message returned no valid response",
      { kind: "edit_message", raw: "No response_message_id found" }
    );
  }

  return result;
}

function parseEditMessageLine(line: string): DeepSeekEditMessageResult | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload.startsWith("{")) {
    return null;
  }

  try {
    const data = JSON.parse(payload) as {
      request_message_id?: unknown;
      response_message_id?: unknown;
    };

    const requestId =
      typeof data.request_message_id === "number" ? data.request_message_id : null;
    const responseId =
      typeof data.response_message_id === "number" ? data.response_message_id : null;

    if (requestId !== null && responseId !== null) {
      return {
        request_message_id: requestId,
        response_message_id: responseId,
      };
    }
  } catch {
    // Incomplete or non-JSON line
  }

  return null;
}

/**
 * Fetch HIF-LEIM without caching (for use in low-level editMessage function).
 * Production code should use HifLeimCache with stateStore.
 */
async function fetchHifLeimWithoutCache(
  credentials: DeepSeekCredentials,
  origin: string
): Promise<{ value: string; expiresAt: number } | null> {
  try {
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
      origin: DEEPSEEK.HIF.LEIM_ORIGIN,
      referer: `${DEEPSEEK.ORIGIN}/a/chat`,
    };

    if (credentials.authorization) {
      headers["authorization"] = credentials.authorization;
    }

    if (credentials.cookie) {
      headers["cookie"] = credentials.cookie;
    }

    const response = await fetch(
      `${DEEPSEEK.HIF.LEIM_ORIGIN}${DEEPSEEK.HIF.LEIM_ENDPOINT}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    if (data && typeof data.data === "string") {
      // HIF-LEIM response typically has TTL; use default from constants
      return {
        value: data.data as string,
        expiresAt: Date.now() + DEEPSEEK.HIF.TTL_SECONDS * 1000,
      };
    }

    return null;
  } catch {
    return null;
  }
}
