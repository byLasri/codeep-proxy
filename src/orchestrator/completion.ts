import type { DeepSeekCompletionInput } from '../deepseek_api/types.js'
import type { CompletionResult } from '../deepseek_api/client.js'
import type { OpenAIChatCompletionRequest } from '../translator/types.js'
import type { RequestLogger } from '../observability/logger.js'
import { translateOpenAIRequest } from '../translator/request.js'
import { translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON, type SSEParseResult } from '../translator/response.js'

export interface CompletionClient {
  completeWithAutoSession(
    input: DeepSeekCompletionInput,
    logger?: RequestLogger
  ): Promise<CompletionResult>;
}

export interface OrchestratorConfig {
  client: CompletionClient;
  timeoutMs: number;
  sendSystemPrompt: boolean;
  logger?: RequestLogger;
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
  sseResult: SSEParseResult;
  sessionUpdatePromise: Promise<void>;
};

export type JsonSuccessResult = {
  kind: 'json-success';
  jsonResult: Awaited<ReturnType<typeof translateDeepSeekStreamToJSON>>;
  sessionUpdatePromise: Promise<void>;
};

export type CompletionAttemptResult =
  | UpstreamErrorResult
  | MissingBodyResult
  | StreamingSuccessResult
  | JsonSuccessResult;

export async function executeCompletionAttempt(
  openaiReq: OpenAIChatCompletionRequest,
  headers: Headers,
  config: OrchestratorConfig
): Promise<CompletionAttemptResult> {
  const { client, timeoutMs, sendSystemPrompt, logger } = config;

  // 1. Call translator-out
  const input = translateOpenAIRequest(openaiReq, headers, sendSystemPrompt, logger);

  // 2. Apply timeout at the orchestration boundary
  const deepSeekInput: DeepSeekCompletionInput = {
    ...input,
    timeout: timeoutMs,
  };

  // 3. Call the DeepSeek API layer
  const { response, sessionUpdatePromise } = await client.completeWithAutoSession(deepSeekInput, logger);

  // 4. Handle upstream HTTP status/body before translator-in
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

  // 5. Call translator-in
  const info = { model: openaiReq.model, id: 'chatcmpl', created: Math.floor(Date.now() / 1000) };

  if (openaiReq.stream === true) {
    const sseResult = await translateDeepSeekStreamToSSE(response.body, info, logger);
    return {
      kind: 'streaming-success',
      sseResult,
      sessionUpdatePromise,
    };
  }

  const jsonResult = await translateDeepSeekStreamToJSON(response.body, info, logger);
  return {
    kind: 'json-success',
    jsonResult,
    sessionUpdatePromise,
  };
}