import { buildDeepSeekPrompt, translateOpenAIRequest, type ToolResult, type PromptWithToolResults } from '../src/translator/request.js'
import { translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON, parseDSMLToolCalls, type SSEParseResult } from '../src/translator/response.js'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from '../src/translator/types.js'
import type { DeepSeekCompletionInput } from '../src/deepseek_api/types.js'

function makeHeaders(sessionId?: string): Headers {
  const h = new Headers()
  if (sessionId) h.set('X-Session-Id', sessionId)
  return h
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

function makeSSEEvent(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function makeSSEData(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function makePEvent(data: object): string {
  return `event: p\ndata: ${JSON.stringify(data)}\n\n`
}

async function decodeStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  result += decoder.decode()
  return result
}

function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(() => {
        console.log(`✓ ${name}`)
        return false
      }).catch((error) => {
        console.error(`✗ ${name}`)
        console.error(`  ${error instanceof Error ? error.message : error}`)
        return true
      })
    }
    console.log(`✓ ${name}`)
    return false
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    return true
  }
}

async function runTestsSequentially(tests: Array<{ name: string; fn: () => void | Promise<void> }>) {
  let failed = 0
  for (const { name, fn } of tests) {
    const result = runTest(name, fn)
    if (result instanceof Promise) {
      if (await result) failed++
    } else if (result) {
      failed++
    }
  }
  return failed
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
      toBe(expected: T) {
        if (actual === expected) {
          throw new Error(`Expected not ${expected} but got ${actual}`)
        }
      }
    }
  }
  return { ...matchers }
}

