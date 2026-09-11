// DeepSeek Web Protocol Completion Request Builder
// Builds the exact DeepSeek wire request

import type {
  DeepSeekConversationState,
  DeepSeekCompletionRequest,
  DeepSeekModelType,
} from "./types.js";

export function buildCompletionRequest(
  state: DeepSeekConversationState,
  prompt: string,
  options: {
    model_type: DeepSeekModelType;  // required - no fallback
    thinking_enabled: boolean;
    search_enabled: boolean;
    ref_file_ids: string[];
    action: unknown | null;
    preempt: boolean;
  },
): DeepSeekCompletionRequest {
  return {
    chat_session_id: state.chat_session_id,
    parent_message_id: state.parent_message_id,
    model_type: options.model_type,
    prompt,
    ref_file_ids: options.ref_file_ids,
    thinking_enabled: options.thinking_enabled,
    search_enabled: options.search_enabled,
    action: options.action,
    preempt: options.preempt,
  };
}