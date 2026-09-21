import type { DeepSeekCompletionInput } from '../deepseek_api/types.js'
import type { CompletionResult as DeepSeekCompletionResult } from '../deepseek_api/client.js'
import type { OpenAIChatCompletionRequest } from '../translator/types.js'
import type { RequestLogger } from '../observability/logger.js'
import { translateOpenAIRequest } from '../translator/outbound.js'
import { translateParserEventsToSSE, translateParserEventsToJSON } from '../translator/inbound.js'
import { parseDeepSeekSSE } from '../parser/index.js'

export interface CompletionClient {
  completeWithAutoSession(
    input: DeepSeekCompletionInput,
    logger?: RequestLogger
  ): Promise<DeepSeekCompletionResult>;
}

export interface OrchestratorConfig {
  createClient: () => CompletionClient;
  timeoutMs: number;
  sendSystemPrompt: boolean;
  logger?: RequestLogger;
  beforeAttempt?: () => Promise<void>;
  registerSessionUpdate?: (promise: Promise<void>) => void;
}

export type UpstreamErrorResult = {
  kind: 'upstream-error';
  status: number;
  statusText: string;
  sessionUpdatePromise: Promise<void>;
};

export type MissingBodyResult = {
  kind: 'missing-body';
  sessionUpdatePromise: Promise<void>;
};

export type StreamingSuccessResult = {
  kind: 'streaming-success';
  stream: ReadableStream<Uint8Array>;
  sessionUpdatePromise: Promise<void>;
};

export type JsonSuccessResult = {
  kind: 'json-success';
  jsonResult: Awaited<ReturnType<typeof translateParserEventsToJSON>>;
  sessionUpdatePromise: Promise<void>;
};

export type OrchestratorCompletionResult =
  | UpstreamErrorResult
  | MissingBodyResult
  | StreamingSuccessResult
  | JsonSuccessResult;

export async function executeCompletion(
  openaiReq: OpenAIChatCompletionRequest,
  headers: Headers,
  config: OrchestratorConfig
): Promise<OrchestratorCompletionResult> {
  const { createClient, timeoutMs, sendSystemPrompt, logger, beforeAttempt, registerSessionUpdate } = config;

  // Call beforeAttempt callback if provided
  if (beforeAttempt) {
    await beforeAttempt();
  }

  // 1. Create client for this attempt
  const client = createClient();

  // 2. Call translator-out
  const input = translateOpenAIRequest(openaiReq, headers, sendSystemPrompt, logger);

  // 3. Apply timeout at the orchestration boundary
  const deepSeekInput: DeepSeekCompletionInput = {
    ...input,
    timeout: timeoutMs,
  };

  // 4. Call the DeepSeek API layer
  const { response, sessionUpdatePromise } = await client.completeWithAutoSession(deepSeekInput, logger);

  // Register session update promise
  registerSessionUpdate?.(sessionUpdatePromise);

  // 5. Handle upstream HTTP status/body before translator-in
  if (!response.ok) {
    return {
      kind: 'upstream-error',
      status: response.status,
      statusText: response.statusText,
      sessionUpdatePromise,
    };
  }

  if (!response.body) {
    return {
      kind: 'missing-body',
      sessionUpdatePromise,
    };
  }

  // 6. Call translator-in
  const info = { model: openaiReq.model, id: 'chatcmpl', created: Math.floor(Date.now() / 1000) };

  if (openaiReq.stream === true) {
    const stream = await translateParserEventsToSSE(parseDeepSeekSSE(response.body), info, logger);
    return {
      kind: 'streaming-success',
      stream,
      sessionUpdatePromise,
    };
  }

  const jsonResult = await translateParserEventsToJSON(parseDeepSeekSSE(response.body), info, logger);

  return {
    kind: 'json-success',
    jsonResult,
    sessionUpdatePromise,
  };
}