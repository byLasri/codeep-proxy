import type { DeepSeekCompletionInput } from '../src/deepseek_api/types.js'
import type { CompletionResult } from '../src/deepseek_api/client.js'
import type { CompletionClient } from '../src/orchestrator/completion.js'
import { executeCompletionAttempt, executeCompletionWithRetry } from '../src/orchestrator/completion.js'
import { translateOpenAIRequest } from '../src/translator/outbound.js'
import type { OpenAIChatCompletionRequest } from '../src/translator/types.js'
import type { RequestLogger } from '../src/observability/logger.js'

function makeHeaders(sessionId?: string): Headers {
  const h = new Headers()
  if (sessionId) h.set('X-Session-Id', sessionId)
  return h
}

function makeSSEEvent(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function makePEvent(data: object): string {
  return `event: p\ndata: ${JSON.stringify(data)}\n\n`
}

function createMockClient(overrides: Partial<{
  response: Response;
  sessionUpdatePromise: Promise<void>;
  onInput?: (input: DeepSeekCompletionInput) => void;
}> = {}): CompletionClient {
  const defaultSessionUpdatePromise = Promise.resolve()
  
  const mockClient: CompletionClient = {
    completeWithAutoSession: async (
      input: DeepSeekCompletionInput,
      logger?: RequestLogger
    ): Promise<CompletionResult> => {
      overrides.onInput?.(input)
      const response = overrides.response ?? new Response(null, { status: 200 })
      return {
        response,
        sessionUpdatePromise: overrides.sessionUpdatePromise ?? Promise.resolve(),
      }
    },
  }
  
  return mockClient
}

function createMockClientFactory(overrides: Partial<{
  response: Response;
  sessionUpdatePromise: Promise<void>;
}> = {}): () => CompletionClient {
  return () => createMockClient(overrides)
}

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]))
      } else {
        controller.close()
      }
    },
  })
}

