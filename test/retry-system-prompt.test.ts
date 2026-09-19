import { buildDeepSeekPrompt, translateOpenAIRequest, type PromptWithToolResults } from '../src/translator/request.js'
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
    toContain(expected: string) {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}" but got "${actual}"`)
      }
    },
    not: {
      toContain(expected: string) {
        if (typeof actual === 'string' && actual.includes(expected)) {
          throw new Error(`Expected string not to contain "${expected}" but it did`)
        }
      }
    }
  }
  return { ...matchers }
}

console.log('Running Retry & System Prompt Policy Tests...\n')

let failed = 0

// Test 1: sendSystemPrompt=true includes system prompt and tools
failed += runTest('sendSystemPrompt=true includes system prompt and tools', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello' }
  ]
  const tools = [{ type: 'function', function: { name: 'test', description: 'test' } }]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages, tools, true)

  expect(result.prompt).toContain('You are a helpful assistant')
  expect(result.prompt).toContain('Hello')
  expect(result.prompt).toContain('test')
})

// Test 2: sendSystemPrompt=false omits system prompt and tools
failed += runTest('sendSystemPrompt=false omits system prompt and tools', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello' }
  ]
  const tools = [{ type: 'function', function: { name: 'test', description: 'test' } }]

  const result: PromptWithToolResults = buildDeepSeekPrompt(messages, tools, false)

  expect(result.prompt).not.toContain('You are a helpful assistant')
  expect(result.prompt).not.toContain('test')
  expect(result.prompt).toContain('Hello')
})

// Test 3: sendSystemPrompt=undefined defaults to isFirstTurn logic
failed += runTest('sendSystemPrompt=undefined defaults to isFirstTurn logic', () => {
  const messages: OpenAIChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello' }
  ]
  const tools = [{ type: 'function', function: { name: 'test', description: 'test' } }]

  // No assistant messages -> first turn -> should include system
  const result1: PromptWithToolResults = buildDeepSeekPrompt(messages, tools, undefined)
  expect(result1.prompt).toContain('You are a helpful assistant')
  expect(result1.prompt).toContain('test')

  // With assistant message -> not first turn -> should omit system
  const messages2: OpenAIChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'How are you?' }
  ]
  const result2: PromptWithToolResults = buildDeepSeekPrompt(messages2, tools, undefined)
  expect(result2.prompt).not.toContain('You are a helpful assistant')
  expect(result2.prompt).not.toContain('test')
  expect(result2.prompt).toContain('How are you?')
})

// Test 4: translateOpenAIRequest respects sendSystemPrompt=true
failed += runTest('translateOpenAIRequest respects sendSystemPrompt=true', () => {
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt here' },
      { role: 'user', content: 'User message' }
    ],
    tools: [{ type: 'function', function: { name: 'test_tool', description: 'test' } }]
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), true)

  expect(result.prompt).toContain('System prompt here')
  expect(result.prompt).toContain('User message')
  expect(result.prompt).toContain('test_tool')
})

// Test 5: translateOpenAIRequest respects sendSystemPrompt=false
failed += runTest('translateOpenAIRequest respects sendSystemPrompt=false', () => {
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt here' },
      { role: 'user', content: 'User message' }
    ],
    tools: [{ type: 'function', function: { name: 'test_tool', description: 'test' } }]
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), false)

  expect(result.prompt).not.toContain('System prompt here')
  expect(result.prompt).not.toContain('test_tool')
  expect(result.prompt).toContain('User message')
})

// Test 6: simulate turn_count=0 -> sendSystemPrompt=true
failed += runTest('turn_count=0 -> sendSystemPrompt=true', () => {
  const turnCount = 0
  const sendSystemPrompt = turnCount < 2
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain('System prompt')
})

// Test 7: simulate turn_count=1 -> sendSystemPrompt=true
failed += runTest('turn_count=1 -> sendSystemPrompt=true', () => {
  const turnCount = 1
  const sendSystemPrompt = turnCount < 2
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain('System prompt')
})

// Test 8: simulate turn_count=2 -> sendSystemPrompt=false
failed += runTest('turn_count=2 -> sendSystemPrompt=false', () => {
  const turnCount = 2
  const sendSystemPrompt = turnCount < 2
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).not.toContain('System prompt')
  expect(result.prompt).toContain('User message')
})

// Test 9: simulate turn_count=3 -> sendSystemPrompt=false
failed += runTest('turn_count=3 -> sendSystemPrompt=false', () => {
  const turnCount = 3
  const sendSystemPrompt = turnCount < 2
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).not.toContain('System prompt')
  expect(result.prompt).toContain('User message')
})