async function main() {
  console.log('Running Architecture Baseline Tests...\n')

  let failed = 0

  // ============================================================
  // 1. OUTBOUND PROMPT CONSTRUCTION
  // ============================================================
  console.log('\n--- 1. Outbound Prompt Construction ---\n')

  // First turn with system + user + tools
  failed += runTest('first turn: system + user + tools -> prompt contains system, tools, user in order', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello world' },
    ]
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file' } }]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages, tools, true)

    expect(result.prompt).toContain('You are a helpful assistant')
    expect(result.prompt).toContain('read_file')
    expect(result.prompt).toContain('Hello world')
    // Order: system -> tools -> user
    const sysIdx = result.prompt.indexOf('You are a helpful assistant')
    const toolsIdx = result.prompt.indexOf('read_file')
    const userIdx = result.prompt.indexOf('Hello world')
    if (!(sysIdx < toolsIdx && toolsIdx < userIdx)) {
      throw new Error('Order should be: system, tools, user')
    }
    expect(result.toolResults).toHaveLength(0)
  })

  // First turn without system, with user + tools
  failed += runTest('first turn: user + tools -> prompt contains tools, user in order', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Hello world' },
    ]
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file' } }]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages, tools, true)

    expect(result.prompt).toContain('read_file')
    expect(result.prompt).toContain('Hello world')
    const toolsIdx = result.prompt.indexOf('read_file')
    const userIdx = result.prompt.indexOf('Hello world')
    if (!(toolsIdx < userIdx)) {
      throw new Error('Order should be: tools, user')
    }
    expect(result.toolResults).toHaveLength(0)
  })

  // Continuation turn without tool results
  failed += runTest('continuation without tool results: latest user message becomes prompt', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response' },
      { role: 'user', content: 'Second message' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(0)
    expect(result.prompt).toBe('Second message')
  })

  // Continuation with single tool result
  failed += runTest('continuation with single tool result: tool content becomes prompt', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Read README' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_123', content: 'README contents' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0].role).toBe('tool')
    expect(result.toolResults[0].tool_call_id).toBe('call_123')
    expect(result.toolResults[0].content).toBe('README contents')
    expect(result.prompt).toBe('README contents')
  })

  // Continuation with multiple consecutive tool results
  failed += runTest('continuation with multiple tool results: all preserved in order, joined with double newline', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Read multiple files' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.txt"}' } },
        { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"filePath":"b.txt"}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'File A contents' },
      { role: 'tool', tool_call_id: 'call_2', content: 'File B contents' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(2)
    expect(result.toolResults[0].tool_call_id).toBe('call_1')
    expect(result.toolResults[0].content).toBe('File A contents')
    expect(result.toolResults[1].tool_call_id).toBe('call_2')
    expect(result.toolResults[1].content).toBe('File B contents')
    expect(result.prompt).toBe('File A contents\n\nFile B contents')
  })

  // Tool call metadata NOT in prompt
  failed += runTest('tool_call_id and role metadata NOT in DeepSeek prompt', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Read files' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Result A' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Result B' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    const prompt = result.prompt
    if (!prompt.includes('Result A')) throw new Error('Prompt should contain Result A')
    if (!prompt.includes('Result B')) throw new Error('Prompt should contain Result B')
    if (prompt.includes('call_1')) throw new Error('Prompt should not contain call_1')
    if (prompt.includes('call_2')) throw new Error('Prompt should not contain call_2')
    if (prompt.includes('"tool"')) throw new Error('Prompt should not contain "tool"')
    if (prompt.includes('role')) throw new Error('Prompt should not contain role')
    expect(prompt).toBe('Result A\n\nResult B')
  })

  // ============================================================
  // 2. sendSystemPrompt BEHAVIOR
  // ============================================================
  console.log('\n--- 2. sendSystemPrompt Behavior ---\n')

  failed += runTest('sendSystemPrompt=true: system messages included in prompt', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'User message' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages, undefined, true)

    expect(result.prompt).toContain('System instruction')
    expect(result.prompt).toContain('User message')
    const sysIdx = result.prompt.indexOf('System instruction')
    const userIdx = result.prompt.indexOf('User message')
    if (!(sysIdx < userIdx)) {
      throw new Error('System should come before user')
    }
  })

  failed += runTest('sendSystemPrompt=false: system messages EXCLUDED from prompt', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'User message' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages, undefined, false)

    expect(result.prompt).not.toContain('System instruction')
    expect(result.prompt).toContain('User message')
    expect(result.prompt).toBe('User message')
  })

  failed += runTest('sendSystemPrompt=false on continuation: system excluded, tool results still work', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'First' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Tool result' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages, undefined, false)

    expect(result.prompt).not.toContain('System instruction')
    expect(result.prompt).toBe('Tool result')
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0].content).toBe('Tool result')
  })

  // ============================================================
  // 3. TRANSLATOR-OUT BOUNDARY BASELINE
  // ============================================================
  console.log('\n--- 3. Translator-Out Boundary Baseline ---\n')

  failed += runTest('translateOpenAIRequest returns DeepSeekCompletionInput with all required fields + toolResults', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: 'Read README' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
        { role: 'tool', tool_call_id: 'call_123', content: 'README contents' },
      ],
      tools: []
    }

    const result = translateOpenAIRequest(req, makeHeaders('session-123'), false)

    // DeepSeekCompletionInput fields
    expect(result.prompt).toBe('README contents')
    expect(result.model_type).toBeDefined()
    expect(typeof result.thinking_enabled).toBe('boolean')
    expect(typeof result.search_enabled).toBe('boolean')
    expect(result.xSessionId).toBe('session-123')
    expect(result.chat_session_id).toBeUndefined()
    expect(result.timeout).toBeUndefined()

    // toolResults (current internal field, will be removed in Phase 2)
    expect(result.toolResults).toBeDefined()
    expect(Array.isArray(result.toolResults)).toBe(true)
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0].tool_call_id).toBe('call_123')
    expect(result.toolResults[0].content).toBe('README contents')
  })

  failed += runTest('translateOpenAIRequest xSessionId extracted from X-Session-Id header', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'test' }],
    }

    const result = translateOpenAIRequest(req, makeHeaders('test-session-456'), false)
    expect(result.xSessionId).toBe('test-session-456')
  })

  failed += runTest('translateOpenAIRequest xSessionId extracted from X-Session-Affinity fallback', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'test' }],
    }
    const h = new Headers()
    h.set('X-Session-Affinity', 'affinity-session-789')

    const result = translateOpenAIRequest(req, h, false)
    expect(result.xSessionId).toBe('affinity-session-789')
  })

  failed += runTest('translateOpenAIRequest model mapping: V4-Pro-DeepThink -> expert + thinking', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'V4-Pro-DeepThink',
      messages: [{ role: 'user', content: 'test' }],
    }

    const result = translateOpenAIRequest(req, makeHeaders(), false)
    expect(result.model_type).toBe('expert')
    expect(result.thinking_enabled).toBe(true)
    expect(result.search_enabled).toBe(false)
  })

  failed += runTest('translateOpenAIRequest model mapping: V4.1-flash-DeepThink-Web -> flash + thinking + search', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'V4.1-flash-DeepThink-Web',
      messages: [{ role: 'user', content: 'test' }],
    }

    const result = translateOpenAIRequest(req, makeHeaders(), false)
    expect(result.model_type).toBeNull()
    expect(result.thinking_enabled).toBe(true)
    expect(result.search_enabled).toBe(true)
  })

  // ============================================================
  // 4. INBOUND NORMAL TEXT RESPONSE
  // ============================================================
  console.log('\n--- 4. Inbound Normal Text Response ---\n')

  // Helper to create a simple text response SSE stream
  function createTextSSEStream(text: string): ReadableStream<Uint8Array> {
    const sseChunks = [
      makeSSEEvent('ready', { response_message_id: 12345 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: text }),
      makePEvent({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    return createSSEStream(sseChunks)
  }

  failed += runTest('translateDeepSeekStreamToSSE: normal text -> parseError null, stream has content + [DONE]', async () => {
    const stream = createTextSSEStream('Hello, this is a normal response.')
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)

    expect(result.parseError).toBeNull()
    const output = await decodeStream(result.stream)
    expect(output).toContain('Hello, this is a normal response.')
    expect(output).toContain('[DONE]')
    expect(output).not.toContain('tool_calls')
  })

  failed += runTest('translateDeepSeekStreamToJSON: normal text -> _malformedError undefined, finish_reason stop', async () => {
    const stream = createTextSSEStream('Hello, this is a normal response.')
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result = await translateDeepSeekStreamToJSON(stream, info)

    expect(result._malformedError).toBeUndefined()
    expect(result.choices[0].message.content).toBe('Hello, this is a normal response.')
    expect(result.choices[0].finish_reason).toBe('stop')
    expect(result.choices[0].message.tool_calls).toBeUndefined()
  })

  // ============================================================
  // 5. INBOUND VALID DSML TOOL CALL
  // ============================================================
  console.log('\n--- 5. Inbound Valid DSML Tool Call ---\n')

  function createValidDSMLStream(): ReadableStream<Uint8Array> {
    // Send DSML in multiple chunks like real DeepSeek does
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

  failed += runTest('translateDeepSeekStreamToSSE: valid DSML -> parseError null, tool_calls emitted', async () => {
    const stream = createValidDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)

    expect(result.parseError).toBeNull()
    const output = await decodeStream(result.stream)
    expect(output).toContain('tool_calls')
    expect(output).toContain('read_file')
    expect(output).toContain('README.md')
    expect(output).toContain('[DONE]')
  })

  failed += runTest('translateDeepSeekStreamToJSON: valid DSML -> _malformedError undefined, tool_calls in response', async () => {
    const stream = createValidDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result = await translateDeepSeekStreamToJSON(stream, info)

    expect(result._malformedError).toBeUndefined()
    expect(result.choices[0].message.tool_calls).toBeDefined()
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
    expect(result.choices[0].message.tool_calls![0].function.name).toBe('read_file')
    expect(JSON.parse(result.choices[0].message.tool_calls![0].function.arguments).filePath).toBe('README.md')
    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.choices[0].message.content).toBeNull()
  })

  // ============================================================
  // 6. INBOUND MALFORMED DSML BEHAVIOR
  // ============================================================
  console.log('\n--- 6. Inbound Malformed DSML Behavior ---\n')

  function createMalformedDSMLStream(): ReadableStream<Uint8Array> {
    // Missing closing </calls> tag - send in multiple chunks
    const sseChunks = [
      makeSSEEvent('ready', { response_message_id: 12345 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read_file">' }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
      // Missing </｜｜DSML｜｜ calls>
      makePEvent({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    return createSSEStream(sseChunks)
  }

  failed += runTest('translateDeepSeekStreamToSSE: malformed DSML -> parseError present with message + syntaxRules', async () => {
    const stream = createMalformedDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)

    expect(result.parseError).toBeDefined()
    expect(result.parseError!.message).toBeDefined()
    expect(result.parseError!.syntaxRules).toBeDefined()
    expect(result.parseError!.message).toContain('Missing closing')
    expect(result.parseError!.syntaxRules).toContain('Your previous response contained a malformed tool call')
  })

  failed += runTest('translateDeepSeekStreamToJSON: malformed DSML -> _malformedError present', async () => {
    const stream = createMalformedDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result = await translateDeepSeekStreamToJSON(stream, info)

    expect(result._malformedError).toBeDefined()
    expect(result._malformedError!.message).toBeDefined()
    expect(result._malformedError!.syntaxRules).toBeDefined()
    expect(result._malformedError!.message).toContain('Missing closing')
    expect(result._malformedError!.syntaxRules).toContain('Your previous response contained a malformed tool call')
  })

  failed += runTest('malformed DSML: no successful tool_calls emitted to client', async () => {
    const stream = createMalformedDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)
    const output = await decodeStream(result.stream)

    // Should emit empty response with finish_reason stop, not tool_calls
    expect(output).not.toContain('tool_calls')
    expect(output).toContain('[DONE]')
  })

  // ============================================================
  // 7. FULL-STREAM CONSUMPTION BEHAVIOR
  // ============================================================
  console.log('\n--- 7. Full-Stream Consumption Behavior ---\n')

  failed += runTest('upstream stream fully consumed before parse error available (streaming)', async () => {
    const stream = createMalformedDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result = await translateDeepSeekStreamToSSE(stream, info)

    // The function must fully consume the stream before returning parseError
    // This is verified by the fact that parseError is available synchronously after the call
    expect(result.parseError).toBeDefined()
  })

  failed += runTest('upstream stream fully consumed before parse error available (non-streaming)', async () => {
    const stream = createMalformedDSMLStream()
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result = await translateDeepSeekStreamToJSON(stream, info)

    expect(result._malformedError).toBeDefined()
  })

  // ============================================================
  // 8. CHUNK BOUNDARY ROBUSTNESS
  // ============================================================
  console.log('\n--- 8. Chunk Boundary Robustness ---\n')

  failed += runTest('split SSE chunks: DSML delimiter split across chunks', async () => {
    const dsml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

    // Split the DSML across multiple chunks
    const sseChunks = [
      makeSSEEvent('ready', { response_message_id: 12345 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: dsml.substring(0, 20) }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: dsml.substring(20, 50) }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: dsml.substring(50) }),
      makePEvent({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseChunks)
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)
    expect(result.parseError).toBeNull()

    const output = await decodeStream(result.stream)
    expect(output).toContain('tool_calls')
    expect(output).toContain('read_file')
  })

  failed += runTest('CRLF line endings in SSE stream', async () => {
    const sseChunks = [
      'event: ready\r\ndata: {"response_message_id": 12345}\r\n\r\n',
      'event: update_session\r\ndata: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":""}]}}}\r\n\r\n',
      'event: p\r\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"Hello"}\r\n\r\n',
      'event: p\r\ndata: {"p":"response/status","o":"SET","v":"FINISHED"}\r\n\r\n',
      'event: close\r\n\r\n',
    ]
    const stream = createSSEStream(sseChunks)
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)
    expect(result.parseError).toBeNull()

    const output = await decodeStream(result.stream)
    expect(output).toContain('Hello')
    expect(output).toContain('[DONE]')
  })

  failed += runTest('final SSE line without trailing newline', async () => {
    const sseChunks = [
      makeSSEEvent('ready', { response_message_id: 12345 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makePEvent({ p: 'response/fragments/-1/content', o: 'APPEND', v: 'Final content' }),
      makePEvent({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
      'event: close', // No trailing \n\n
    ]
    const stream = createSSEStream(sseChunks)
    const info = { model: 'test-model', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }

    const result: SSEParseResult = await translateDeepSeekStreamToSSE(stream, info)
    expect(result.parseError).toBeNull()

    const output = await decodeStream(result.stream)
    expect(output).toContain('Final content')
    expect(output).toContain('[DONE]')
  })

  // ============================================================
  // 9. NO-SYSTEM-PROMPT RETRY CHARACTERIZATION
  // ============================================================
  console.log('\n--- 9. No-System-Prompt Retry Characterization ---\n')

  // This test simulates the retry behavior using pure translator functions
  // It does NOT perform a live DeepSeek call - it uses mocked translator-in results
  // to verify the outbound translation behavior on retry

  failed += runTest('retry: second translateOpenAIRequest call excludes system prompt when sendSystemPrompt=false', () => {
    // Simulate initial request with system prompt
    const initialMessages: OpenAIChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Read README' },
    ]

    // Initial translation (turn 1, sendSystemPrompt=true)
    const initialResult = translateOpenAIRequest(
      { model: 'deepseek-chat', messages: initialMessages, tools: [] },
      makeHeaders('session-1'),
      true // sendSystemPrompt = true for initial request
    )

    expect(initialResult.prompt).toContain('You are a helpful assistant')
    expect(initialResult.prompt).toContain('Read README')

    // Simulate malformed response -> retry preparation
    // In real code, index.ts pushes corrective message as user message
    // Here we simulate the retry by calling translateOpenAIRequest again with:
    // - updated messages (with corrective feedback)
    // - sendSystemPrompt = false (the 961a0b7 fix)
    const retryMessages: OpenAIChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Read README' },
      { role: 'assistant', content: 'malformed tool call attempt' }, // simulated bad response
      { role: 'user', content: 'CORRECTIVE: Missing closing </calls> tag' }, // corrective feedback
    ]

    const retryResult = translateOpenAIRequest(
      { model: 'deepseek-chat', messages: retryMessages, tools: [] },
      makeHeaders('session-1'),
      false // sendSystemPrompt = false on retry (critical 961a0b7 behavior)
    )

    // The retry prompt should NOT contain the system instruction
    expect(retryResult.prompt).not.toContain('You are a helpful assistant')
    expect(retryResult.prompt).toContain('CORRECTIVE: Missing closing </calls> tag')
  })

  failed += runTest('retry: system prompt suppression verified at translateOpenAIRequest boundary', () => {
    // This test explicitly documents the contract that the retry logic depends on:
    // translateOpenAIRequest(sendSystemPrompt=false) MUST exclude system messages

    const messagesWithSystem: OpenAIChatMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'User message' },
    ]

    const withSystem = translateOpenAIRequest(
      { model: 'deepseek-chat', messages: messagesWithSystem, tools: [] },
      makeHeaders(),
      true
    )

    const withoutSystem = translateOpenAIRequest(
      { model: 'deepseek-chat', messages: messagesWithSystem, tools: [] },
      makeHeaders(),
      false
    )

    expect(withSystem.prompt).toContain('System instruction')
    expect(withoutSystem.prompt).not.toContain('System instruction')
    expect(withoutSystem.prompt).toBe('User message')
  })

  // ============================================================
  // 10. SESSION BOUNDARY BASELINE
  // ============================================================
  console.log('\n--- 10. Session Boundary Baseline ---\n')

  failed += runTest('translateOpenAIRequest output has correct DeepSeekCompletionInput shape for deepseek_api', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'tool result' },
      ],
    }

    const result = translateOpenAIRequest(req, makeHeaders('session-xyz'), true)

    // Verify all fields that deepseek_api expects
    const expectedKeys: (keyof DeepSeekCompletionInput)[] = [
      'chat_session_id',
      'xSessionId',
      'prompt',
      'model_type',
      'thinking_enabled',
      'search_enabled',
    ]

    for (const key of expectedKeys) {
      if (result === null || result === undefined || !(key in result)) {
        throw new Error(`Expected object to have property "${key}"`)
      }
    }

    // Verify types
    expect(typeof result.prompt).toBe('string')
    // model_type can be string or null
    expect(typeof result.thinking_enabled).toBe('boolean')
    expect(typeof result.search_enabled).toBe('boolean')
    expect(result.xSessionId).toBe('session-xyz')
    expect(result.chat_session_id).toBeUndefined()

    // toolResults is internal - not part of DeepSeekCompletionInput
    // but currently present on the returned object
    if (!('toolResults' in result)) {
      throw new Error('Expected object to have property "toolResults"')
    }
  })

  console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
  if (failed > 0) process.exit(1)
}

main()