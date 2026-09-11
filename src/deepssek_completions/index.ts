/**
 * OpenAI-compatible completion layer for DeepSeek
 */

export { CompletionService } from './service.js'
export { validateCompletionRequest, extractLatestUserPrompt, translateToDeepSeekInput } from './request.js'
export { parseSSEEvents, extractResponseMessageId, extractContentDeltas } from './sse.js'
export type {
  OpenAIMessage,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
  OpenAIChoice,
  DeepSeekCompletionInput,
} from './types.js'