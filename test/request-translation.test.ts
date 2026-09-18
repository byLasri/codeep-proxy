import { buildDeepSeekPrompt, translateOpenAIRequest, type ToolResult, type PromptWithToolResults } from '../src/translator/request.js'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from '../src/translator/types.js'

function makeHeaders(sessionId?: string): Headers {
  const h = new Headers()
  if (sessionId) h.set('X-Session-Id', sessionId)
  return h
}

function runTest(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    return false  // false = not failed
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    return true  // true = failed
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
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null but got ${actual}`)
      }
    }
  }
  return { ...matchers }
}

console.log('Running Request Translation Tests...\n')

let failed = 0

// Test 1: Single tool result preserves role, tool_call_id, content
failed += runTest('single tool result preserves role, tool_call_id, content', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'Read README' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'call_123', content: 'README contents' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(1)
  expect(result.toolResults[0].role).toBe('tool')
  expect(result.toolResults[0].tool_call_id).toBe('call_123')
  expect(result.toolResults[0].content).toBe('README contents')
  // prompt should be the tool result content for backward compatibility
  expect(result.prompt).toBe('README contents')
})

// Test 2: Multiple consecutive tool results preserved in order
failed += runTest('multiple consecutive tool results preserved in order', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'Read multiple files' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.txt"}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"filePath":"b.txt"}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'File A contents' },
    { role: 'tool', tool_call_id: 'call_2', content: 'File B contents' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(2)
  expect(result.toolResults[0].tool_call_id).toBe('call_1')
  expect(result.toolResults[0].content).toBe('File A contents')
  expect(result.toolResults[1].tool_call_id).toBe('call_2')
  expect(result.toolResults[1].content).toBe('File B contents')
  // prompt should be the last tool result content
  expect(result.prompt).toBe('File B contents')
})

// Test 3: Tool result content preserved exactly including whitespace/newlines
failed += runTest('tool result content preserved exactly including whitespace/newlines', () => {
  const contentWithWhitespace = '  leading\nmiddle\n  trailing  '
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'test' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: contentWithWhitespace }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(1)
  expect(result.toolResults[0].content).toBe(contentWithWhitespace)
  expect(result.prompt).toBe(contentWithWhitespace)
})

// Test 4: Normal user continuation still works (no tool results)
failed += runTest('normal user continuation without tool results', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'First message' },
    { role: 'assistant', content: 'First response' },
    { role: 'user', content: 'Second message' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(0)
  expect(result.prompt).toBe('Second message')
})

// Test 5: First turn (no assistant messages) still works
failed += runTest('first turn with system prompt and tools', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello' }
  ]
  const tools = [{ type: 'function', function: { name: 'test', description: 'test' } }]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages, tools, true)

  expect(result.toolResults).toHaveLength(0)
  expect(result.prompt).toContain('You are a helpful assistant')
  expect(result.prompt).toContain('Hello')
  expect(result.prompt).toContain('test')
})

// Test 6: translateOpenAIRequest includes toolResults
failed += runTest('translateOpenAIRequest includes toolResults', () => {
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Read README' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_123', content: 'README contents' }
    ],
    tools: []
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), false)

  expect(result.prompt).toBe('README contents')
  expect(result.toolResults).toHaveLength(1)
  expect(result.toolResults[0].tool_call_id).toBe('call_123')
  expect(result.toolResults[0].content).toBe('README contents')
  expect(result.model_type).toBeDefined()
  expect(result.thinking_enabled).toBeDefined()
  expect(result.search_enabled).toBeDefined()
})

// Test 7: translateOpenAIRequest with multiple tool results
failed += runTest('translateOpenAIRequest with multiple tool results', () => {
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

  expect(result.toolResults).toHaveLength(2)
  expect(result.toolResults[0].tool_call_id).toBe('call_1')
  expect(result.toolResults[1].tool_call_id).toBe('call_2')
})

// Test 8: Tool result without tool_call_id is not included (invalid)
failed += runTest('tool result without tool_call_id is not included', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'test' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
    { role: 'tool', content: 'no tool_call_id' } // missing tool_call_id
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  // Should not include the invalid tool result
  expect(result.toolResults).toHaveLength(0)
  // Should fall back to user message
  expect(result.prompt).toBe('test')
})

// Test 9: Tool result with null content is not included
failed += runTest('tool result with null content is not included', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'test' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: null }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(0)
  expect(result.prompt).toBe('test')
})

// Test 10: Mixed messages - only trailing tool results collected
failed += runTest('only trailing consecutive tool results collected', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'First' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Tool 1' },
    { role: 'user', content: 'Second' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'test', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_2', content: 'Tool 2' },
    { role: 'tool', tool_call_id: 'call_3', content: 'Tool 3' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  // Only the last two tool results (consecutive at the end) should be collected
  expect(result.toolResults).toHaveLength(2)
  expect(result.toolResults[0].tool_call_id).toBe('call_2')
  expect(result.toolResults[1].tool_call_id).toBe('call_3')
  expect(result.prompt).toBe('Tool 3')
})

console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
if (failed > 0) process.exit(1)