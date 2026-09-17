import { parseDSMLToolCalls, CORRECTIVE_MESSAGE, type DSMLParseResult } from '../src/translator/response.js'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    throw error
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`)
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
}

console.log('Running DSML Malformed Detection Tests...\n')

test('parameter directly under <calls> should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
  expect(result.error!.message).toContain('Parameter found outside')
  expect(result.error!.syntaxRules).toBe(CORRECTIVE_MESSAGE)
})

test('invalid/unknown DSML element should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid_element>something</｜｜DSML｜｜ invalid_element>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
  expect(result.error!.message).toContain('Invalid DSML element')
})

test('missing closing invoke tag should be detected as malformed (parameter outside invoke)', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
  expect(result.error!.message).toContain('Parameter found outside')
})

test('missing closing calls tag should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
  expect(result.error!.message).toContain('Missing closing')
})

test('valid DSML should parse successfully', () => {
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
})

test('malformed DSML emits zero tool calls', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.toolCalls).toHaveLength(0)
  expect(result.isMalformed).toBe(true)
})

test('corrective message contains syntax rules', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid>bad</｜｜DSML｜｜ invalid>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.error!.syntaxRules).toContain('<｜｜DSML｜｜ calls>')
  expect(result.error!.syntaxRules).toContain('<｜｜DSML｜｜ invoke name=')
  expect(result.error!.syntaxRules).toContain('Rules:')
  expect(result.error!.syntaxRules).toContain('Parameters MUST be inside')
})

test('missing closing parameter tag should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
})

test('unknown DSML element inside calls should be detected', () => {
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
})

test('empty invoke name should be detected as malformed', () => {
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
})

test('whitespace-only invoke name should be detected as malformed', () => {
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
})

test('zero invokes inside calls should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
  expect(result.error!.message).toContain('must contain at least one')
})

test('malformed closing tag should be detected', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
})

test('malformed DSML mixed with normal surrounding text should be detected', () => {
  const xml = `Some text before
<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>
Some text after`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeDefined()
})

test('one valid invoke should parse correctly', () => {
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
})

test('multiple valid invokes should parse correctly', () => {
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
})

test('normal non-DSML text should return empty toolCalls without malformed flag', () => {
  const xml = `Hello, this is a normal text response without any DSML.`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBeFalsy()
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeFalsy()
})

test('text with DSML-like but incomplete tags should not be detected as DSML', () => {
  const xml = `This has <｜｜DSML｜｜ but not complete`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBeFalsy()
  expect(result.toolCalls).toHaveLength(0)
  expect(result.error).toBeFalsy()
})

test('multiple parameters in single invoke should work', () => {
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
})

test('parameter with string="false" should be parsed', () => {
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
})

test('parameter without string attribute defaults to string', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="test">
<｜｜DSML｜｜ parameter name="value">test</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

  const result = parseDSMLToolCalls(xml)

  expect(result.isMalformed).toBeFalsy()
  expect(result.toolCalls).toHaveLength(1)
  const args = JSON.parse(result.toolCalls[0].function.arguments)
  expect(args.value).toBe('test')
})

console.log('\nAll tests passed!')