import { OpenAICompletionRequest, OpenAIMessage, DeepSeekCompletionInput } from './types.js';

/**
 * Validate OpenAI-compatible completion request
 */
export function validateCompletionRequest(
  body: unknown
): OpenAICompletionRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a non-null object');
  }

  const req = body as Record<string, unknown>;

  // Validate model
  if (typeof req.model !== 'string') {
    throw new Error('model must be a string');
  }

  // Validate messages
  if (!Array.isArray(req.messages)) {
    throw new Error('messages must be an array');
  }

  if (req.messages.length === 0) {
    throw new Error('messages array must contain at least one message');
  }

  const messages: OpenAIMessage[] = [];
  let hasUserMessage = false;

  for (const msg of req.messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      throw new Error('Each message must be an object');
    }

    const m = msg as Record<string, unknown>;

    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') {
      throw new Error('message role must be "system", "user", or "assistant"');
    }

    if (typeof m.content !== 'string') {
      throw new Error('message content must be a string');
    }

    messages.push({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    });

    if (m.role === 'user') {
      hasUserMessage = true;
    }
  }

  if (!hasUserMessage) {
    throw new Error('At least one user message is required');
  }

  // Validate stream (optional)
  if (req.stream !== undefined && typeof req.stream !== 'boolean') {
    throw new Error('stream must be a boolean');
  }

  // Validate conversation_id (required for our API)
  if (typeof req.conversation_id !== 'string' || !req.conversation_id) {
    throw new Error('conversation_id is required and must be a non-empty string');
  }

  return {
    model: req.model,
    messages,
    stream: req.stream ?? true,
    conversation_id: req.conversation_id,
  };
}

/**
 * Extract the latest user message as the DeepSeek prompt
 */
export function extractLatestUserPrompt(messages: OpenAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  throw new Error('No user message found');
}

/**
 * Translate to DeepSeek completion input with all required fields
 */
export function translateToDeepSeekInput(
  chat_session_id: string,
  parent_message_id: number | null,
  prompt: string
): DeepSeekCompletionInput {
  return {
    session: {
      chat_session_id,
      parent_message_id,
    },
    prompt,
    model_type: null,
    ref_file_ids: [],
    thinking_enabled: false,
    search_enabled: false,
    action: null,
    preempt: false,
  };
}
