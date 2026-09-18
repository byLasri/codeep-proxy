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
  // prompt should be the tool result content (single result = just the content)
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
  // prompt should contain ALL tool results joined with double newline
  expect(result.prompt).toBe('File A contents\n\nFile B contents')
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
  expect(result.prompt).toBe('File A\n\nFile B')
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
  expect(result.prompt).toBe('Tool 2\n\nTool 3')
})

// Test 11: Four-result regression (exact shape of live failure)
failed += runTest('four-result regression preserves all results in order', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'Read all files' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"filePath":"config.json"}' } },
      { id: 'call_3', type: 'function', function: { name: 'read', arguments: '{"filePath":"index.js"}' } },
      { id: 'call_4', type: 'function', function: { name: 'read', arguments: '{"filePath":"notes.txt"}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'README result' },
    { role: 'tool', tool_call_id: 'call_2', content: 'config.json result' },
    { role: 'tool', tool_call_id: 'call_3', content: 'index.js result' },
    { role: 'tool', tool_call_id: 'call_4', content: 'notes.txt result' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(4)
  // All four present
  expect(result.prompt).toContain('README result')
  expect(result.prompt).toContain('config.json result')
  expect(result.prompt).toContain('index.js result')
  expect(result.prompt).toContain('notes.txt result')
  // Order preserved
  const readmeIdx = result.prompt.indexOf('README result')
  const configIdx = result.prompt.indexOf('config.json result')
  const indexIdx = result.prompt.indexOf('index.js result')
  const notesIdx = result.prompt.indexOf('notes.txt result')
  if (!(readmeIdx < configIdx)) throw new Error('README should come before config')
  if (!(configIdx < indexIdx)) throw new Error('config should come before index.js')
  if (!(indexIdx < notesIdx)) throw new Error('index.js should come before notes')
  // None lost - exact format
  expect(result.prompt).toBe('README result\n\nconfig.json result\n\nindex.js result\n\nnotes.txt result')
})

// Test 12: Exact content preservation (whitespace, newlines, XML-like, Windows paths)
failed += runTest('exact content preservation for complex tool results', () => {
  const complexContent = '  leading spaces\nmiddle line\n  trailing  \nwith <xml-like> text\nC:\\Users\\Damas\\file.txt'
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'test' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: complexContent },
    { role: 'tool', tool_call_id: 'call_2', content: 'simple content' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(2)
  // First result content preserved exactly
  expect(result.toolResults[0].content).toBe(complexContent)
  // Prompt contains the exact first result content
  expect(result.prompt).toContain(complexContent)
  expect(result.prompt).toContain('simple content')
  // Exact format with double newline separator
  expect(result.prompt).toBe(`${complexContent}\n\nsimple content`)
})

// Test 13: Empty result list falls back to user message
failed += runTest('empty result list falls back to user message', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Response' },
    { role: 'user', content: 'Second' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(0)
  expect(result.prompt).toBe('Second')
})

// Test 14: Normal user continuation still uses latest user message
failed += runTest('normal user continuation without tool results uses latest user message', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'First message' },
    { role: 'assistant', content: 'First response' },
    { role: 'user', content: 'Second message' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  expect(result.toolResults).toHaveLength(0)
  expect(result.prompt).toBe('Second message')
})

// Test 15: tool_call_id stays out of DeepSeek-Web prompt
failed += runTest('tool_call_id and role metadata not included in DeepSeek-Web prompt', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'user', content: 'Read files' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Result A' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Result B' }
  ]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages)

  const prompt = result.prompt
  // Prompt contains result contents
  if (!prompt.includes('Result A')) throw new Error('Prompt should contain Result A')
  if (!prompt.includes('Result B')) throw new Error('Prompt should contain Result B')
  // Prompt does NOT contain tool_call_ids
  if (prompt.includes('call_1')) throw new Error('Prompt should not contain call_1')
  if (prompt.includes('call_2')) throw new Error('Prompt should not contain call_2')
  // Prompt does NOT contain role markers
  if (prompt.includes('"tool"')) throw new Error('Prompt should not contain "tool"')
  if (prompt.includes('role')) throw new Error('Prompt should not contain role')
  // Only the content with double newline separator
  expect(prompt).toBe('Result A\n\nResult B')
})

console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
if (failed > 0) process.exit(1)