// Test 10: simulate turn_count=4 -> sendSystemPrompt=false
failed += runTest('turn_count=4 -> sendSystemPrompt=false', () => {
  const turnCount = 4
  const sendSystemPrompt = turnCount < 2
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  const result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).not.toContain('System prompt')
  expect(result.prompt).toContain('User message')
})

// Test 11: Corrective retry at turn_count=0 should use same sendSystemPrompt (true)
failed += runTest('Corrective retry at turn_count=0 uses sendSystemPrompt=true', () => {
  // Simulate initial attempt with turn_count=0
  const turnCount = 0
  const sendSystemPrompt = turnCount < 2 // true
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  // Initial request
  const result1 = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result1.prompt).toContain('System prompt')
  
  // Simulate corrective retry - same sendSystemPrompt value should be used
  req.messages.push({ role: 'user', content: 'Corrective feedback' })
  const result2 = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result2.prompt).toContain('System prompt')
  expect(result2.prompt).toContain('Corrective feedback')
})

// Test 12: Corrective retry at turn_count=2 should use same sendSystemPrompt (false)
// When sendSystemPrompt=false, it picks up the latest user message
failed += runTest('Corrective retry at turn_count=2 uses sendSystemPrompt=false', () => {
  // Simulate initial attempt with turn_count=2
  const turnCount = 2
  const sendSystemPrompt = turnCount < 2 // false
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  // Initial request - sendSystemPrompt=false means it picks the latest user message
  const result1 = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result1.prompt).not.toContain('System prompt')
  expect(result1.prompt).toContain('User message')
  
  // Simulate corrective retry - same sendSystemPrompt value should be used
  // The corrective message is the latest user message now
  req.messages.push({ role: 'user', content: 'Corrective feedback' })
  const result2 = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result2.prompt).not.toContain('System prompt')
  expect(result2.prompt).toContain('Corrective feedback') // latest user message
})

// Test 13: Multiple corrective retries at same turn use same sendSystemPrompt
failed += runTest('Multiple corrective retries at same turn use same sendSystemPrompt', () => {
  const turnCount = 1
  const sendSystemPrompt = turnCount < 2 // true
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  // Initial request
  let result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain('System prompt')
  
  // Retry 1 - corrective message added as user message
  req.messages.push({ role: 'user', content: 'Retry 1' })
  result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain('System prompt')
  expect(result.prompt).toContain('Retry 1') // latest user message
  
  // Retry 2 - another corrective message
  req.messages.push({ role: 'user', content: 'Retry 2' })
  result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain('System prompt')
  expect(result.prompt).toContain('Retry 2') // latest user message
  
  // Retry 3
  req.messages.push({ role: 'user', content: 'Retry 3' })
  result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain('System prompt')
  expect(result.prompt).toContain('Retry 3') // latest user message
})

// Test 14: Corrective message is preserved in messages array
failed += runTest('Corrective message is preserved in messages array for retry', () => {
  const turnCount = 1
  const sendSystemPrompt = turnCount < 2
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' }
    ],
    tools: []
  }

  // Simulate a retry by pushing corrective feedback
  const correctiveMessage = 'Your previous response contained a malformed tool call. Please correct and retry.'
  req.messages.push({ role: 'user', content: correctiveMessage })
  
  const result = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result.prompt).toContain(correctiveMessage)
})

// Test 15: Tool results preserved across retries (non-first-turn behavior)
failed += runTest('Tool results preserved across retries at turn_count>=2', () => {
  const turnCount = 2
  const sendSystemPrompt = turnCount < 2 // false
  
  const req: OpenAIChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Read file' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'File contents here' }
    ],
    tools: []
  }

  // Initial request at turn 3 (turn_count=2)
  const result1 = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  expect(result1.prompt).toBe('File contents here')
  expect(result1.toolResults.length).toBe(1)
  
  // Simulate corrective retry - tool results should still be included
  // But the corrective message is a user message, so it will be the latest user message
  // In non-first-turn mode, it picks trailing tool results first
  req.messages.push({ role: 'user', content: 'Corrective feedback' })
  const result2 = translateOpenAIRequest(req, makeHeaders('session-123'), sendSystemPrompt)
  // Since there's a new user message, and no trailing tool results, it uses the user message
  expect(result2.prompt).toBe('Corrective feedback')
  expect(result2.toolResults.length).toBe(0)
})

console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
if (failed > 0) process.exit(1)