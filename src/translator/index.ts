export type {
  OpenAIChatMessage,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionStreamChoice,
  OpenAIChatCompletionStreamResponse,
} from './types.js'

export type { SSEParseResult, DSMLParseResult, TranslationAttemptResult } from './inbound.js'

export { mapOpenAIModelToDeepSeek } from './models.js'
export { getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt, translateOpenAIRequest } from './outbound.js'
export type { RequestLogger } from '../observability/logger.js'
export {
  formatOpenAISSEChunk,
  formatOpenAIDone,
  translateDeepSeekStreamToSSE,
  translateDeepSeekStreamToJSON,
  translateDeepSeekStreamToSSEAttempt,
  translateDeepSeekStreamToJSONAttempt,
  buildCorrectiveMessage,
} from './inbound.js'
