import assert from 'node:assert/strict'
import { getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt } from './request.js'
import { mapOpenAIModelToDeepSeek } from './models.js'

// model mapping - now returns ModelConfig
assert.deepEqual(mapOpenAIModelToDeepSeek('V4-Pro'), { model_type: 'expert', thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('V4.1-flash'), { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('gpt-3.5-turbo'), { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek(null), { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek(undefined), { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek(42), { model_type: null, thinking: false, search: false })

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

// sendSystemPrompt override test
const messages = [
  { role: 'user', content: 'hello' },
  { role: 'user', content: 'second turn' },
]
const first = buildDeepSeekPrompt(
  [{ role: 'system', content: 'S' }, ...messages],
  [{ type: 'function', function: { name: 'f' } }],
  true
)
assert.ok(first.includes('S'), 'sendSystemPrompt=true must include system prompt')
assert.ok(first.includes('"name":"f"'), 'sendSystemPrompt=true must include tools')

const later = buildDeepSeekPrompt(
  [{ role: 'system', content: 'S' }, ...messages],
  [{ type: 'function', function: { name: 'f' } }],
  false
)
assert.equal(later, 'second turn', 'sendSystemPrompt=false must send only latest user message')

console.log('All request.test.ts assertions passed.')
