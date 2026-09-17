import { parseDSMLToolCalls, CORRECTIVE_MESSAGE, type DSMLParseResult, translateDeepSeekStreamToSSE } from '../src/translator/response.js'

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

function makeSSEEventBytes(event: string, data: object): Uint8Array {
  return new TextEncoder().encode(makeSSEEvent(event, data))
}

function makeSSEDataBytes(data: object): Uint8Array {
  return new TextEncoder().encode(makeSSEData(data))
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

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`✓ ${name}`)
    return true
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    return false
  }
}

async function runTestsSequentially(tests: Array<{ name: string; fn: () => Promise<void> }>) {
  let failed = 0
  for (const { name, fn } of tests) {
    const passed = await runTest(name, fn)
    if (!passed) failed++
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
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null but got ${actual}`)
      }
    },
    toBeTruthy() {
      if (!actual) {
        throw new Error('Expected truthy value')
      }
    },
    toBeFalsy() {
      if (actual) {
        throw new Error('Expected falsy value')
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
    toHaveLength(expected: number) {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(`Expected array length ${expected} but got ${actual?.length}`)
      }
    }
  }
  return {
    ...matchers,
    not: {
      toBe(expected: T) {
        if (actual === expected) {
          throw new Error(`Expected not ${expected} but got ${actual}`)
        }
      },
      toBeNull() {
        if (actual === null) {
          throw new Error(`Expected not null but got null`)
        }
      },
      toBeTruthy() {
        if (actual) {
          throw new Error('Expected falsy value')
        }
      },
      toBeFalsy() {
        if (!actual) {
          throw new Error('Expected truthy value')
        }
      },
      toContain(expected: string) {
        if (typeof actual === 'string' && actual.includes(expected)) {
          throw new Error(`Expected string not to contain "${expected}" but it did`)
        }
      },
      toBeDefined() {
        if (actual !== undefined) {
          throw new Error('Expected value to be undefined')
        }
      },
      toHaveLength(expected: number) {
        if (Array.isArray(actual) && actual.length === expected) {
          throw new Error(`Expected array length not ${expected} but got ${actual.length}`)
        }
      }
    }
  }
}

async function main() {
  console.log('Running DSML Malformed Detection Tests...\n')

  let failed = 0
  const parserTests = [
    { name: 'parameter directly under <calls> should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Parameter found outside')
      expect(result.error!.syntaxRules).toBe(CORRECTIVE_MESSAGE)
    }},
    { name: 'invalid/unknown DSML element should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid_element>something</｜｜DSML｜｜ invalid_element>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Invalid DSML element')
    }},
    { name: 'missing closing invoke tag should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Mismatched <invoke> tags')
    }},
    { name: 'missing closing calls tag should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Missing closing')
    }},
    { name: 'valid DSML should parse successfully', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].function.name).toBe('read')
      expect(JSON.parse(result.toolCalls[0].function.arguments).filePath).toBe('README.md')
    }},
    { name: 'malformed DSML emits zero tool calls', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.toolCalls).toHaveLength(0)
      expect(result.isMalformed).toBe(true)
    }},
    { name: 'corrective message contains syntax rules', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid>bad</｜｜DSML｜｜ invalid>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.error!.syntaxRules).toContain('<｜｜DSML｜｜ calls>')
      expect(result.error!.syntaxRules).toContain('<｜｜DSML｜｜ invoke name=')
      expect(result.error!.syntaxRules).toContain('Rules:')
      expect(result.error!.syntaxRules).toContain('Parameters MUST be inside')
    }},
    { name: 'missing closing parameter tag should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
    }},
    { name: 'unknown DSML element inside calls should be detected', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ unknown>bad</｜｜DSML｜｜ unknown>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Invalid DSML element')
    }},
    { name: 'empty invoke name should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('must contain at least one')
    }},
    { name: 'whitespace-only invoke name should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="   ">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Tool name is empty')
    }},
    { name: 'zero invokes inside calls should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('must contain at least one')
    }},
    { name: 'malformed closing tag should be detected', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
    }},
    { name: 'malformed DSML mixed with normal surrounding text should be detected', fn: async () => {
      const xml = `Some text before
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>
Some text after`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
    }},
    { name: 'one valid invoke should parse correctly', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="write">
<｜｜DSML｜｜ parameter name="content" string="true">hello world</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].function.name).toBe('write')
      expect(JSON.parse(result.toolCalls[0].function.arguments).content).toBe('hello world')
    }},
    { name: 'multiple valid invokes should parse correctly', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
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
    }},
    { name: 'normal non-DSML text should return empty toolCalls without malformed flag', fn: async () => {
      const xml = `Hello, this is a normal text response without any DSML.`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeFalsy()
    }},
    { name: 'text with DSML-like but incomplete tags should not be detected as DSML', fn: async () => {
      const xml = `This has <｜｜DSML｜｜ but not complete`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeFalsy()
    }},
    { name: 'multiple parameters in single invoke should work', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="search">
<｜｜DSML｜｜ parameter name="query" string="true">test query</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="limit" string="false">10</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(1)
      const args = JSON.parse(result.toolCalls[0].function.arguments)
      expect(args.query).toBe('test query')
      expect(args.limit).toBe('10')
    }},
    { name: 'parameter with string="false" should be parsed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="count" string="false">42</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(1)
      const args = JSON.parse(result.toolCalls[0].function.arguments)
      expect(args.count).toBe('42')
    }},
    { name: 'parameter without string attribute should be detected as malformed', fn: async () => {
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
    }},
    { name: 'parameter with invalid string attribute value should be detected as malformed', fn: async () => {
      const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="value" string="yes">test</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('string=')
    }},
  ]

  failed += await runTestsSequentially(parserTests)

  console.log('\n--- Streaming DSML Tests ---\n')

  const streamingTests = [
    { name: 'valid normal text stream should parse without error', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Hello' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' world' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('Hello')
      expect(output).toContain('world')
      expect(output).toContain('[DONE]')
    }},
    { name: 'valid DSML tool call stream should parse without error', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      if (result.parseError) {
        console.error('Parse error:', result.parseError)
      }
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('tool_calls')
      expect(output).toContain('read')
      expect(output).toContain('README.md')
      expect(output).toContain('[DONE]')
    }},
    { name: 'parser directly handles full DSML buffer correctly', fn: async () => {
      const buffer = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
      const result = parseDSMLToolCalls(buffer)
      console.log('Direct parser result:', result)
      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(1)
    }},
    { name: 'malformed complete DSML should produce parse error', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeDefined()
      expect(result.parseError!.message).toContain('Parameter found outside')
      const output = await decodeStream(result.stream)
      expect(output).not.toContain('tool_calls')
      expect(output).toContain('[DONE]')
    }},
    { name: 'missing closing calls tag at EOF should produce parse error', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeDefined()
      expect(result.parseError!.message).toContain('Missing closing')
      const output = await decodeStream(result.stream)
      expect(output).not.toContain('tool_calls')
      expect(output).toContain('[DONE]')
    }},
    { name: 'missing closing invoke tag at EOF should produce parse error', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeDefined()
      expect(result.parseError!.message).toContain('Mismatched <invoke> tags')
      const output = await decodeStream(result.stream)
      expect(output).not.toContain('tool_calls')
      expect(output).toContain('[DONE]')
    }},
    { name: 'DSML split across multiple upstream chunks should parse correctly', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜' }] } } }),
        makeSSEData({ v: { response: { fragments: [{ type: 'RESPONSE', content: '｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('tool_calls')
      expect(output).toContain('read')
    }},
    { name: 'closing DSML tag split across chunks should parse correctly', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ invoke name="read">' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ invoke>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜' }),
        makeSSEData({ v: { response: { fragments: [{ type: 'RESPONSE', content: '｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('tool_calls')
      expect(output).toContain('read')
    }},
    { name: 'CRLF SSE input should parse correctly', fn: async () => {
      const sseInput = [
        `event: ready\r\ndata: ${JSON.stringify({ response_message_id: 123 })}\r\n\r\n`,
        `event: update_session\r\ndata: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'Hello' }] } } })}\r\n\r\n`,
        `event: close\r\ndata: ${JSON.stringify({})}\r\n\r\n`,
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('Hello')
      expect(output).toContain('[DONE]')
    }},
    { name: 'final SSE line without newline should parse correctly', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Hello' }] } } }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('Hello')
      expect(output).toContain('[DONE]')
    }},
    { name: 'malformed response produces final parse error', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeDefined()
      expect(result.parseError!.message).toContain('Parameter found outside')
      expect(result.parseError!.syntaxRules).toBe(CORRECTIVE_MESSAGE)
    }},
    { name: 'malformed response produces no client-facing DSML/tool-call output', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      const output = await decodeStream(result.stream)
      expect(output).not.toContain('tool_calls')
      expect(output).not.toContain('<｜｜DSML｜｜')
      expect(output).toContain('[DONE]')
    }},
    { name: 'valid response remains unchanged', fn: async () => {
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: 'Hello' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: ' world' }),
        makeSSEEvent('close', {}),
      ]
      const stream = createSSEStream(sseInput)
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('Hello')
      expect(output).toContain('world')
      expect(output).not.toContain('tool_calls')
      expect(output).toContain('[DONE]')
    }},
    { name: 'upstream stream fully consumed before parse error available', fn: async () => {
      let chunksConsumed = 0
      const sseInput = [
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<｜｜DSML｜｜ calls>' }] } } }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>' }),
        makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '</｜｜DSML｜｜ calls>' }),
        makeSSEEvent('close', {}),
      ]
      
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (chunksConsumed < sseInput.length) {
            controller.enqueue(new TextEncoder().encode(sseInput[chunksConsumed++]))
          } else {
            controller.close()
          }
        },
      })
      
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(chunksConsumed).toBe(sseInput.length)
      expect(result.parseError).toBeDefined()
      expect(result.parseError!.message).toContain('Parameter found outside')
    }},
{ name: 'split multibyte UTF-8 character across chunks should be reconstructed at EOF', fn: async () => {
      // Build SSE events with the actual emoji character in the JS string
      // JSON.stringify will escape it, but JSON.parse will unescape it correctly
      const readyEvent = makeSSEEventBytes('ready', { response_message_id: 123 })
      const updateEvent = makeSSEEventBytes('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })
      
      // Use the actual emoji in the JS string
      const text = 'Hello 🎉 world'
      const pEvent1 = makeSSEEventBytes('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: text })
      const closeEvent = makeSSEEventBytes('close', {})
      
      // Concatenate all bytes
      const allBytes = new Uint8Array(
        readyEvent.length + updateEvent.length + pEvent1.length + closeEvent.length
      )
      let offset = 0
      for (const arr of [readyEvent, updateEvent, pEvent1, closeEvent]) {
        allBytes.set(arr, offset)
        offset += arr.length
      }
      
      // Find the emoji in the combined byte stream (🎉 = F0 9F 8E 89)
      let emojiPos = -1
      for (let i = 0; i < allBytes.length - 3; i++) {
        if (allBytes[i] === 0xF0 && allBytes[i+1] === 0x9F && allBytes[i+2] === 0x8E && allBytes[i+3] === 0x89) {
          emojiPos = i
          break
        }
      }
      
      if (emojiPos === -1) {
        throw new Error('Emoji not found in combined stream')
      }
      
      // Split after the first 2 bytes of the emoji
      const splitPos = emojiPos + 2
      const chunk1Combined = allBytes.slice(0, splitPos)
      const chunk2Combined = allBytes.slice(splitPos)
      
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(chunk1Combined)
          controller.enqueue(chunk2Combined)
          controller.close()
        },
      })
      
      const info = { model: 'test', id: 'chatcmpl-1', created: Math.floor(Date.now() / 1000) }
      
      const result = await translateDeepSeekStreamToSSE(stream, info)
      
      expect(result.parseError).toBeNull()
      const output = await decodeStream(result.stream)
      expect(output).toContain('🎉')
      expect(output).toContain('Hello')
      expect(output).toContain('world')
      expect(output).toContain('[DONE]')
    }},
  ]

  failed += await runTestsSequentially(streamingTests)

  console.log(`\n${failed === 0 ? 'All' : failed} test${failed !== 1 ? 's' : ''} ${failed === 0 ? 'passed' : 'failed'}!`)
  if (failed > 0) process.exit(1)
}

main().catch(() => process.exit(1))