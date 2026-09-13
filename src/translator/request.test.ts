import assert from 'node:assert/strict'
import { getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt } from './request.js'
import { mapOpenAIModelToDeepSeek } from './models.js'

// model mapping
assert.equal(mapOpenAIModelToDeepSeek('V4-Pro'), 'expert')
assert.equal(mapOpenAIModelToDeepSeek('V4.1-flash'), null)
assert.equal(mapOpenAIModelToDeepSeek('gpt-3.5-turbo'), null)
assert.equal(mapOpenAIModelToDeepSeek(null), null)
assert.equal(mapOpenAIModelToDeepSeek(undefined), null)
assert.equal(mapOpenAIModelToDeepSeek(42), null)

// header precedence
const h1 = new Headers({ 'X-Session-Id': 'a', 'X-Session-Affinity': 'b' })
assert.equal(getXSessionIdFromHeaders(h1), 'a')
const h2 = new Headers({ 'X-Session-Affinity': 'b' })
assert.equal(getXSessionIdFromHeaders(h2), 'b')
const h3 = new Headers({ 'X-Session-Id': '   ' })
assert.equal(getXSessionIdFromHeaders(h3), undefined)
const h4 = new Headers({ 'X-Session-Id': 'x'.repeat(129) })
assert.equal(getXSessionIdFromHeaders(h4), undefined)

// first turn detection
assert.equal(isFirstTurn([{ role: 'user', content: 'hi' }]), true)
assert.equal(
  isFirstTurn([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ]),
  false
)

// prompt assembly - first turn with system and tools
const p = buildDeepSeekPrompt(
  [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ],
  [{ type: 'function', function: { name: 'f' } }]
)
assert.ok(p.startsWith('S'))
assert.ok(p.includes('"name":"f"'))
assert.ok(p.endsWith('U'))

// continuation
const p2 = buildDeepSeekPrompt([
  { role: 'system', content: 'S' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'second' },
])
assert.equal(p2, 'second')

// no user message throws
assert.throws(() => buildDeepSeekPrompt([{ role: 'system', content: 'S' }]))

// malformed user message with no content does not produce "undefined"
assert.throws(() => buildDeepSeekPrompt([{ role: 'user' } as unknown as import('./types.js').OpenAIChatMessage]))

// sessionExists override test
const messages = [
  { role: 'user', content: 'hello' },
  { role: 'user', content: 'second turn' },
]
const first = buildDeepSeekPrompt(
  [{ role: 'system', content: 'S' }, ...messages],
  [{ type: 'function', function: { name: 'f' } }],
  false
)
assert.ok(first.includes('S'), 'first turn must include system prompt')
assert.ok(first.includes('"name":"f"'), 'first turn must include tools')

const later = buildDeepSeekPrompt(
  [{ role: 'system', content: 'S' }, ...messages],
  [{ type: 'function', function: { name: 'f' } }],
  true
)
assert.equal(later, 'second turn', 'session-exists turn must send only latest user message')

console.log('All request.test.ts assertions passed.')
