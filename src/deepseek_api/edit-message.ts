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

import { DEEPSEEK } from "./constants.js";
import { DeepSeekProtocolError } from "./errors.js";

export interface DeepSeekEditMessageRequest {
  chat_session_id: string;
  message_id: number;
  ref_file_ids: string[];
  prompt: string;
  search_enabled: boolean;
  thinking_enabled: boolean;
  action: null;
}

export interface EditMessageOptions {
  model_type?: string | null;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
}

/**
 * Builds edit message request with strict protocol constants.
 */
export function buildEditMessageRequest(
  chatSessionId: string,
  messageId: number,
  prompt: string,
  options: EditMessageOptions = {}
): DeepSeekEditMessageRequest {
  return {
    chat_session_id: chatSessionId,
    message_id: messageId,
    ref_file_ids: [],
    prompt,
    search_enabled: options.search_enabled ?? false,
    thinking_enabled: options.thinking_enabled ?? true,
    action: null,
  };
}

/**
 * Executes the edit_message flow.
 * Expects pre-built headers from the caller.
 * Returns the raw response stream for the caller to consume.
 */
export async function editMessage(
  headers: Headers,
  chatSessionId: string,
  messageId: number,
  prompt: string,
  origin: string,
  options: EditMessageOptions = {}
): Promise<Response> {
  const requestBody = buildEditMessageRequest(chatSessionId, messageId, prompt, options);

  const response = await fetch(`${origin}${DEEPSEEK.ENDPOINTS.EDIT_MESSAGE}`, {
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

  return response;
}
