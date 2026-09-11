/**
 * OpenAI-compatible completion layer for DeepSeek
 */

export { CompletionService } from './service.js'
export { validateCompletionRequest, extractLatestUserPrompt, translateToDeepSeekInput } from './request.js'
export { 
  parseDeepSeekEvents, 
  normalizeDeepSeekEvents, 
  extractResponseMessageId,
  extractFinalContent,
  extractReasoningContent,
} from './sse.js'
export type {
  RawSSEFrame,
  DeepSeekSSEEvent,
  ReadyEventData,
  UpdateSessionEventData,
  TitleEventData,
  CloseEventData,
  DeepSeekPatch,
  DataEventWithPatches,
  TypedDeepSeekEvent,
  ReconstructedResponse,
  NormalizedCompletionEvent,
} from './sse.js'
export type {
  OpenAIMessage,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
  OpenAIChoice,
  DeepSeekCompletionInput,
} from './types.js'