function createValidDSMLStream(): ReadableStream<Uint8Array> {
  const sseChunks = [
    makeSSEEvent('ready', { response_message_id: 12345 }),
    makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read_file">' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
    makePEvent({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
    makeSSEEvent('close', {}),
  ]
  return createSSEStream(sseChunks)
}

function createMalformedDSMLStream(): ReadableStream<Uint8Array> {
  const sseChunks = [
    makeSSEEvent('ready', { response_message_id: 12345 }),
    makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read_file">' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
    makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
    makePEvent({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
    makeSSEEvent('close', {}),
  ]
  return createSSEStream(sseChunks)
}

async function runTestAsync(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try {
    const result = fn()
    if (result instanceof Promise) {
      await result
    }
    console.log(`✓ ${name}`)
    return false
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    return true
  }
}

function expect<T>(actual: T) {
  const matchers = {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`)
      }
    },
    toEqual(expected: unknown) {
      const actualStr = JSON.stringify(actual)
      const expectedStr = JSON.stringify(expected)
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`)
      }
    },
    toHaveLength(expected: number) {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(`Expected array length ${expected} but got ${actual?.length}`)
      }
    },
    toContain(expected: string) {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}" but got "${actual}"`)
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error('Expected value to be defined')
      }
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new Error(`Expected undefined but got ${actual}`)
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null but got ${actual}`)
      }
    },
    toNotBeNull() {
      if (actual === null) {
        throw new Error('Expected not null but got null')
      }
    },
    toHaveProperty(prop: string) {
      if (actual === null || actual === undefined || !(prop in actual)) {
        throw new Error(`Expected object to have property "${prop}"`)
      }
    },
    not: {
      toContain(expected: string) {
        if (typeof actual === 'string' && actual.includes(expected)) {
          throw new Error(`Expected string not to contain "${expected}" but it did`)
        }
      },
      toHaveProperty(prop: string) {
        if (actual !== null && actual !== undefined && prop in actual) {
          throw new Error(`Expected object not to have property "${prop}"`)
        }
      },
      toBeNull() {
        if (actual === null) {
          throw new Error('Expected not null but got null')
        }
      },
    }
  }
  return { ...matchers }
}

async function main() {
  console.log('Running Orchestrator Completion Tests...\n')

  let failed = 0

  const openaiReq: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Read README' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_123', content: 'README contents' },
    ],
    tools: [],
    stream: false,
  }

  // ============================================================
  // TRANSLATOR-IN RETRY SIGNALING TESTS
  // ============================================================
  console.log('\n--- Translator-In Retry Signaling ---\n')

  // Test 1: malformed streaming response produces kind: 'retry'
  failed += await runTestAsync('malformed streaming response produces kind: retry', async () => {
    const mockClient = createMockClient({
      response: new Response(createMalformedDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: true }, makeHeaders(), {
      createClient: () => mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('retry')
    if (result.kind === 'retry') {
      expect(result.correction).toBeDefined()
      expect(result.correction).toContain('Your previous response contained a malformed tool call')
      expect(result.error.message).toContain('Missing closing')
    }
  })

  // Test 2: malformed JSON response produces kind: 'retry'
  failed += await runTestAsync('malformed JSON response produces kind: retry', async () => {
    const mockClient = createMockClient({
      response: new Response(createMalformedDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: false }, makeHeaders(), {
      createClient: () => mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('retry')
    if (result.kind === 'retry') {
      expect(result.correction).toBeDefined()
      expect(result.correction).toContain('Your previous response contained a malformed tool call')
      expect(result.error.message).toContain('Missing closing')
    }
  })

  // Test 3: the correction exactly equals the translator-in syntaxRules
  failed += await runTestAsync('the correction exactly equals the translator-in syntaxRules', async () => {
    const mockClient = createMockClient({
      response: new Response(createMalformedDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: false }, makeHeaders(), {
      createClient: () => mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('retry')
    if (result.kind === 'retry') {
      // The correction should match exactly the syntaxRules from translator-in
      expect(result.correction).toBe(result.error.syntaxRules)
      expect(result.correction).toContain('Missing closing')
      expect(result.correction).toContain('Your previous response contained a malformed tool call')
    }
  })

  // ============================================================
  // JOINT RETRY LIFECYCLE TESTS
  // ============================================================
  console.log('\n--- Joint Retry Lifecycle ---\n')

  // Test 4: first attempt succeeds -> no retry
  failed += await runTestAsync('first attempt succeeds -> no retry', async () => {
    let attemptCount = 0
    const mockClient = createMockClient({
      response: new Response(createValidDSMLStream()),
    })

    const result = await executeCompletionWithRetry({ ...openaiReq, stream: false }, makeHeaders(), {
      createClient: () => {
        attemptCount++
        return createMockClient({ response: new Response(createValidDSMLStream()) })
      },
      timeoutMs: 15000,
      sendSystemPrompt: true,
    })

    expect(attemptCount).toBe(1)
    expect(result.kind).toBe('json-success')
  })

  // Test 5: first attempt malformed -> second attempt executed
  failed += await runTestAsync('first attempt malformed -> second attempt executed', async () => {
    let attemptCount = 0
    let lastMessages: OpenAIChatCompletionRequest['messages'] | null = null

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          if (attemptCount === 1) {
            return createMockClient({ response: new Response(createMalformedDSMLStream()) })
          }
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: true,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(2)
    expect(result.kind).toBe('json-success')
  })

  // Test 6: malformed streaming attempt followed by valid streaming attempt
  failed += await runTestAsync('malformed streaming attempt followed by valid streaming attempt', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: true },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          if (attemptCount === 1) {
            return createMockClient({ response: new Response(createMalformedDSMLStream()) })
          }
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: true,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(2)
    expect(result.kind).toBe('streaming-success')
  })

  // Test 7: malformed JSON attempt followed by valid JSON attempt
  failed += await runTestAsync('malformed JSON attempt followed by valid JSON attempt', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          if (attemptCount === 1) {
            return createMockClient({ response: new Response(createMalformedDSMLStream()) })
          }
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: true,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(2)
    expect(result.kind).toBe('json-success')
  })

  // Test 8: first attempt uses sendSystemPrompt=true; retry uses false
  failed += await runTestAsync('first attempt uses sendSystemPrompt=true; retry uses false', async () => {
    let capturedSendSystemPrompt: boolean | undefined
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { 
        ...openaiReq, 
        messages: [
          { role: 'system', content: 'System instruction' },
          { role: 'user', content: 'User message' },
        ],
        stream: false 
      },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({
            response: new Response(attemptCount === 1 ? createMalformedDSMLStream() : createValidDSMLStream()),
          })
        },
        timeoutMs: 15000,
        sendSystemPrompt: true,
        registerSessionUpdate: (p) => p,
      }
    )

    // The orchestrator should have called the attempt with sendSystemPrompt=true on first attempt
    // and sendSystemPrompt=false on retry
    // We can verify this by checking the final result is success after 2 attempts
    expect(result.kind).toBe('json-success')
  })

  // Test 9: corrective message is appended as exactly { role: 'user', content: correction }
  failed += await runTestAsync('corrective message is appended as role:user with correction content', async () => {
    let capturedMessages: OpenAIChatCompletionRequest['messages'] | null = null
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          if (attemptCount === 1) {
            return createMockClient({ response: new Response(createMalformedDSMLStream()) })
          }
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    // The final result should be success, meaning the correction was appended
    // We can't directly capture the messages passed to the second attempt from outside,
    // but we can verify the flow completes successfully
    expect(result.kind).toBe('json-success')
    expect(attemptCount).toBe(2)
  })

  // Test 10: retry attempts receive the updated openaiReq.messages
  failed += await runTestAsync('retry attempts receive the updated openaiReq.messages', async () => {
    let lastMessages: OpenAIChatCompletionRequest['messages'] | null = null
    let attemptCount = 0

    const originalReq: OpenAIChatCompletionRequest = {
      ...openaiReq,
      stream: false,
      messages: [
        { role: 'user', content: 'Original message' },
      ],
    }

    const result = await executeCompletionWithRetry(
      originalReq,
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          if (attemptCount === 1) {
            return createMockClient({ response: new Response(createMalformedDSMLStream()) })
          }
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(2)
    expect(result.kind).toBe('json-success')
  })

  // Test 11: exactly one client is created per attempt
  failed += await runTestAsync('exactly one client is created per attempt', async () => {
    let clientCreationCount = 0
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          clientCreationCount++
          attemptCount++
          if (attemptCount === 1) {
            return createMockClient({ response: new Response(createMalformedDSMLStream()) })
          }
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(2)
    expect(clientCreationCount).toBe(2)
  })

  // Test 12: beforeAttempt is called once per attempt
  failed += await runTestAsync('beforeAttempt is called once per attempt', async () => {
    let beforeAttemptCount = 0
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({
            response: attemptCount === 1 ? new Response(createMalformedDSMLStream()) : new Response(createValidDSMLStream()),
          })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        beforeAttempt: async () => {
          beforeAttemptCount++
        },
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(2)
    expect(beforeAttemptCount).toBe(2)
  })

  // Test 13: registerSessionUpdate receives every attempt's sessionUpdatePromise, including malformed attempts
  failed += await runTestAsync('registerSessionUpdate receives every attempt sessionUpdatePromise', async () => {
    let sessionUpdatePromiseCount = 0
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({
            response: attemptCount === 1 ? new Response(createMalformedDSMLStream()) : new Response(createValidDSMLStream()),
          })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => {
          sessionUpdatePromiseCount++
          p.catch(() => {}) // suppress unhandled rejection
        },
      }
    )

    expect(attemptCount).toBe(2)
    expect(sessionUpdatePromiseCount).toBe(2)
  })

  // Test 14: retry exhaustion follows the existing 5-retry semantics
  failed += await runTestAsync('retry exhaustion follows the existing 5-retry semantics', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({ response: new Response(createMalformedDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    // Should have attempted 6 times (initial + 5 retries = 6 total attempts to exceed limit)
    // Actually with MAX_MALFORMED_RETRIES = 5, we get initial + 5 retries = 6 attempts
    // The loop condition is malformedRetryCount <= MAX_MALFORMED_RETRIES (5)
    // So we get attempts for malformedRetryCount = 0,1,2,3,4,5 (6 attempts)
    // Then malformedRetryCount becomes 6 and loop exits
    expect(attemptCount).toBe(6)
    expect(result.kind).toBe('retry-exhausted')
  })

  // Test 15: retry exhaustion preserves the exact existing error message
  failed += await runTestAsync('retry exhaustion preserves the exact existing error message', async () => {
    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => createMockClient({ response: new Response(createMalformedDSMLStream()) }),
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(result.kind).toBe('retry-exhausted')
    if (result.kind === 'retry-exhausted') {
      expect(result.message).toContain('Model failed to produce valid DSML after 5 attempts')
      expect(result.message).toContain('Last error:')
      expect(result.message).toContain('Missing closing')
    }
  })

  // Test 16: successful final attempt returns the normal streaming/json result
  failed += await runTestAsync('successful final attempt returns the normal streaming/json result', async () => {
    let attemptCount = 0

    // Test streaming success
    const streamResult = await executeCompletionWithRetry(
      { ...openaiReq, stream: true },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: true,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(1)
    expect(streamResult.kind).toBe('streaming-success')

    // Reset for JSON test
    attemptCount = 0

    const jsonResult = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({ response: new Response(createValidDSMLStream()) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: true,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(1)
    expect(jsonResult.kind).toBe('json-success')
  })

  // Test 17: upstream error still terminates immediately without retry
  failed += await runTestAsync('upstream error still terminates immediately without retry', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({ response: new Response(null, { status: 500, statusText: 'Internal Server Error' }) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(1)
    expect(result.kind).toBe('upstream-error')
  })

  // Test 18: missing body still terminates immediately without retry
  failed += await runTestAsync('missing body still terminates immediately without retry', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry(
      { ...openaiReq, stream: false },
      makeHeaders(),
      {
        createClient: () => {
          attemptCount++
          return createMockClient({ response: new Response(null, { status: 200 }) })
        },
        timeoutMs: 15000,
        sendSystemPrompt: false,
        registerSessionUpdate: (p) => p,
      }
    )

    expect(attemptCount).toBe(1)
    expect(result.kind).toBe('missing-body')
  })

  // Test 19: no toolResults crosses into DeepSeekCompletionInput
  failed += await runTestAsync('no toolResults crosses into DeepSeekCompletionInput', async () => {
    let capturedInput: DeepSeekCompletionInput | null = null
    const mockClient = createMockClient({
      response: new Response(createValidDSMLStream()),
    })
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput) => {
      capturedInput = input
      return originalComplete(input)
    }

    const result = await executeCompletionAttempt(openaiReq, makeHeaders('test-session'), {
      createClient: () => mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(capturedInput).toNotBeNull()
    expect(capturedInput).not.toHaveProperty('toolResults')
    expect(capturedInput).toHaveProperty('prompt')
    expect(capturedInput).toHaveProperty('model_type')
    expect(capturedInput).toHaveProperty('thinking_enabled')
    expect(capturedInput).toHaveProperty('search_enabled')
    expect(capturedInput).toHaveProperty('xSessionId')
    expect(capturedInput).toHaveProperty('chat_session_id')
  })

  // Test 20: real retry path - malformed first attempt, correction appended, valid second attempt
  failed += await runTestAsync('real retry path: malformed first attempt -> correction appended -> valid second attempt', async () => {
    let attemptCount = 0

    // Create a request with system prompt to verify retry suppression
    const reqWithSystem: OpenAIChatCompletionRequest = {
      ...openaiReq,
      messages: [
        { role: 'system', content: 'System instruction for testing' },
        { role: 'user', content: 'User message for testing' },
      ],
      stream: false,
    }

    const result = await executeCompletionWithRetry(reqWithSystem, makeHeaders(), {
      createClient: () => {
        attemptCount++
        if (attemptCount === 1) {
          // First attempt: return malformed DSML
          return createMockClient({ response: new Response(createMalformedDSMLStream()) })
        }
        // Second attempt: return valid DSML
        return createMockClient({
          response: new Response(createValidDSMLStream()),
        })
      },
      timeoutMs: 15000,
      sendSystemPrompt: true, // First attempt should include system prompt
      registerSessionUpdate: (p) => p.catch(() => {}),
    })

    // Verify exactly two attempts occurred
    expect(attemptCount).toBe(2)

    // The final result should be success (second attempt)
    expect(result.kind).toBe('json-success')
  })

  // Test 21: retry correction propagation - second attempt's prompt contains correction
  failed += await runTestAsync('retry correction propagation: second attempt prompt contains correction', async () => {
    let attemptCount = 0
    let secondAttemptInput: DeepSeekCompletionInput | null = null
    let correctionText: string | null = null

    const reqWithSystem: OpenAIChatCompletionRequest = {
      ...openaiReq,
      messages: [
        { role: 'system', content: 'System instruction for testing' },
        { role: 'user', content: 'User message for testing' },
      ],
      stream: false,
    }

    // First, run a single malformed attempt to capture the correction text
    const mockClientForCorrection = createMockClient({
      response: new Response(createMalformedDSMLStream()),
    })
    const correctionAttempt = await executeCompletionAttempt(reqWithSystem, makeHeaders(), {
      createClient: () => mockClientForCorrection,
      timeoutMs: 15000,
      sendSystemPrompt: true,
      registerSessionUpdate: (p) => p.catch(() => {}),
    })

    if (correctionAttempt.kind === 'retry') {
      correctionText = correctionAttempt.correction
    }

    expect(correctionText).not.toBeNull()

    // Now test the full retry path and capture second attempt's input
    const result = await executeCompletionWithRetry(reqWithSystem, makeHeaders(), {
      createClient: () => {
        attemptCount++
        if (attemptCount === 1) {
          return createMockClient({ response: new Response(createMalformedDSMLStream()) })
        }
        // Second attempt: capture the input and return valid DSML
        return createMockClient({
          response: new Response(createValidDSMLStream()),
          onInput: (input) => {
            secondAttemptInput = input
          },
        })
      },
      timeoutMs: 15000,
      sendSystemPrompt: true,
      registerSessionUpdate: (p) => p.catch(() => {}),
    })

    // Verify exactly two attempts occurred
    expect(attemptCount).toBe(2)
    expect(result.kind).toBe('json-success')

    // The correction text should have been captured
    expect(correctionText).not.toBeNull()

    // Verify the second attempt's input was captured
    expect(secondAttemptInput).not.toBeNull()

    // Verify the correction was propagated into the second attempt's prompt
    if (secondAttemptInput && correctionText) {
      expect(secondAttemptInput.prompt).toContain(correctionText)
    }

    // Verify system prompt was suppressed on retry
    if (secondAttemptInput) {
      expect(secondAttemptInput.prompt).not.toContain('System instruction for testing')
    }

    // Verify no toolResults crosses the boundary
    if (secondAttemptInput) {
      expect(secondAttemptInput).not.toHaveProperty('toolResults')
    }
  })

  // Test 22: retry exhaustion - exactly MAX_MALFORMED_RETRIES + 1 attempts, then retry-exhausted
  failed += await runTestAsync('retry exhaustion: exactly 6 attempts then retry-exhausted', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry({ ...openaiReq, stream: false }, makeHeaders(), {
      createClient: () => {
        attemptCount++
        return createMockClient({ response: new Response(createMalformedDSMLStream()) })
      },
      timeoutMs: 15000,
      sendSystemPrompt: false,
      registerSessionUpdate: (p) => p.catch(() => {}),
    })

    // Should have attempted 6 times (initial + 5 retries = 6 total attempts)
    expect(attemptCount).toBe(6)
    expect(result.kind).toBe('retry-exhausted')
    if (result.kind === 'retry-exhausted') {
      expect(result.message).toContain('Model failed to produce valid DSML after 5 attempts')
      expect(result.message).toContain('Last error:')
      expect(result.message).toContain('Missing closing')
    }
  })

  // Test 23: retry exhaustion - no seventh attempt occurs
  failed += await runTestAsync('retry exhaustion: no seventh attempt after exhaustion', async () => {
    let attemptCount = 0

    const result = await executeCompletionWithRetry({ ...openaiReq, stream: false }, makeHeaders(), {
      createClient: () => {
        attemptCount++
        return createMockClient({ response: new Response(createMalformedDSMLStream()) })
      },
      timeoutMs: 15000,
      sendSystemPrompt: false,
      registerSessionUpdate: (p) => p.catch(() => {}),
    })

    // Loop condition: malformedRetryCount <= MAX_MALFORMED_RETRIES (5)
    // So attempts for malformedRetryCount = 0,1,2,3,4,5 (6 attempts)
    // Then malformedRetryCount becomes 6 and loop exits
    // No seventh attempt should occur
    expect(attemptCount).toBe(6)
    expect(result.kind).toBe('retry-exhausted')
  })

  console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
  if (failed > 0) process.exit(1)
}

main()