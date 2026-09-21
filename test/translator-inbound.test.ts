import {
  translateParserEventsToSSE,
  translateParserEventsToJSON,
  formatOpenAISSEChunk,
  formatOpenAIDone,
  type SSEParseResult,
} from '../src/translator/inbound.js'
import { parseDeepSeekSSE } from '../src/parser/index.js'
import { parseDSMLToolCalls, buildCorrectiveMessage, ALL_DIALECTS, DSML_CORRECTIVE_MESSAGE_TEMPLATE, type DSMLParseResult } from '../src/parser/dsml.js'

import { readFileSync } from 'fs'
import { resolve, extname } from 'path'

function readFile(filePath: string): string {
  return readFileSync(resolve(process.cwd(), filePath), 'utf-8')
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

type TranslationAttemptResult<T> =
  | { kind: 'success'; result: T }
  | { kind: 'retry'; correction: string; error: { message: string; syntaxRules: string } }

async function translateDeepSeekStreamToSSE(stream: ReadableStream<Uint8Array>, info: { model: string; id: string; created: number }) {
  return translateParserEventsToSSE(parseDeepSeekSSE(stream), info)
}

async function translateDeepSeekStreamToJSON(stream: ReadableStream<Uint8Array>, info: { model: string; id: string; created: number }) {
  return translateParserEventsToJSON(parseDeepSeekSSE(stream), info)
}

async function translateDeepSeekStreamToSSEAttempt(stream: ReadableStream<Uint8Array>, info: { model: string; id: string; created: number }): Promise<TranslationAttemptResult<Awaited<ReturnType<typeof translateDeepSeekStreamToSSE>>>> {
  const result = await translateDeepSeekStreamToSSE(stream, info)
  return result.parseError
    ? { kind: 'retry', correction: result.parseError.syntaxRules, error: result.parseError }
    : { kind: 'success', result }
}

async function translateDeepSeekStreamToJSONAttempt(stream: ReadableStream<Uint8Array>, info: { model: string; id: string; created: number }): Promise<TranslationAttemptResult<Awaited<ReturnType<typeof translateDeepSeekStreamToJSON>>>> {
  const result = await translateDeepSeekStreamToJSON(stream, info)
  return result._malformedError
    ? { kind: 'retry', correction: result._malformedError.syntaxRules, error: result._malformedError }
    : { kind: 'success', result }
}

function createByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
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

async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<string> {
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

// Extract all content/reasoning_content from SSE output
function extractSSEContent(output: string): { content: string; reasoning: string } {
  const lines = output.split('\n')
  let content = ''
  let reasoning = ''
  for (const line of lines) {
    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
      try {
        const json = JSON.parse(line.slice(6))
        const delta = json.choices?.[0]?.delta
        if (delta?.content) content += delta.content
        if (delta?.reasoning_content) reasoning += delta.reasoning_content
      } catch { }
    }
  }
  return { content, reasoning }
}

function runTest(name: string, fn: () => void | Promise<void>): boolean {
  try {
    const result = fn()
    if (result instanceof Promise) return true
    console.log(`✓ ${name}`)
    return false
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    return true
  }
}

async function runTestAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
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
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`)
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
    toBeDefined() { if (actual === undefined) throw new Error('Expected value to be defined') },
    toBeUndefined() { if (actual !== undefined) throw new Error(`Expected undefined but got ${actual}`) },
    toBeNull() { if (actual !== null) throw new Error(`Expected null but got ${actual}`) },
    toBeTruthy() { if (!actual) throw new Error('Expected truthy value') },
    toBeFalsy() { if (actual) throw new Error('Expected falsy value') },
    toBeGreaterThan(expected: number) {
      if (typeof actual !== 'number' || actual <= expected) {
        throw new Error(`Expected number > ${expected} but got ${actual}`)
      }
    },
  }
  return { ...matchers, not: {
    toContain(expected: string) {
      if (typeof actual === 'string' && actual.includes(expected)) {
        throw new Error(`Expected string not to contain "${expected}" but it did`)
      }
    },
    toBe(expected: T) { if (actual === expected) throw new Error(`Expected not ${expected} but got ${actual}`) },
    toBeNull() { if (actual === null) throw new Error(`Expected not null but got null`) },
    toBeUndefined() { if (actual === undefined) throw new Error('Expected value to not be undefined') },
    toHaveLength(expected: number) { if (Array.isArray(actual) && actual.length === expected) throw new Error(`Expected array length not ${expected} but got ${actual.length}`) },
    toBeDefined() { if (actual !== undefined) throw new Error('Expected value to be undefined') },
  }}
}

function getTsFiles(dir: string): string[] {
  const files: string[] = []
  const fs = require('fs')
  const entries = fs.readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...getTsFiles(fullPath))
    else if (extname(entry.name) === '.ts') files.push(fullPath)
  }
  return files
}

async function main() {
  console.log('Running Translator Inbound Independent Tests...\n')
  let failed = 0
  const info = { model: 'test-model', id: 'chatcmpl-test', created: Math.floor(Date.now() / 1000) }

  // ============================================================
  // 1. Normal text response (streaming SSE)
  // ============================================================
  console.log('\n--- 1. Normal text response (streaming SSE) ---\n')

  failed += await runTestAsync('normal text response produces SSE stream with content and [DONE]', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 123 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Hello' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' world' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    expect(result.parseError).toBeNull()
    const output = await consumeStream(result.stream)
    const { content } = extractSSEContent(output)
    expect(content).toBe('Hello world')
    expect(output).toContain('[DONE]')
    expect(output).toContain('"role":"assistant"')
    expect(output).toContain('"finish_reason":"stop"')
  })

  failed += await runTestAsync('normal text response stream can be fully consumed', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 123 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Test' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' content' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const chunks = output.split('\n\n').filter(c => c.trim())
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[chunks.length - 1].trim()).toBe('data: [DONE]')
  })

  // ============================================================
  // 2. Non-streaming JSON response
  // ============================================================
  console.log('\n--- 2. Non-streaming JSON response ---\n')

  failed += await runTestAsync('non-streaming JSON response contains assistant content and completion structure', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 456 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'JSON response' }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToJSON(stream, info)
    expect(result.choices[0].message.role).toBe('assistant')
    expect(result.choices[0].message.content).toBe('JSON response')
    expect(result.choices[0].finish_reason).toBe('stop')
    expect(result.id).toContain('chatcmpl-')
    expect(result.object).toBe('chat.completion')
    expect(result.usage).toBeDefined()
    expect(result._malformedError).toBeUndefined()
  })

  // ============================================================
  // 3. Valid DSML tool call
  // ============================================================
  console.log('\n--- 3. Valid DSML tool call ---\n')

  failed += await runTestAsync('valid DSML tool call produces tool_calls in SSE stream', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 789 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read_file">' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    expect(result.parseError).toBeNull()
    const output = await consumeStream(result.stream)
    expect(output).toContain('"tool_calls"')
    expect(output).toContain('"name":"read_file"')
    expect(output).toContain('filePath')
    expect(output).toContain('README.md')
    expect(output).toContain('"finish_reason":"tool_calls"')
  })

  failed += await runTestAsync('valid DSML tool call produces tool_calls in JSON response', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 789 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read_file">' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToJSON(stream, info)
    expect(result.choices[0].message.tool_calls).toBeDefined()
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
    expect(result.choices[0].message.tool_calls[0].function.name).toBe('read_file')
    expect(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).filePath).toBe('README.md')
    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.choices[0].message.content).toBeNull()
  })

  // ============================================================
  // 4. Multiple supported DSML dialects
  // ============================================================
  console.log('\n--- 4. Multiple supported DSML dialects ---\n')

  const dialectTests = [
    { name: 'double/full-width delimiter', openCalls: '<｜｜DSML｜｜ calls>', closeCalls: '</｜｜DSML｜｜ calls>', openInvoke: '<｜｜DSML｜｜ invoke', closeInvoke: '</｜｜DSML｜｜ invoke>', openParam: '<｜｜DSML｜｜ parameter', closeParam: '</｜｜DSML｜｜ parameter>' },
    { name: 'single delimiter', openCalls: '<｜DSML｜ calls>', closeCalls: '</｜DSML｜ calls>', openInvoke: '<｜DSML｜ invoke', closeInvoke: '</｜DSML｜ invoke>', openParam: '<｜DSML｜ parameter', closeParam: '</｜DSML｜ parameter>' },
    { name: 'mixed delimiter', openCalls: '<｜DSML｜｜ calls>', closeCalls: '</｜DSML｜｜ calls>', openInvoke: '<｜DSML｜｜ invoke', closeInvoke: '</｜DSML｜｜ invoke>', openParam: '<｜DSML｜｜ parameter', closeParam: '</｜DSML｜｜ parameter>' },
    { name: 'ASCII delimiter', openCalls: '<||DSML||calls>', closeCalls: '</||DSML||calls>', openInvoke: '<||DSML||invoke', closeInvoke: '</||DSML||invoke>', openParam: '<||DSML||parameter', closeParam: '</||DSML||parameter>' },
  ]

  for (const dialect of dialectTests) {
    failed += await runTestAsync(`valid DSML with ${dialect.name} parses correctly in SSE`, async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 100 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: dialect.openCalls }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: `${dialect.openInvoke} name="test">` }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: `${dialect.openParam} name="arg" string="true">value${dialect.closeParam}` }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: dialect.closeInvoke }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: dialect.closeCalls }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const result = await translateDeepSeekStreamToSSE(stream, info)
      expect(result.parseError).toBeNull()
      const output = await consumeStream(result.stream)
      expect(output).toContain('"tool_calls"')
      expect(output).toContain('"name":"test"')
      expect(output).toContain('arg')
      expect(output).toContain('value')
    })

    failed += await runTestAsync(`valid DSML with ${dialect.name} parses correctly in JSON`, async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 100 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: dialect.openCalls }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: `${dialect.openInvoke} name="test">` }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: `${dialect.openParam} name="arg" string="true">value${dialect.closeParam}` }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: dialect.closeInvoke }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: dialect.closeCalls }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const result = await translateDeepSeekStreamToJSON(stream, info)
      expect(result.choices[0].message.tool_calls).toHaveLength(1)
      expect(result.choices[0].message.tool_calls[0].function.name).toBe('test')
      expect(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).arg).toBe('value')
    })
  }

  // ============================================================
  // 5. Malformed DSML → retry signal
  // ============================================================
  console.log('\n--- 5. Malformed DSML → retry signal ---\n')

  const malformedFixtures = [
    { 
      name: 'missing closing calls tag', 
      sseInput: [
        makeSSEEvent('ready', { response_message_id: 1 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ],
      expectedErrorMsg: 'Missing closing'
    },
    { 
      name: 'parameter outside invoke', 
      sseInput: [
        makeSSEEvent('ready', { response_message_id: 2 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ],
      expectedErrorMsg: 'Parameter found outside'
    },
    { 
      name: 'mismatched invoke tags', 
      sseInput: [
        makeSSEEvent('ready', { response_message_id: 3 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ],
      expectedErrorMsg: 'Mismatched <invoke> tags'
    },
    { 
      name: 'invalid element under calls', 
      sseInput: [
        makeSSEEvent('ready', { response_message_id: 4 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invalid>bad</｜｜DSML｜｜ invalid>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ],
      expectedErrorMsg: 'Invalid DSML element'
    },
    { 
      name: 'empty calls block', 
      sseInput: [
        makeSSEEvent('ready', { response_message_id: 5 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
        makeSSEEvent('close', {}),
      ],
      expectedErrorMsg: 'must contain at least one'
    },
  ]

  for (const fixture of malformedFixtures) {
    failed += await runTestAsync(`malformed DSML (${fixture.name}) → SSE attempt returns retry with correction`, async () => {
      const stream = createSSEStream(fixture.sseInput)
      const result = await translateDeepSeekStreamToSSEAttempt(stream, info)
      expect(result.kind).toBe('retry')
      if (result.kind === 'retry') {
        expect(result.correction).toBeDefined()
        expect(result.correction).toContain('Your previous response contained a malformed tool call')
        expect(result.error.message).toContain(fixture.expectedErrorMsg)
        expect(result.error.syntaxRules).toBeDefined()
        expect(result.correction).toBe(result.error.syntaxRules)
      }
    })

    failed += await runTestAsync(`malformed DSML (${fixture.name}) → JSON attempt returns retry with correction`, async () => {
      const stream = createSSEStream(fixture.sseInput)
      const result = await translateDeepSeekStreamToJSONAttempt(stream, info)
      expect(result.kind).toBe('retry')
      if (result.kind === 'retry') {
        expect(result.correction).toBeDefined()
        expect(result.correction).toContain('Your previous response contained a malformed tool call')
        expect(result.error.message).toContain(fixture.expectedErrorMsg)
        expect(result.error.syntaxRules).toBeDefined()
        expect(result.correction).toBe(result.error.syntaxRules)
      }
    })
  }

  // ============================================================
  // 6. Valid response → success signal
  // ============================================================
  console.log('\n--- 6. Valid response → success signal ---\n')

  failed += await runTestAsync('valid text response → SSE attempt returns success', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 100 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Valid response' }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSEAttempt(stream, info)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.result.parseError).toBeNull()
      const output = await consumeStream(result.result.stream)
      const { content } = extractSSEContent(output)
      expect(content).toBe('Valid response')
      expect(output).toContain('[DONE]')
    }
  })

  failed += await runTestAsync('valid text response → JSON attempt returns success', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 101 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Valid JSON response' }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToJSONAttempt(stream, info)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.result.choices[0].message.content).toBe('Valid JSON response')
      expect(result.result._malformedError).toBeUndefined()
    }
  })

  failed += await runTestAsync('valid DSML response → SSE attempt returns success with tool_calls', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 102 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="test">' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="arg" string="true">value</｜｜DSML｜｜ parameter>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSEAttempt(stream, info)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.result.parseError).toBeNull()
      const output = await consumeStream(result.result.stream)
      expect(output).toContain('"tool_calls"')
      expect(output).toContain('"name":"test"')
    }
  })

  failed += await runTestAsync('valid DSML response → JSON attempt returns success with tool_calls', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 103 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="test">' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="arg" string="true">value</｜｜DSML｜｜ parameter>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToJSONAttempt(stream, info)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.result.choices[0].message.tool_calls).toHaveLength(1)
      expect(result.result._malformedError).toBeUndefined()
    }
  })

  // ============================================================
  // 7. Chunk-boundary independence
  // ============================================================
  console.log('\n--- 7. Chunk-boundary independence ---\n')

  failed += await runTestAsync('tiny chunks split across SSE lines produce same result', async () => {
    const normalSseInput = [
      makeSSEEvent('ready', { response_message_id: 200 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Hello world' }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const normalStream = createSSEStream(normalSseInput)
    const normalResult = await translateDeepSeekStreamToSSE(normalStream, info)
    const normalOutput = await consumeStream(normalResult.stream)
    const normalContent = extractSSEContent(normalOutput).content

    const fullSseString = normalSseInput.join('')
    const tinyChunks: string[] = []
    for (let i = 0; i < fullSseString.length; i += 3) tinyChunks.push(fullSseString.slice(i, i + 3))
    const tinyStream = createByteStream(tinyChunks.map(s => new TextEncoder().encode(s)))
    const tinyResult = await translateDeepSeekStreamToSSE(tinyStream, info)
    const tinyOutput = await consumeStream(tinyResult.stream)
    const tinyContent = extractSSEContent(tinyOutput).content

    expect(tinyContent).toBe(normalContent)
    expect(tinyOutput).toContain('[DONE]')
  })

  failed += await runTestAsync('tiny chunks split inside DSML tags produce same result', async () => {
    const normalSseInput = [
      makeSSEEvent('ready', { response_message_id: 201 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="test">' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="arg" string="true">value</｜｜DSML｜｜ parameter>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const normalStream = createSSEStream(normalSseInput)
    const normalResult = await translateDeepSeekStreamToSSE(normalStream, info)
    const normalOutput = await consumeStream(normalResult.stream)

    const fullSseString = normalSseInput.join('')
    const tinyChunks: string[] = []
    for (let i = 0; i < fullSseString.length; i += 5) tinyChunks.push(fullSseString.slice(i, i + 5))
    const tinyStream = createByteStream(tinyChunks.map(s => new TextEncoder().encode(s)))
    const tinyResult = await translateDeepSeekStreamToSSE(tinyStream, info)
    const tinyOutput = await consumeStream(tinyResult.stream)

    expect(tinyOutput).toContain('"name":"test"')
    expect(normalOutput).toContain('"name":"test"')
    expect(tinyOutput).toContain('arg')
    expect(normalOutput).toContain('arg')
    expect(tinyOutput).toContain('value')
    expect(normalOutput).toContain('value')
    expect(tinyOutput).toContain('[DONE]')
    expect(normalOutput).toContain('[DONE]')
  })

  failed += await runTestAsync('tiny chunks split inside JSON payload boundaries produce same result', async () => {
    const normalSseInput = [
      makeSSEEvent('ready', { response_message_id: 202 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'JSON test' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' more' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const normalStream = createSSEStream(normalSseInput)
    const normalResult = await translateDeepSeekStreamToSSE(normalStream, info)
    const normalOutput = await consumeStream(normalResult.stream)
    const normalContent = extractSSEContent(normalOutput).content

    const fullSseString = normalSseInput.join('')
    const tinyChunks: string[] = []
    for (let i = 0; i < fullSseString.length; i += 7) tinyChunks.push(fullSseString.slice(i, i + 7))
    const tinyStream = createByteStream(tinyChunks.map(s => new TextEncoder().encode(s)))
    const tinyResult = await translateDeepSeekStreamToSSE(tinyStream, info)
    const tinyOutput = await consumeStream(tinyResult.stream)
    const tinyContent = extractSSEContent(tinyOutput).content

    expect(tinyContent).toBe(normalContent)
    expect(tinyOutput).toContain('[DONE]')
  })

  // ============================================================
  // 8. Full stream consumption
  // ============================================================
  console.log('\n--- 8. Full stream consumption ---\n')

  failed += await runTestAsync('inbound translator consumes complete upstream stream', async () => {
    let readCount = 0
    const chunks = [
      makeSSEEvent('ready', { response_message_id: 300 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Counted' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' stream' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const countingStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (readCount < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[readCount++]))
        } else {
          controller.close()
        }
      },
    })

    const result = await translateDeepSeekStreamToSSE(countingStream, info)
    const output = await consumeStream(result.stream)
    expect(readCount).toBe(5)
    const { content } = extractSSEContent(output)
    expect(content).toBe('Counted stream')
    expect(output).toContain('[DONE]')
  })

  // ============================================================
  // 9. Corrective message generation
  // ============================================================
  console.log('\n--- 9. Corrective message generation ---\n')

  failed += runTest('buildCorrectiveMessage inserts error into template', () => {
    const error = 'Missing closing </｜｜DSML｜｜ calls> tag'
    const msg = buildCorrectiveMessage(error)
    expect(msg).toContain(error)
    expect(msg).not.toContain('{{PARSER_ERROR}}')
  })

  failed += runTest('buildCorrectiveMessage produces delimiter-neutral message', () => {
    const msg = buildCorrectiveMessage('test error')
    expect(msg).not.toContain('<｜｜DSML｜｜')
    expect(msg).not.toContain('<||DSML||')
    expect(msg).not.toContain('<｜DSML｜')
  })

  failed += runTest('buildCorrectiveMessage produces exact template structure', () => {
    const msg = buildCorrectiveMessage('parser error here')
    expect(msg).toContain('Your previous response contained a malformed tool call.')
    expect(msg).toContain('The tool call was NOT executed.')
    expect(msg).toContain('Parsing error:')
    expect(msg).toContain('parser error here')
    expect(msg).toContain('Please correct the structural error and retry the tool call.')
  })

  failed += runTest('DSML_CORRECTIVE_MESSAGE_TEMPLATE is exported and correct', () => {
    expect(DSML_CORRECTIVE_MESSAGE_TEMPLATE).toContain('{{PARSER_ERROR}}')
    expect(DSML_CORRECTIVE_MESSAGE_TEMPLATE).toContain('Your previous response contained a malformed tool call.')
    expect(DSML_CORRECTIVE_MESSAGE_TEMPLATE).toContain('The tool call was NOT executed.')
    expect(DSML_CORRECTIVE_MESSAGE_TEMPLATE).not.toContain('Rules:')
    expect(DSML_CORRECTIVE_MESSAGE_TEMPLATE).not.toContain('<calls>')
    expect(DSML_CORRECTIVE_MESSAGE_TEMPLATE).not.toContain('<invoke')
  })

  failed += runTest('malformed parse error syntaxRules equals corrective message', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.error).toBeDefined()
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  // ============================================================
  // 10. DSML parser direct contract
  // ============================================================
  console.log('\n--- 10. DSML parser direct contract ---\n')

  failed += runTest('parseDSMLToolCalls returns empty toolCalls for normal text', () => {
    const result = parseDSMLToolCalls('Hello, this is normal text without DSML.')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.isMalformed).toBeFalsy()
    expect(result.error).toBeUndefined()
  })

  failed += runTest('parseDSMLToolCalls returns empty toolCalls for DSML-like but incomplete text', () => {
    const result = parseDSMLToolCalls('This has <｜｜DSML｜｜ but not complete')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.isMalformed).toBeFalsy()
    expect(result.error).toBeUndefined()
  })

  failed += runTest('parseDSMLToolCalls parses valid DSML with tool calls', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBeFalsy()
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('read_file')
    expect(JSON.parse(result.toolCalls[0].function.arguments).filePath).toBe('README.md')
  })

  failed += runTest('parseDSMLToolCalls parses multiple valid invokes', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">a.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="write">
<｜｜DSML｜｜ parameter name="content" string="true">hello</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBeFalsy()
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].function.name).toBe('read')
    expect(result.toolCalls[1].function.name).toBe('write')
  })

  failed += runTest('parseDSMLToolCalls detects malformed - parameter outside invoke', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('Parameter found outside')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - missing closing calls tag', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('Missing closing')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - mismatched invoke tags', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('Mismatched <invoke> tags')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - invalid element', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid>bad</｜｜DSML｜｜ invalid>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('Invalid DSML element')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - empty calls block', () => {
    const xml = `<｜｜DSML｜｜ calls>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('must contain at least one')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - missing parameter closing tag', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('missing closing')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - parameter missing string attribute', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="value">test</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('string=')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls detects malformed - invalid JSON for string=false', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="count" string="false">not-json</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBe(true)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('not valid JSON')
    expect(result.error!.syntaxRules).toBe(buildCorrectiveMessage(result.error!.message))
  })

  failed += runTest('parseDSMLToolCalls handles string="true" preserves whitespace', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="message" string="true">  hello  </｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBeFalsy()
    expect(result.toolCalls).toHaveLength(1)
    expect(JSON.parse(result.toolCalls[0].function.arguments).message).toBe('  hello  ')
  })

  failed += runTest('parseDSMLToolCalls handles string="false" parses JSON types', () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="count" string="false">42</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="enabled" string="false">true</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="config" string="false">{"a":1}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    const result = parseDSMLToolCalls(xml)
    expect(result.isMalformed).toBeFalsy()
    expect(result.toolCalls).toHaveLength(1)
    const args = JSON.parse(result.toolCalls[0].function.arguments)
    expect(args.count).toBe(42)
    expect(args.enabled).toBe(true)
    expect(args.config).toEqual({ a: 1 })
  })

  // ============================================================
  // Independence verification (source inspection of production code)
  // ============================================================
  console.log('\n--- Independence verification (source inspection) ---\n')

  failed += runTest('inbound.ts does not import from translator/outbound', () => {
    const content = readFile('src/translator/inbound.ts')
    if (content.includes('../translator/outbound') || content.includes('./outbound')) {
      throw new Error('inbound.ts imports from outbound')
    }
  })

  failed += runTest('inbound.ts does not import from translator' + '/' + 'request', () => {
    const content = readFile('src/translator/inbound.ts')
    const f1 = 'translator'
    const f2 = 'request'
    if (content.includes(f1 + '/' + f2) || content.includes('../' + f1 + '/' + f2) || content.includes('./' + f2)) {
      throw new Error('inbound.ts imports from ' + f1 + '/' + f2)
    }
  })

  failed += runTest('inbound.ts does not import from orchestrator', () => {
    const content = readFile('src/translator/inbound.ts')
    if (content.includes('orchestrator')) {
      throw new Error('inbound.ts imports orchestrator')
    }
  })

  failed += runTest('inbound.ts does not import from deepseek_api/client', () => {
    const content = readFile('src/translator/inbound.ts')
    if (content.includes('deepseek_api/client')) {
      throw new Error('inbound.ts imports deepseek_api/client')
    }
  })

  failed += runTest('inbound.ts does not import from src/index', () => {
    const content = readFile('src/translator/inbound.ts')
    if (content.includes('src/index') || content.includes('../index') || content.includes('./index')) {
      throw new Error('inbound.ts imports src/index')
    }
  })

  // Verify ALL_DIALECTS is exported and contains expected dialects
  failed += runTest('ALL_DIALECTS exported and contains 4 delimiter families × 5 wrappers × 2 spacing', () => {
    expect(ALL_DIALECTS).toBeDefined()
    expect(ALL_DIALECTS.length).toBe(40)
    const delimiters = new Set(ALL_DIALECTS.map(d => d.delimiter))
    expect(delimiters.size).toBe(4)
    expect(delimiters.has('double')).toBe(true)
    expect(delimiters.has('single')).toBe(true)
    expect(delimiters.has('mixed')).toBe(true)
    expect(delimiters.has('ascii')).toBe(true)
  })

  // ============================================================
  // Additional edge cases
  // ============================================================
  console.log('\n--- Additional edge cases ---\n')

  failed += await runTestAsync('thinking fragment (THINK type) produces reasoning_content', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 400 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: 'Let me think' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' about this' }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' and then respond' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const { reasoning } = extractSSEContent(output)
    expect(reasoning).toBe('Let me think about this and then respond')
    expect(output).toContain('[DONE]')
  })

  failed += await runTestAsync('thinking followed by response fragment transition works', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 401 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: 'Thinking' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'Now responding' }] }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' with content' }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const { content, reasoning } = extractSSEContent(output)
    expect(reasoning).toBe('Thinking')
    expect(content).toBe('Now responding with content')
    expect(output).toContain('[DONE]')
  })

  failed += await runTestAsync('token usage captured and emitted in SSE', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 500 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Token test' }] } } }),
      makeSSEEvent('p', { p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 42 }] }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    expect(output).toContain('"usage"')
    expect(output).toContain('"completion_tokens":42')
    expect(output).toContain('"total_tokens":42')
  })

  failed += await runTestAsync('token usage captured and emitted in JSON', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 501 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Token test' }] } } }),
      makeSSEEvent('p', { p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 42 }] }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToJSON(stream, info)
    expect(result.usage.completion_tokens).toBe(42)
    expect(result.usage.total_tokens).toBe(42)
  })

  // ============================================================
  // THINK/RESPONSE semantic boundary regression tests
  // ============================================================
  console.log('\n--- THINK/RESPONSE semantic boundary ---\n')

  const validDSMLToolCall = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

  failed += await runTestAsync('THINK fragment containing valid DSML structure produces reasoning only (no tool calls)', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 600 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: validDSMLToolCall }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const { content, reasoning } = extractSSEContent(output)
    expect(reasoning).toBe(validDSMLToolCall)
    expect(content).toBe('')
    expect(output).not.toContain('tool_calls')
    expect(output).toContain('[DONE]')
    expect(result.parseError).toBeNull()
  })

  failed += await runTestAsync('THINK fragment containing malformed DSML produces reasoning only (no parser error)', async () => {
    const malformedDSML = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 601 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: malformedDSML }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const { content, reasoning } = extractSSEContent(output)
    expect(reasoning).toBe(malformedDSML)
    expect(content).toBe('')
    expect(output).not.toContain('tool_calls')
    expect(output).toContain('[DONE]')
    expect(result.parseError).toBeNull()
  })

  failed += await runTestAsync('THINK fragment with DSML-like text produces reasoning only', async () => {
    const thinkContent = 'Let me think about this <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="test"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls> and then respond'
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 602 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: thinkContent }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const { content, reasoning } = extractSSEContent(output)
    expect(reasoning).toBe(thinkContent)
    expect(content).toBe('')
    expect(output).not.toContain('tool_calls')
    expect(result.parseError).toBeNull()
  })

  failed += await runTestAsync('THINK fragment with DSML produces no retry in JSON mode', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 603 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: validDSMLToolCall }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToJSONAttempt(stream, info)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.result.choices[0].message.reasoning_content).toBe(validDSMLToolCall)
      expect(result.result.choices[0].message.content).toBe('')
      expect(result.result.choices[0].message.tool_calls).toBeUndefined()
      expect(result.result._malformedError).toBeUndefined()
    }
  })

  failed += await runTestAsync('RESPONSE fragment with valid DSML still produces tool_calls', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 604 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: validDSMLToolCall }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    expect(output).toContain('tool_calls')
    expect(output).toContain('read_file')
    expect(output).toContain('README.md')
    expect(result.parseError).toBeNull()
  })

  failed += await runTestAsync('RESPONSE normal text produces content (no tool calls)', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 605 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Normal response text' }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream = createSSEStream(sseInput)
    const result = await translateDeepSeekStreamToSSE(stream, info)
    const output = await consumeStream(result.stream)
    const { content, reasoning } = extractSSEContent(output)
    expect(content).toBe('Normal response text')
    expect(reasoning).toBe('')
    expect(output).not.toContain('tool_calls')
    expect(result.parseError).toBeNull()
  })

  failed += await runTestAsync('streaming and non-streaming use same parser for THINK DSML', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 606 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'THINK', content: validDSMLToolCall }] } } }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream1 = createSSEStream(sseInput)
    const stream2 = createSSEStream(sseInput)
    const sseResult = await translateDeepSeekStreamToSSE(stream1, info)
    const jsonResult = await translateDeepSeekStreamToJSON(stream2, info)
    const sseOutput = await consumeStream(sseResult.stream)
    const { content: sseContent, reasoning: sseReasoning } = extractSSEContent(sseOutput)
    expect(sseReasoning).toBe(validDSMLToolCall)
    expect(sseContent).toBe('')
    expect(jsonResult.choices[0].message.reasoning_content).toBe(validDSMLToolCall)
    expect(jsonResult.choices[0].message.content).toBe('')
    expect(jsonResult.choices[0].message.tool_calls).toBeUndefined()
  })

  failed += await runTestAsync('streaming and non-streaming use same parser for RESPONSE DSML', async () => {
    const sseInput = [
      makeSSEEvent('ready', { response_message_id: 607 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: validDSMLToolCall }),
      makeSSEEvent('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }),
      makeSSEEvent('close', {}),
    ]
    const stream1 = createSSEStream(sseInput)
    const stream2 = createSSEStream(sseInput)
    const sseResult = await translateDeepSeekStreamToSSE(stream1, info)
    const jsonResult = await translateDeepSeekStreamToJSON(stream2, info)
    const sseOutput = await consumeStream(sseResult.stream)
    expect(sseOutput).toContain('tool_calls')
    expect(jsonResult.choices[0].message.tool_calls).toBeDefined()
    expect(jsonResult.choices[0].message.tool_calls).toHaveLength(1)
    expect(jsonResult.choices[0].message.tool_calls[0].function.name).toBe('read_file')
  })

  console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
  if (failed > 0) process.exit(1)
}

main()