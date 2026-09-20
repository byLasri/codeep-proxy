import { buildDeepSeekPrompt, translateOpenAIRequest, type ToolResult, type PromptWithToolResults } from '../src/translator/request.js'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from '../src/translator/types.js'
import { translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON, DSML_CORRECTIVE_MESSAGE } from '../src/translator/inbound.js'

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
  console.log('Running Regression Tests...\n')

  let failed = 0

  // ============================================================
  // TEST B: Corrective message has exact valid example
  // ============================================================
  console.log('\n--- Corrective Message Tests ---\n')
  const correctiveTests = [
    { name: 'DSML_CORRECTIVE_MESSAGE contains forbidden delimiters list', fn: () => {
      expect(DSML_CORRECTIVE_MESSAGE).toContain('｜｜DSML｜｜')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('｜DSML｜｜')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('｜DSML｜')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('||DSML||')
    }},
    { name: 'DSML_CORRECTIVE_MESSAGE contains valid tool-call example with proper closing tags', fn: () => {
      expect(DSML_CORRECTIVE_MESSAGE).toContain('<calls>')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('<invoke name="read">')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('<parameter name="filePath">')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('C:\\\\Users\\\\Damas\\\\workground')
      expect(DSML_CORRECTIVE_MESSAGE).toContain('