export type {
  OpenAIChatMessage,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionStreamChoice,
  OpenAIChatCompletionStreamResponse,
} from './types.js'

export type { SSEParseResult } from './response.js'

export { mapOpenAIModelToDeepSeek } from './models.js'
export { getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt, translateOpenAIRequest } from './request.js'
export type { RequestLogger } from '../observability/logger.js'
export {
  formatOpenAISSEChunk,
  formatOpenAIDone,
  translateDeepSeekStreamToSSE,
  translateDeepSeekStreamToJSON,
  ACTIVE_CORRECTIVE_MESSAGE,
} from './response.js'
export { parseCleanToolCalls } from './clean-tool-calls.js'
