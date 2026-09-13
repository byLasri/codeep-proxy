import assert from 'node:assert/strict'
import { mapOpenAIModelToDeepSeek } from './models.js'

// Flash variants
assert.deepEqual(mapOpenAIModelToDeepSeek('V4.1-flash-DeepThink'),
  { model_type: null, thinking: true, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('V4.1-flash-DeepThink-Web'),
  { model_type: null, thinking: true, search: true })
assert.deepEqual(mapOpenAIModelToDeepSeek('V4.1-flash-Standard'),
  { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('V4.1-flash-Standard-Web'),
  { model_type: null, thinking: false, search: true })

// Pro variants
assert.deepEqual(mapOpenAIModelToDeepSeek('V4-Pro-DeepThink'),
  { model_type: 'expert', thinking: true, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('V4-Pro-Standard'),
  { model_type: 'expert', thinking: false, search: false })

// Base names
assert.deepEqual(mapOpenAIModelToDeepSeek('V4.1-flash'),
  { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('gpt-3.5-turbo'),
  { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('V4-Pro'),
  { model_type: 'expert', thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek('deepseek-v4-pro'),
  { model_type: 'expert', thinking: false, search: false })

// Unknown defaults to Flash Standard
assert.deepEqual(mapOpenAIModelToDeepSeek('unknown-model'),
  { model_type: null, thinking: false, search: false })

// Non-string inputs
assert.deepEqual(mapOpenAIModelToDeepSeek(null),
  { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek(undefined),
  { model_type: null, thinking: false, search: false })
assert.deepEqual(mapOpenAIModelToDeepSeek(42),
  { model_type: null, thinking: false, search: false })

console.log('All models.test.ts assertions passed.')
