import { buildCompletionRequest, serializeToolResults } from '../src/deepseek_api/completion.js'
import type { DeepSeekConversationState, ToolResult } from '../src/deepseek_api/types.js'

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
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`)
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null but got ${actual}`)
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error('Expected value to be defined')
      }
    },
    toHaveLength(expected: number) {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(`Expected array length ${expected} but got ${actual?.length}`)
      }
    }
  }
  return { ...matchers }
}

console.log('Running DeepSeek API Completion Tests...\n')

let failed = 0

// Test 1: serializeToolResults produces correct JSON
failed += runTest('serializeToolResults produces correct JSON array', () => {
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_123', content: 'Hello world' }
  ]
  const result = serializeToolResults(toolResults)
  expect(result).toEqual('[{"role":"tool","tool_call_id":"call_123","content":"Hello world"}]')
})

// Test 2: serializeToolResults with multiple results preserves order
failed += runTest('serializeToolResults with multiple results preserves order', () => {
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_1', content: 'First result' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Second result' }
  ]
  const result = serializeToolResults(toolResults)
  expect(result).toEqual('[{"role":"tool","tool_call_id":"call_1","content":"First result"},{"role":"tool","tool_call_id":"call_2","content":"Second result"}]')
})

// Test 3: serializeToolResults preserves exact content including whitespace/newlines/XML
failed += runTest('serializeToolResults preserves exact content including whitespace/newlines/XML', () => {
  const contentWithWhitespace = '  leading\nmiddle\n  trailing  '
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_1', content: contentWithWhitespace }
  ]
  const result = serializeToolResults(toolResults)
  // Parse back and check content is preserved exactly
  const parsed = JSON.parse(result)
  expect(parsed[0].content).toBe(contentWithWhitespace)
})

// Test 4: serializeToolResults preserves XML-like content exactly
failed += runTest('serializeToolResults preserves XML-like content exactly', () => {
  const xmlContent = '<path>C:\\Users\\Damas\\CoDeep-proxy</path><type>directory</type><entries>...</entries>'
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_1', content: xmlContent }
  ]
  const result = serializeToolResults(toolResults)
  // Parse back and check content is preserved exactly
  const parsed = JSON.parse(result)
  expect(parsed[0].content).toBe(xmlContent)
})

// Test 5: buildCompletionRequest with toolResults serializes into prompt
failed += runTest('buildCompletionRequest with toolResults serializes into prompt', () => {
  const state: DeepSeekConversationState = {
    chat_session_id: 'session-123',
    parent_message_id: 456,
  }
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_123', content: 'Tool result content' }
  ]
  const request = buildCompletionRequest(state, 'fallback prompt', {
    model_type: 'expert',
    thinking_enabled: true,
    search_enabled: false,
    toolResults,
  })
  // The prompt should be the serialized tool results, not the fallback prompt
  expect(request.prompt).toEqual('[{"role":"tool","tool_call_id":"call_123","content":"Tool result content"}]')
})

// Test 5b: buildCompletionRequest with multiple toolResults preserves all
failed += runTest('buildCompletionRequest with multiple toolResults preserves all', () => {
  const state: DeepSeekConversationState = {
    chat_session_id: 'session-123',
    parent_message_id: 456,
  }
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_1', content: 'First' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Second' }
  ]
  const request = buildCompletionRequest(state, 'fallback', {
    model_type: 'expert',
    thinking_enabled: true,
    search_enabled: false,
    toolResults,
  })
  expect(request.prompt).toEqual('[{"role":"tool","tool_call_id":"call_1","content":"First"},{"role":"tool","tool_call_id":"call_2","content":"Second"}]')
})

// Test 6: buildCompletionRequest without toolResults uses original prompt
failed += runTest('buildCompletionRequest without toolResults uses original prompt', () => {
  const state: DeepSeekConversationState = {
    chat_session_id: 'session-123',
    parent_message_id: 456,
  }
  const request = buildCompletionRequest(state, 'original prompt content', {
    model_type: 'expert',
    thinking_enabled: true,
    search_enabled: false,
  })
  expect(request.prompt).toBe('original prompt content')
})

// Test 7: buildCompletionRequest with empty toolResults array uses original prompt
failed += runTest('buildCompletionRequest with empty toolResults array uses original prompt', () => {
  const state: DeepSeekConversationState = {
    chat_session_id: 'session-123',
    parent_message_id: 456,
  }
  const request = buildCompletionRequest(state, 'original prompt content', {
    model_type: 'expert',
    thinking_enabled: true,
    search_enabled: false,
    toolResults: [],
  })
  expect(request.prompt).toBe('original prompt content')
})

// Test 8: buildCompletionRequest with undefined toolResults uses original prompt
failed += runTest('buildCompletionRequest with undefined toolResults uses original prompt', () => {
  const state: DeepSeekConversationState = {
    chat_session_id: 'session-123',
    parent_message_id: 456,
  }
  const request = buildCompletionRequest(state, 'original prompt content', {
    model_type: 'expert',
    thinking_enabled: true,
    search_enabled: false,
  })
  expect(request.prompt).toBe('original prompt content')
})

// Test 9: buildCompletionRequest preserves other fields correctly
failed += runTest('buildCompletionRequest preserves other fields correctly', () => {
  const state: DeepSeekConversationState = {
    chat_session_id: 'session-123',
    parent_message_id: 456,
  }
  const toolResults: ToolResult[] = [
    { role: 'tool', tool_call_id: 'call_123', content: 'Test' }
  ]
  const request = buildCompletionRequest(state, 'ignored', {
    model_type: 'default',
    thinking_enabled: false,
    search_enabled: true,
    toolResults,
  })
  expect(request.chat_session_id).toBe('session-123')
  expect(request.parent_message_id).toBe(456)
  expect(request.model_type).toBe('default')
  expect(request.thinking_enabled).toBe(false)
  expect(request.search_enabled).toBe(true)
  expect(request.action).toBeNull()
  expect(request.preempt).toBe(false)
  expect(request.ref_file_ids).toEqual([])
})

console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
if (failed > 0) process.exit(1)