// DeepSeek Android Protocol Edit Message Request Builder
// Builds the exact Android edit_message JSON body.
//
// Captured Android 2.5.3 body (POST /api/v0/chat/edit_message):
//   {
//     "chat_session_id": "...",
//     "message_id": 1,
//     "prompt": "...",
//     "ref_file_ids": [],
//     "thinking_enabled": true,
//     "search_enabled": false,
//     "client_stream_id": "20260922-4195769c0001189e",
//     "action": null
//   }
//
// Property insertion order matches the capture.

import type { EditMessageOptions } from "./edit-message.js";

export interface AndroidEditMessageRequest {
  chat_session_id: string;
  message_id: number;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  client_stream_id: string;
  action: null;
}

/**
 * Generates a client_stream_id shaped like the captured value:
 *   YYYYMMDD-<16 hex chars>
 * e.g. "20260922-4195769c0001189e".
 */
export function generateClientStreamId(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const hex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${y}${m}${d}-${hex}`;
}

/**
 * Builds the Android edit_message request body.
 * Fixed constants: ref_file_ids: [], action: null.
 */
export function buildAndroidEditMessageRequest(
  chatSessionId: string,
  messageId: number,
  prompt: string,
  options: EditMessageOptions = {}
): AndroidEditMessageRequest {
  return {
    chat_session_id: chatSessionId,
    message_id: messageId,
    prompt,
    ref_file_ids: [],
    thinking_enabled: options.thinking_enabled ?? true,
    search_enabled: options.search_enabled ?? false,
    client_stream_id: generateClientStreamId(),
    action: null,
  };
}
