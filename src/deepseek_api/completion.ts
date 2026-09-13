// DeepSeek Web Protocol Completion Request Builder
// Builds the exact DeepSeek wire request
// FIXED VALUES (protocol constants - never override):
//   action: null
//   preempt: false
//   ref_file_ids: []

import type {
  DeepSeekConversationState,
  DeepSeekCompletionRequest,
  DeepSeekModelType,
} from "./types.js";

/**
 * Builds completion request with strict protocol constants.
 * - action: ALWAYS null (fixed)
 * - preempt: ALWAYS false (fixed)
 * - ref_file_ids: ALWAYS [] (fixed)
 * - parent_message_id: from validated state (null for first turn, D1 value for continuation)
 */
export function buildCompletionRequest(
  state: DeepSeekConversationState,
  prompt: string,
  options: {
    model_type: DeepSeekModelType;  // required - no fallback
    thinking_enabled: boolean;
    search_enabled: boolean;
  },
): DeepSeekCompletionRequest {
  // Enforce fixed protocol constants
  const FIXED_ACTION = null;
  const FIXED_PREEMPT = false;
  const FIXED_REF_FILE_IDS: string[] = [];

  // parent_message_id MUST come from state (validated D1 value or null for first turn)
  // deepseek_api never generates it - always from worker/D1 validation
  const parentMessageId = state.parent_message_id;

  return {
    chat_session_id: state.chat_session_id,
    parent_message_id: parentMessageId,
    model_type: options.model_type,
    prompt,
    ref_file_ids: FIXED_REF_FILE_IDS,
    thinking_enabled: options.thinking_enabled,
    search_enabled: options.search_enabled,
    action: FIXED_ACTION,
    preempt: FIXED_PREEMPT,
  };
}