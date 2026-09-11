/**
 * OpenAI-compatible types for Chat Completions API
 */

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAICompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  conversation_id?: string;
}

export interface OpenAICompletionResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChoice[];
}

export interface OpenAIChoice {
  index: number;
  message?: {
    role: string;
    content: string;
  };
  delta?: {
    role?: string;
    content?: string;
  };
  finish_reason?: string | null;
}

/**
 * DeepSeek completion input with all required fields
 */
export interface DeepSeekCompletionInput {
  session: {
    chat_session_id: string;
    parent_message_id: number | null;
  };
  prompt: string;
  model_type: null;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  action: null;
  preempt: boolean;
}

/**
 * Minimal conversation cursor state stored in Durable Object
 */
export interface CompletionSessionState {
  chat_session_id: string;
  parent_message_id: number | null;
  updated_at: number;
}
