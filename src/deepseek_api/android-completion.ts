// DeepSeek Android Protocol Completion Request Builder
// Builds the exact Android completion JSON body.
//
// Captured Android 2.5.3 body:
//   {
//     "chat_session_id": "...",
//     "parent_message_id": null,
//     "prompt": "...",
//     "ref_file_ids": [],
//     "thinking_enabled": true,
//     "search_enabled": true,
//     "audio_id": null,
//     "preempt": false,
//     "model_type": "default",
//     "action": null
//   }
//
// Property insertion order matches the capture so the serialized JSON can be
// compared field-for-field against the reference.

import type {
  DeepSeekConversationState,
  DeepSeekModelType,
} from "./types.js";

export interface AndroidCompletionRequest {
  chat_session_id: string;
  parent_message_id: number | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  audio_id: null;
  preempt: boolean;
  model_type: DeepSeekModelType;
  action: unknown | null;
}

/**
 * Builds the Android completion request body.
 *
 * Fixed protocol constants:
 *   ref_file_ids: []
 *   audio_id: null
 *   preempt: false
 *   action: null
 *
 * parent_message_id comes from validated session state (null on first turn).
 */
export function buildAndroidCompletionRequest(
  state: DeepSeekConversationState,
  prompt: string,
  options: {
    model_type: DeepSeekModelType;
    thinking_enabled: boolean;
    search_enabled: boolean;
  }
): AndroidCompletionRequest {
  return {
    chat_session_id: state.chat_session_id,
    parent_message_id: state.parent_message_id,
    prompt,
    ref_file_ids: [],
    thinking_enabled: options.thinking_enabled,
    search_enabled: options.search_enabled,
    audio_id: null,
    preempt: false,
    model_type: options.model_type,
    action: null,
  };
}
