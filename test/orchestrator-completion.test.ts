import type { DeepSeekCompletionInput } from '../src/deepseek_api/types.js'
import type { CompletionResult } from '../src/deepseek_api/client.js'
import type { CompletionClient } from '../src/orchestrator/completion.js'
import { executeCompletionAttempt } from '../src/orchestrator/completion.js'
import { translateOpenAIRequest } from '../src/translator/request.js'
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
}> = {}): CompletionClient {
  const defaultSessionUpdatePromise = Promise.resolve()
  
  const mockClient: CompletionClient = {
    completeWithAutoSession: async (
      input: DeepSeekCompletionInput,
      logger?: RequestLogger
    ): Promise<CompletionResult> => {
      const response = overrides.response ?? new Response(null, { status: 200 })
      return {
        response,
        sessionUpdatePromise: overrides.sessionUpdatePromise ?? defaultSessionUpdatePromise,
      }
    },
  }
  
  return mockClient
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

  // Test 1: translator-out input reaches mocked DeepSeek client correctly
  failed += await runTestAsync('translator-out input reaches mocked DeepSeek client correctly', async () => {
    let capturedInput: DeepSeekCompletionInput | null = null
    const mockClient = createMockClient({
      response: new Response(createValidDSMLStream().getReader().read(), { status: 200 }),
    })
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput) => {
      capturedInput = input
      return originalComplete(input)
    }

    const result = await executeCompletionAttempt(openaiReq, makeHeaders('test-session'), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(capturedInput).toNotBeNull()
    expect(capturedInput!.prompt).toBe('README contents')
    expect(capturedInput!.model_type).toBeDefined()
    expect(capturedInput!.thinking_enabled).toBeDefined()
    expect(capturedInput!.search_enabled).toBeDefined()
    expect(capturedInput!.xSessionId).toBe('test-session')
  })

  // Test 2: sendSystemPrompt=true includes system prompt in generated prompt
  failed += await runTestAsync('sendSystemPrompt=true includes system prompt in generated prompt', async () => {
    let capturedInput: DeepSeekCompletionInput | null = null
    const mockClient = createMockClient()
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput) => {
      capturedInput = input
      return originalComplete(input)
    }

    const reqWithSystem: OpenAIChatCompletionRequest = {
      ...openaiReq,
      messages: [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'User message' },
      ],
    }

    const result = await executeCompletionAttempt(reqWithSystem, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: true,
    })

    expect(capturedInput).toNotBeNull()
    expect(capturedInput!.prompt).toContain('System instruction')
    expect(capturedInput!.prompt).toContain('User message')
    const sysIdx = capturedInput!.prompt.indexOf('System instruction')
    const userIdx = capturedInput!.prompt.indexOf('User message')
    if (!(sysIdx < userIdx)) {
      throw new Error('System should come before user')
    }
  })

  // Test 3: sendSystemPrompt=false excludes system prompt
  failed += await runTestAsync('sendSystemPrompt=false excludes system prompt', async () => {
    let capturedInput: DeepSeekCompletionInput | null = null
    const mockClient = createMockClient()
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput) => {
      capturedInput = input
      return originalComplete(input)
    }

    const reqWithSystem: OpenAIChatCompletionRequest = {
      ...openaiReq,
      messages: [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'User message' },
      ],
    }

    const result = await executeCompletionAttempt(reqWithSystem, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(capturedInput).toNotBeNull()
    expect(capturedInput!.prompt).not.toContain('System instruction')
    expect(capturedInput!.prompt).toBe('User message')
  })

  // Test 4: timeout reaches DeepSeekCompletionInput
  failed += await runTestAsync('timeout reaches DeepSeekCompletionInput', async () => {
    let capturedTimeout: number | undefined
    const mockClient = createMockClient()
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput) => {
      capturedTimeout = input.timeout
      return originalComplete(input)
    }

    const customTimeout = 30000
    const result = await executeCompletionAttempt(openaiReq, makeHeaders(), {
      client: mockClient,
      timeoutMs: customTimeout,
      sendSystemPrompt: false,
    })

    expect(capturedTimeout).toBe(customTimeout)
  })

  // Test 5: logger is passed through to client
  failed += await runTestAsync('logger is passed through to deepseek_api', async () => {
    let clientLogger: RequestLogger | undefined
    
    const mockClient = createMockClient()
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput, logger?: RequestLogger) => {
      clientLogger = logger
      return originalComplete(input, logger)
    }

    const testLogger = {
      logIncoming: () => {},
      logTranslatedRequest: () => {},
      logUpstreamRequest: () => {},
      logUpstreamResponse: () => {},
      logOutgoingToClient: () => {},
      logError: () => {},
    } as RequestLogger

    const result = await executeCompletionAttempt(openaiReq, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
      logger: testLogger,
    })

    expect(clientLogger).toBe(testLogger)
    expect(result).toBeDefined()
  })

  // Test 6: successful streaming response passed through translator-in
  failed += await runTestAsync('successful streaming response passed through translator-in', async () => {
    const mockClient = createMockClient({
      response: new Response(createValidDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: true }, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('streaming-success')
    if (result.kind === 'streaming-success') {
      expect(result.sseResult).toBeDefined()
      expect(result.sseResult.parseError).toBeNull()
      expect(result.sseResult.stream).toBeDefined()
    }
  })

  // Test 7: successful JSON response passed through translator-in
  failed += await runTestAsync('successful JSON response passed through translator-in', async () => {
    const mockClient = createMockClient({
      response: new Response(createValidDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: false }, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('json-success')
    if (result.kind === 'json-success') {
      expect(result.jsonResult).toBeDefined()
      expect(result.jsonResult.choices).toBeDefined()
      expect(result.jsonResult.choices[0].message.tool_calls).toBeDefined()
      expect(result.jsonResult._malformedError).toBeUndefined()
    }
  })

  // Test 8: malformed streaming parser result preserved unchanged
  failed += await runTestAsync('malformed streaming parser result preserved unchanged', async () => {
    const mockClient = createMockClient({
      response: new Response(createMalformedDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: true }, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('streaming-success')
    if (result.kind === 'streaming-success') {
      expect(result.sseResult.parseError).toBeDefined()
      expect(result.sseResult.parseError!.message).toContain('Missing closing')
      expect(result.sseResult.parseError!.syntaxRules).toContain('Your previous response contained a malformed tool call')
    }
  })

  // Test 9: malformed JSON parser result preserved unchanged
  failed += await runTestAsync('malformed JSON parser result preserved unchanged', async () => {
    const mockClient = createMockClient({
      response: new Response(createMalformedDSMLStream()),
    })

    const result = await executeCompletionAttempt({ ...openaiReq, stream: false }, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('json-success')
    if (result.kind === 'json-success') {
      expect(result.jsonResult._malformedError).toBeDefined()
      expect(result.jsonResult._malformedError!.message).toContain('Missing closing')
      expect(result.jsonResult._malformedError!.syntaxRules).toContain('Your previous response contained a malformed tool call')
    }
  })

  // Test 10: unsuccessful upstream response returned as upstream-error result
  failed += await runTestAsync('unsuccessful upstream response returned as upstream-error result', async () => {
    const mockClient = createMockClient({
      response: new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    })

    const result = await executeCompletionAttempt(openaiReq, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('upstream-error')
    if (result.kind === 'upstream-error') {
      expect(result.status).toBe(500)
      expect(result.statusText).toBe('Internal Server Error')
    }
  })

  // Test 11: successful upstream response with no body returned as missing-body result
  failed += await runTestAsync('successful upstream response with no body returned as missing-body result', async () => {
    const mockClient = createMockClient({
      response: new Response(null, { status: 200 }),
    })

    const result = await executeCompletionAttempt(openaiReq, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.kind).toBe('missing-body')
  })

  // Test 12: sessionUpdatePromise preserved exactly for caller
  failed += await runTestAsync('sessionUpdatePromise preserved exactly for caller', async () => {
    const testPromise = Promise.resolve()
    
    const mockClient = createMockClient({
      sessionUpdatePromise: testPromise,
    })

    const result = await executeCompletionAttempt(openaiReq, makeHeaders(), {
      client: mockClient,
      timeoutMs: 15000,
      sendSystemPrompt: false,
    })

    expect(result.sessionUpdatePromise).toBe(testPromise)
  })

  // Test 13: no toolResults property crosses translator-out/deepseek boundary
  failed += await runTestAsync('no toolResults property crosses translator-out/deepseek boundary', async () => {
    let capturedInput: DeepSeekCompletionInput | null = null
    const mockClient = createMockClient()
    const originalComplete = mockClient.completeWithAutoSession
    mockClient.completeWithAutoSession = async (input: DeepSeekCompletionInput) => {
      capturedInput = input
      return originalComplete(input)
    }

    const result = await executeCompletionAttempt(openaiReq, makeHeaders('test-session'), {
      client: mockClient,
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

  console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
  if (failed > 0) process.exit(1)
}

main()