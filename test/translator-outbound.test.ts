import { 
  buildDeepSeekPrompt, 
  translateOpenAIRequest, 
  getXSessionIdFromHeaders, 
  isFirstTurn,
  type ToolResult, 
  type PromptWithToolResults
} from '../src/translator/outbound.js'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from '../src/translator/types.js'

function makeHeaders(sessionId?: string, affinityId?: string): Headers {
  const h = new Headers()
  if (sessionId) h.set('X-Session-Id', sessionId)
  if (affinityId) h.set('X-Session-Affinity', affinityId)
  return h
}

function makeRequest(overrides: Partial<OpenAIChatCompletionRequest> = {}): OpenAIChatCompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    ...overrides
  }
}

import { readFileSync } from 'fs'
import { resolve } from 'path'

function readFile(filePath: string): string {
  return readFileSync(resolve(process.cwd(), filePath), 'utf-8')
}

function runTest(name: string, fn: () => void): boolean {
  try {
    fn()
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
      toHaveProperty(prop: string) {
        if (actual === null || actual === undefined || !(prop in actual)) {
          throw new Error(`Expected object to have property "${prop}"`)
        }
      },
    }
  }
  return { ...matchers }
}

async function main() {
  console.log('Running Outbound Translator Independent Tests...\n')

  let failed = 0

  // ============================================================
  // 1. First-turn prompt construction
  // ============================================================
  console.log('\n--- 1. First-turn prompt construction ---\n')

  failed += runTest('first turn with system + user + tools produces correct prompt', () => {
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

  failed += runTest('first turn with user + tools (no system) produces correct prompt', () => {
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

  // ============================================================
  // 2. Explicit system-prompt suppression
  // ============================================================
  console.log('\n--- 2. Explicit system-prompt suppression ---\n')

  failed += runTest('sendSystemPrompt=true includes system messages', () => {
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

  failed += runTest('sendSystemPrompt=false excludes system messages', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'User message' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages, undefined, false)

    expect(result.prompt).not.toContain('System instruction')
    expect(result.prompt).toContain('User message')
    expect(result.prompt).toBe('User message')
  })

  failed += runTest('sendSystemPrompt=false on continuation still works with tool results', () => {
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
  // 3. Automatic first-turn detection
  // ============================================================
  console.log('\n--- 3. Automatic first-turn detection ---\n')

  failed += runTest('isFirstTurn returns true when no assistant messages', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ]
    expect(isFirstTurn(messages)).toBe(true)
  })

  failed += runTest('isFirstTurn returns false when assistant message exists', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ]
    expect(isFirstTurn(messages)).toBe(false)
  })

  failed += runTest('sendSystemPrompt=false forces firstTurn=false', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ]
    const result = buildDeepSeekPrompt(messages, undefined, false)
    expect(result.prompt).not.toContain('System')
  })

  failed += runTest('sendSystemPrompt=true forces firstTurn=true', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Again' },
    ]
    const result = buildDeepSeekPrompt(messages, undefined, true)
    expect(result.prompt).toContain('System')
  })

  // ============================================================
  // 4. Normal continuation
  // ============================================================
  console.log('\n--- 4. Normal continuation ---\n')

  failed += runTest('continuation without tool results uses latest user message', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response' },
      { role: 'user', content: 'Second message' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(0)
    expect(result.prompt).toBe('Second message')
  })

  // ============================================================
  // 5. Tool-result continuation
  // ============================================================
  console.log('\n--- 5. Tool-result continuation ---\n')

  failed += runTest('single tool result becomes prompt', () => {
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

  failed += runTest('multiple consecutive tool results preserved in order', () => {
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

  failed += runTest('tool result content preserved exactly including whitespace/newlines', () => {
    const contentWithWhitespace = '  leading\nmiddle\n  trailing  '
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: contentWithWhitespace },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0].content).toBe(contentWithWhitespace)
    expect(result.prompt).toBe(contentWithWhitespace)
  })

  // ============================================================
  // 6. Tool-result filtering
  // ============================================================
  console.log('\n--- 6. Tool-result filtering ---\n')

  failed += runTest('tool result without tool_call_id is not included', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
      { role: 'tool', content: 'no tool_call_id' }, // missing tool_call_id
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(0)
    expect(result.prompt).toBe('test')
  })

  failed += runTest('tool result with null content is not included', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: null },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(0)
    expect(result.prompt).toBe('test')
  })

  failed += runTest('only trailing consecutive tool results collected', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Tool 1' },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'test', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'Tool 2' },
      { role: 'tool', tool_call_id: 'call_3', content: 'Tool 3' },
    ]

    const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

    expect(result.toolResults).toHaveLength(2)
    expect(result.toolResults[0].tool_call_id).toBe('call_2')
    expect(result.toolResults[1].tool_call_id).toBe('call_3')
    expect(result.prompt).toBe('Tool 2\n\nTool 3')
  })

  // ============================================================
  // 7. Session header translation
  // ============================================================
  console.log('\n--- 7. Session header translation ---\n')

  failed += runTest('X-Session-Id mapped to xSessionId', () => {
    const headers = makeHeaders('session-123')
    const req = makeRequest({ messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, headers, false)

    expect(result.xSessionId).toBe('session-123')
  })

  failed += runTest('X-Session-Id whitespace trimmed', () => {
    const headers = makeHeaders('  session-456  ')
    const req = makeRequest({ messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, headers, false)

    expect(result.xSessionId).toBe('session-456')
  })

  failed += runTest('X-Session-Affinity fallback when X-Session-Id absent', () => {
    const h = new Headers()
    h.set('X-Session-Affinity', 'affinity-session-789')
    const req = makeRequest({ messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, h, false)

    expect(result.xSessionId).toBe('affinity-session-789')
  })

  failed += runTest('invalid/empty X-Session-Id results in undefined', () => {
    const h = new Headers()
    h.set('X-Session-Id', '  ')
    const req = makeRequest({ messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, h, false)

    expect(result.xSessionId).toBeUndefined()
  })

  failed += runTest('oversized X-Session-Id results in undefined', () => {
    const longId = 'a'.repeat(129)
    const h = new Headers()
    h.set('X-Session-Id', longId)
    const req = makeRequest({ messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, h, false)

    expect(result.xSessionId).toBeUndefined()
  })

  // ============================================================
  // 8. Model translation
  // ============================================================
  console.log('\n--- 8. Model translation ---\n')

  failed += runTest('V4-Pro-DeepThink maps to expert + thinking', () => {
    const req = makeRequest({ model: 'V4-Pro-DeepThink', messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, makeHeaders(), false)

    expect(result.model_type).toBe('expert')
    expect(result.thinking_enabled).toBe(true)
    expect(result.search_enabled).toBe(false)
  })

  failed += runTest('V4.1-flash-DeepThink-Web maps to flash + thinking + search', () => {
    const req = makeRequest({ model: 'V4.1-flash-DeepThink-Web', messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, makeHeaders(), false)

    expect(result.model_type).toBeNull()
    expect(result.thinking_enabled).toBe(true)
    expect(result.search_enabled).toBe(true)
  })

  failed += runTest('unknown model defaults to Flash Standard', () => {
    const req = makeRequest({ model: 'unknown-model', messages: [{ role: 'user', content: 'test' }] })
    const result = translateOpenAIRequest(req, makeHeaders(), false)

    expect(result.model_type).toBeNull()
    expect(result.thinking_enabled).toBe(false)
    expect(result.search_enabled).toBe(false)
  })

  // ============================================================
  // 9. Exact DeepSeek contract boundary
  // ============================================================
  console.log('\n--- 9. Exact DeepSeek contract boundary ---\n')

  failed += runTest('translateOpenAIRequest returns DeepSeekCompletionInput without toolResults', () => {
    const req = makeRequest({
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: 'Read README' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
        { role: 'tool', tool_call_id: 'call_123', content: 'README contents' },
      ],
      tools: []
    })

    const result = translateOpenAIRequest(req, makeHeaders('session-123'), false)

    // DeepSeekCompletionInput fields
    expect(result.prompt).toBe('README contents')
    expect(result.model_type).toBeDefined()
    expect(typeof result.thinking_enabled).toBe('boolean')
    expect(typeof result.search_enabled).toBe('boolean')
    expect(result.xSessionId).toBe('session-123')
    expect(result.chat_session_id).toBeUndefined()
    expect(result.timeout).toBeUndefined()

    // CRITICAL: toolResults must NOT be on the public return
    if ('toolResults' in result) {
      throw new Error('translateOpenAIRequest must not expose toolResults')
    }
  })

  failed += runTest('translateOpenAIRequest with multiple tool results - prompt correct, no toolResults exposed', () => {
    const req: OpenAIChatCompletionRequest = {
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: 'Read files' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.txt"}' } },
          { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"filePath":"b.txt"}' } }
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: 'File A' },
        { role: 'tool', tool_call_id: 'call_2', content: 'File B' }
      ],
      tools: []
    }

    const result = translateOpenAIRequest(req, makeHeaders('session-123'), false)

    expect(result.prompt).toBe('File A\n\nFile B')
    if ('toolResults' in result) {
      throw new Error('translateOpenAIRequest must not expose toolResults')
    }
  })

  // ============================================================
  // 10. Error behavior
  // ============================================================
  console.log('\n--- 10. Error behavior ---\n')

  failed += runTest('No user message found throws error', () => {
    const req = makeRequest({ messages: [] })
    let threw = false
    try {
      translateOpenAIRequest(req, makeHeaders(), false)
    } catch (e) {
      threw = true
      expect((e as Error).message).toBe('No user message found')
    }
    if (!threw) throw new Error('Expected error to be thrown')
  })

  // ============================================================
  // Independence verification (real source inspection)
  // ============================================================
  console.log('\n--- Independence verification (source inspection) ---\n')

  failed += runTest('outbound does not import from inbound', () => {
    const content = readFile('src/translator/outbound.ts')
    if (content.includes('../translator/inbound') || content.includes('./inbound')) {
      throw new Error('outbound.ts imports from inbound')
    }
  })

  failed += runTest('outbound does not import orchestrator', () => {
    const content = readFile('src/translator/outbound.ts')
    if (content.includes('orchestrator')) {
      throw new Error('outbound.ts imports orchestrator')
    }
  })

  failed += runTest('outbound does not import deepseek_api/client', () => {
    const content = readFile('src/translator/outbound.ts')
    if (content.includes('deepseek_api/client')) {
      throw new Error('outbound.ts imports deepseek_api/client')
    }
  })

  failed += runTest('outbound does not import src/index', () => {
    const content = readFile('src/translator/outbound.ts')
    if (content.includes('src/index')) {
      throw new Error('outbound.ts imports src/index')
    }
  })

  console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
  if (failed > 0) process.exit(1)
}

main()