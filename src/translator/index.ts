export type {
  OpenAIChatMessage,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionStreamChoice,
  OpenAIChatCompletionStreamResponse,
} from './types.js'

export { mapOpenAIModelToDeepSeek } from './models.js'
export { getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt, translateOpenAIRequest } from './request.js'
export {
  formatOpenAISSEChunk,
  formatOpenAIDone,
  translateDeepSeekStreamToSSE,
  translateDeepSeekStreamToJSON,
} from './response.js'
