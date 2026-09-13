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

// Client types (includes StoredDeepSeekCredentials)
export type { StoredDeepSeekCredentials } from "./client.js";

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

// State Store (platform-independent abstraction)
export { PROTOCOL_STATE_KEYS } from "./state-store.js";
export type { ProtocolStateStore } from "./state-store.js";

// Session Store (platform-independent abstraction)
export type { ProtocolSessionStore } from "./session-store.js";

// PoW
export { solvePow, encodePowResponse } from "./pow.js";
export { createPowChallenge } from "./pow-challenge.js";

// Session
export { createSession } from "./session.js";

// Completion
export { buildCompletionRequest } from "./completion.js";

// Client
export { DeepSeekWebClient, createDefaultCredentialsReader } from "./client.js";
export type { DeepSeekWebClientConfig, CompletionResult } from "./client.js";