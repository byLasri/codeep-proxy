// DeepSeek Web Protocol Module
// Public API exports

// Types
export type {
  DeepSeekModelType,
  DeepSeekCompletionRequest,
  DeepSeekSession,
  DeepSeekConversationState,
  DeepSeekPowChallenge,
  DeepSeekPowSolution,
  DeepSeekClientHeaders,
  DeepSeekApiResponse,
  DeepSeekCompletionInput,
  DeepSeekCredentials,
} from "./types.js";

// Constants
export { DEEPSEEK, DEFAULT_TIMEZONE_OFFSET } from "./constants.js";

// Errors
export { DeepSeekProtocolError, type DeepSeekErrorKind, toDeepSeekError } from "./errors.js";

// Headers
export {
  buildClientHeaders,
  getDeepSeekTimezoneOffset,
  buildAuthenticationHeaders,
  buildCompletionHeaders,
  buildHeaders,
  type HeaderBuildOptions,
} from "./headers.js";

// HIF-LEIM
export {
  fetchHifLeim,
  buildHifLeimHeaders,
  HifLeimCache,
  type HifLeimValue,
  type HifLeimResponse,
} from "./hif-leim.js";

export { StateManager } from "./state-manager.js";

// PoW
export { solvePow, encodePowResponse } from "./pow.js";
export { createPowChallenge } from "./pow-challenge.js";

// Session
export { createSession } from "./session.js";

// Completion
export { buildCompletionRequest } from "./completion.js";

// Client
export { DeepSeekWebClient, createConversationState } from "./client.js";
export type { DeepSeekWebClientConfig, CredentialsProvider } from "./client.js";