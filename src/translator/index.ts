// Translator module: OpenAI <-> DeepSeek protocol translation
// Re-export the translation functions for use in src/index.ts

export { translateOpenAIRequest, getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt } from './request.js';
export { translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON, formatOpenAISSEChunk, formatOpenAIDone } from './response.js';
export { mapOpenAIModelToDeepSeek } from './models.js';

// Re-export the OpenAI types for convenience if needed elsewhere
export type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionStreamResponse,
  OpenAIChatMessage,
} from './types.js';

// Note: SSEParserState is internal to response.ts and not exported.