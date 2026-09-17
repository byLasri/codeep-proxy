// Import the parseDSMLToolCalls function by reading and evaluating the source
// This allows us to test the actual parser logic
function loadParser() {
  const fs = require('fs')
  const path = require('path')
  const responseTsPath = path.join(__dirname, '../src/translator/response.ts')
  const content = fs.readFileSync(responseTsPath, 'utf-8')
  
  // Extract the CORRECTIVE_MESSAGE constant
  const correctiveMatch = content.match(/const CORRECTIVE_MESSAGE = `([\s\S]*?)`/)
  const CORRECTIVE_MESSAGE = correctiveMatch ? correctiveMatch[1] : ''
  
  // Extract the parseDSMLToolCalls function
  const funcMatch = content.match(/function parseDSMLToolCalls\(xml: string\): DSMLParseResult \{([\s\S]*?)\n\}/)
  if (!funcMatch) {
    throw new Error('Could not extract parseDSMLToolCalls function')
  }
  
  const funcBody = funcMatch[1]
  
  // Create a runnable version of the function
  const funcStr = `
    function parseDSMLToolCalls(xml) {
      const toolCalls = []
      ${funcBody}
    }
    return { parseDSMLToolCalls, CORRECTIVE_MESSAGE }
  `
  
  const module = new Function(funcStr)
  return module()
}

const { parseDSMLToolCalls, CORRECTIVE_MESSAGE } = loadParser()

// Simple test runner
const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

function runTests() {
  console.log('Running DSML Malformed Detection Tests...\n')
  let passed = 0
  let failed = 0
  
  for (const { name, fn } of tests) {
    try {
      fn()
      console.log(`✓ ${name}`)
      passed++
    } catch (error) {
      console.error(`✗ ${name}`)
      console.error(`  ${error instanceof Error ? error.message : error}`)
      failed++
    }
  }
  
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

function expect(actual) {
  return {
    toBe(expected) {
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
    toContain(expected) {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected string to contain "${expected}" but got "${actual}"`)
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error('Expected value to be defined')
      }
    }
  }
}

test('parameter directly under <calls> should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
  
  const result = parseDSMLToolCalls(xml)
  
  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls.length).toBe(0)
  expect(result.error).toBeDefined()
  expect(result.error.message).toContain('Parameter found outside')
  expect(result.error.syntaxRules).toBe(CORRECTIVE_MESSAGE)
})

test('invalid/unknown DSML element should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid_element>something</｜｜DSML｜｜ invalid_element>
</｜｜DSML｜｜ calls>`
  
  const result = parseDSMLToolCalls(xml)
  
  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls.length).toBe(0)
  expect(result.error).toBeDefined()
  expect(result.error.message).toContain('Invalid DSML element')
})

test('missing closing invoke tag should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
  
  const result = parseDSMLToolCalls(xml)
  
  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls.length).toBe(0)
  expect(result.error).toBeDefined()
  expect(result.error.message).toContain('Mismatched')
})

test('missing closing calls tag should be detected as malformed', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`
  
  const result = parseDSMLToolCalls(xml)
  
  expect(result.isMalformed).toBe(true)
  expect(result.toolCalls.length).toBe(0)
  expect(result.error).toBeDefined()
  expect(result.error.message).toContain('Missing closing')
})

test('valid DSML should parse successfully', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
  
  const result = parseDSMLToolCalls(xml)
  
  expect(result.isMalformed).toBeFalsy()
  expect(result.toolCalls.length).toBe(1)
  expect(result.toolCalls[0].function.name).toBe('read')
  expect(JSON.parse(result.toolCalls[0].function.arguments).filePath).toBe('README.md')
})

test('malformed DSML emits zero tool calls', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">test.txt</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
  
  const result = parseDSMLToolCalls(xml)
  
  // Critical: malformed DSML must emit ZERO tool calls
  expect(result.toolCalls.length).toBe(0)
  expect(result.isMalformed).toBe(true)
})

test('corrective message contains syntax rules', () => {
  const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid>bad</｜｜DSML｜｜ invalid>
</｜｜DSML｜｜ calls>`
  
  const result = parseDSMLToolCalls(xml)
  
  expect(result.error.syntaxRules).toContain('<｜｜DSML｜｜ calls>')
  expect(result.error.syntaxRules).toContain('<｜｜DSML｜｜ invoke name=')
  expect(result.error.syntaxRules).toContain('Rules:')
  expect(result.error.syntaxRules).toContain('Parameters MUST be inside')
})

runTests()
