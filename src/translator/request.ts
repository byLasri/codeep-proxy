// Translate OpenAI chat completion request to DeepSeekCompletionInput.
// This file contains the implementation of the translation functions.

import type { DeepSeekCompletionInput, DeepSeekModelType } from '../deepseek_api/types.js';
import { OpenAIChatCompletionRequest, OpenAIChatMessage } from './types.js';
import { mapOpenAIModelToDeepSeek } from './models.js';

/**
 * Extracts the X-Session-Id from headers (case-insensitive, trimmed, max 128 chars).
 * If absent, falls back to X-Session-Affinity (same rules).
 * Returns undefined if missing, empty, or too long.
 */
export function getXSessionIdFromHeaders(headers: Headers): string | undefined {
  // Try X-Session-Id first (case-insensitive)
  const sessionIdHeader = headers.get('X-Session-Id') ?? headers.get('x-session-id');
  if (sessionIdHeader !== null) {
    const trimmed = sessionIdHeader.trim();
    if (trimmed.length > 0 && trimmed.length <= 128) {
      return trimmed;
    }
    // If empty, too long, or only whitespace, treat as absent and fall back
  }
  // Fall back to X-Session-Affinity
  const affinityHeader = headers.get('X-Session-Affinity') ?? headers.get('x-session-affinity');
  if (affinityHeader !== null) {
    const trimmed = affinityHeader.trim();
    if (trimmed.length > 0 && trimmed.length <= 128) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Determines if this is the first turn: no message with role === "assistant".
 */
export function isFirstTurn(messages: OpenAIChatMessage[]): boolean {
  return !messages.some(msg => msg.role === 'assistant');
}

/**
 * Build the prompt for DeepSeek completion based on OpenAI messages.
 * For first turn: [
 *     system.content (if present),
 *     JSON.stringify(tools) (if present),
 *     latest user.content
 *   ].join("\n\n")
 * For continuation: latest user message content only.
 * Throws if no user message found.
 */
export function buildDeepSeekPrompt(messages: OpenAIChatMessage[], tools?: any[]): string {
  // Find the latest user message (last one with role 'user')
  const latestUserMsg = messages.slice().reverse().find(msg => msg.role === 'user');
  if (!latestUserMsg || latestUserMsg.content === null) {
    // According to spec, throw a 400 error. However, we are in a translator function.
    // We'll throw an error that the caller can catch and turn into a 400 response.
    throw new Error('No user message found');
  }

  if (isFirstTurn(messages)) {
    const parts: string[] = [];

    // System content: concatenate all system messages? The spec says system.content (if present).
    // We'll take the first system message's content, or concatenate? Let's assume we take the first.
    // But note: there could be multiple system messages. The spec doesn't specify.
    // We'll follow the common practice: concatenate all system messages with '\n\n'.
    // However, the spec says: system.content (if present). We'll interpret as the content of the system message(s).
    // Let's collect all system message contents and join them with '\n\n'.
    const systemContents = messages
      .filter(msg => msg.role === 'system')
      .map(msg => msg.content)
      .filter((content): content is string => content !== null);
    if (systemContents.length > 0) {
      parts.push(systemContents.join('\n\n'));
    }

    // Tools: if present, JSON.stringify(tools)
    if (tools && tools.length > 0) {
      parts.push(JSON.stringify(tools));
    }

    // Latest user content
    parts.push(latestUserMsg.content);

    return parts.join('\n\n');
  } else {
    // Continuation: latest user message content only.
    return latestUserMsg.content;
  }
}

/**
 * Translate an OpenAI chat completion request and headers to DeepSeekCompletionInput.
 * @param openaiRequest The validated OpenAI request object.
 * @param headers HTTP headers (to extract X-Session-Id).
 * @returns DeepSeekCompletionInput to be passed to deepseek_api.completeWithAutoSession.
 */
export function translateOpenAIRequest(
  openaiRequest: OpenAIChatCompletionRequest,
  headers: Headers
): DeepSeekCompletionInput {
  const xSessionId = getXSessionIdFromHeaders(headers);
  const tools = 'tools' in openaiRequest && Array.isArray(openaiRequest.tools) ? openaiRequest.tools : undefined;
  const prompt = buildDeepSeekPrompt(openaiRequest.messages, tools);
  return {
    chat_session_id: undefined, // To be set by the caller? No, the deepseek_api expects chat_session_id from body or mapping.
    // We are not setting chat_session_id here because it comes from the body or mapping via xSessionId.
    // The deepseek_api.completeWithAutoSession will use the xSessionId to map to a chat_session_id.
    // So we leave chat_session_id undefined and set xSessionId.
    prompt,
    model_type: mapOpenAIModelToDeepSeek(openaiRequest.model),
    thinking_enabled: false, // defaults for now
    search_enabled: false,   // defaults for now
    xSessionId,
  };
}