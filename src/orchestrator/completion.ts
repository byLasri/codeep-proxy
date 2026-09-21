import type { DeepSeekCompletionInput } from '../deepseek_api/types.js'
import type { CompletionResult } from '../deepseek_api/client.js'
import type { OpenAIChatCompletionRequest } from '../translator/types.js'
import type { RequestLogger } from '../observability/logger.js'
import { translateOpenAIRequest } from '../translator/outbound.js'
import { translateParserEventsToSSE, translateParserEventsToJSON, type SSEParseResult } from '../translator/inbound.js'
import { parseDeepSeekSSE } from '../parser/index.js'

export interface CompletionClient {
  completeWithAutoSession(
    input: DeepSeekCompletionInput,
    logger?: RequestLogger
  ): Promise<CompletionResult>;
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

export type RetryResult = {
  kind: 'retry';
  correction: string;
  error: { message: string; syntaxRules: string };
  sessionUpdatePromise: Promise<void>;
};

export type StreamingSuccessResult = {
  kind: 'streaming-success';
  sseResult: SSEParseResult;
  sessionUpdatePromise: Promise<void>;
};

export type JsonSuccessResult = {
  kind: 'json-success';
  jsonResult: Awaited<ReturnType<typeof translateParserEventsToJSON>>;
  sessionUpdatePromise: Promise<void>;
};

export type RetryExhaustedResult = {
  kind: 'retry-exhausted';
  message: string;
};

export type CompletionAttemptResult =
  | UpstreamErrorResult
  | MissingBodyResult
  | RetryResult
  | StreamingSuccessResult
  | JsonSuccessResult;

export type FinalCompletionResult =
  | UpstreamErrorResult
  | MissingBodyResult
  | StreamingSuccessResult
  | JsonSuccessResult
  | RetryExhaustedResult;

export async function executeCompletionAttempt(
  openaiReq: OpenAIChatCompletionRequest,
  headers: Headers,
  config: OrchestratorConfig
): Promise<CompletionAttemptResult> {
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

  // 6. Call translator-in with retry-aware functions
  const info = { model: openaiReq.model, id: 'chatcmpl', created: Math.floor(Date.now() / 1000) };

  if (openaiReq.stream === true) {
    const sseAttemptResult = await translateDeepSeekStreamToSSEAttempt(response.body, info, logger);
    if (sseAttemptResult.kind === 'retry') {
      return {
        kind: 'retry',
        correction: sseAttemptResult.correction,
        error: sseAttemptResult.error,
        sessionUpdatePromise,
      };
    }
    return {
      kind: 'streaming-success',
      sseResult: sseAttemptResult.result,
      sessionUpdatePromise,
    };
  }

  const jsonAttemptResult = await translateDeepSeekStreamToJSONAttempt(response.body, info, logger);
  if (jsonAttemptResult.kind === 'retry') {
    return {
      kind: 'retry',
      correction: jsonAttemptResult.correction,
      error: jsonAttemptResult.error,
      sessionUpdatePromise,
    };
  }

  return {
    kind: 'json-success',
    jsonResult: jsonAttemptResult.result,
    sessionUpdatePromise,
  };
}

export async function executeCompletionWithRetry(
  openaiReq: OpenAIChatCompletionRequest,
  headers: Headers,
  config: OrchestratorConfig
): Promise<FinalCompletionResult> {
  const { timeoutMs, sendSystemPrompt, logger } = config;
  
  const MAX_MALFORMED_RETRIES = 5
  let malformedRetryCount = 0
  let lastMalformedError: { message: string; syntaxRules: string } | null = null
  
  // Work with a copy of messages that we can mutate for retries
  let messages = [...openaiReq.messages]
  
  while (malformedRetryCount <= MAX_MALFORMED_RETRIES) {
    // Retry never sends system prompt - only the initial request uses sendSystemPrompt
    const retrySendSystemPrompt = malformedRetryCount > 0 ? false : sendSystemPrompt
    
    const attemptResult = await executeCompletionAttempt(
      { ...openaiReq, messages },
      headers,
      {
        ...config,
        sendSystemPrompt: retrySendSystemPrompt,
      }
    )

    // Handle upstream errors
    if (attemptResult.kind === 'upstream-error') {
      return attemptResult
    }
    if (attemptResult.kind === 'missing-body') {
      return attemptResult
    }
    
    // Valid success - return immediately
    if (attemptResult.kind === 'streaming-success') {
      return attemptResult
    }
    if (attemptResult.kind === 'json-success') {
      return attemptResult
    }
    
    // Retry case
    if (attemptResult.kind === 'retry') {
      lastMalformedError = attemptResult.error
      malformedRetryCount++
      
      if (malformedRetryCount > MAX_MALFORMED_RETRIES) {
        return {
          kind: 'retry-exhausted',
          message: `Model failed to produce valid DSML after ${MAX_MALFORMED_RETRIES} attempts. Last error: ${lastMalformedError.message}`
        }
      }
      
      // Inject corrective feedback into messages for retry
      messages.push({
        role: 'user',
        content: attemptResult.correction
      })
      
      // Continue loop for retry
      continue
    }
  }
  
  // Should not reach here, but TypeScript needs it
  return {
    kind: 'retry-exhausted',
    message: 'Unexpected state in retry loop'
  }
}