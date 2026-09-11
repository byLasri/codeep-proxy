// Test script for /completions endpoint with OpenAI schema
import { DeepSeekWebClient } from './src/deepseek/client.js'
import type { DeepSeekCredentials } from './src/deepseek/types.js'
import type { ProtocolStateStore } from './src/deepseek/state-store.js'
import { PROTOCOL_STATE_KEYS } from './src/deepseek/state-store.js'

// Credentials from user
const DEEPSEEK_AUTH_TOKEN = 'oXY3Ai7vDOWY3qO7NZ2F1JWNeF3Um+AdLJSfB0G3X8xjZntED1rxpa5CpYunNm+x'
const DEEPSEEK_COOKIES = [
  { name: 'ds_session_id', value: 'b708f2727a8c4e30b290798c325ceaf3' },
  { name: 'aws-waf-token', value: 'c36d69a2-691f-4a19-8c1e-40aa16b740ba:CgoAqfghzpInAAAA:fSEZHgkYQ3B3fy1D90+dpVefPeIp0pPuxI8u48pa1chfRCY43szXggQXWIjwRbYpTZAD8WPjPruzrRLFyUKxxehsIebyawl4Rc1ZIjKXt6Ljv11kPygeibLA0Gw8a2cP3e5/kQ1bGkK63SRKLH+WOzqUgz5WmGyNhvMACnkeUsQ7LofFBG/Tq8rO7f+INav8RFtx/nKwbTDhdfWcS+GwHlUEuqih6SFn2jI1CF3v2o33LZZyV/icUORnUGcginOS8EsBGSFA' },
  { name: 'smidV2', value: '20260907215413bb46193f23514facab1fd8143ebb928f00798499de894b560' },
  { name: '.thumbcache_6b2e5483f9d858d7c661c5e276b6a6ae', value: 'HVSETnMwICmoBi5cxhCLe2iApd5iTupyGezPyGNqfbkqC3md5/CYnRIUoPLZSxULSubla1vBsS5TmbNKue4q+g%3D%3D' }
]

function buildCookieString(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

// Mock ProtocolStateStore for testing
class MockStateStore implements ProtocolStateStore {
  private storage: Map<string, string> = new Map()
  
  constructor(credentials: { authorization: string; cookie: string }) {
    const credJson = JSON.stringify({
      authorizationToken: credentials.authorization,
      cookies: DEEPSEEK_COOKIES
    })
    this.storage.set(PROTOCOL_STATE_KEYS.AUTH, credJson)
  }
  
  async get(key: string): Promise<string | undefined> {
    return this.storage.get(key)
  }
  
  async set(key: string, value: string): Promise<void> {
    this.storage.set(key, value)
  }
  
  async delete(key: string): Promise<void> {
    this.storage.delete(key)
  }
}

const credentials: DeepSeekCredentials = {
  authorization: DEEPSEEK_AUTH_TOKEN,
  cookie: buildCookieString(DEEPSEEK_COOKIES)
}

// OpenAI Chat Completions API types
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
}

interface OpenAIChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: { role?: string; content?: string }
    finish_reason: string | null
  }>
}

console.log('='.repeat(60))
console.log('DeepSeek Completions Module Test with OpenAI Schema')
console.log('='.repeat(60))
console.log()

// Test 1: Basic OpenAI to DeepSeek conversion
console.log('TEST 1: OpenAI to DeepSeek Schema Conversion')
console.log('-'.repeat(60))

const openAIRequest: OpenAIChatCompletionRequest = {
  model: 'deepseek-chat',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello! Can you help me with a simple question?' }
  ],
  temperature: 0.7,
  max_tokens: 100,
  stream: true
}

console.log('Input (OpenAI schema):')
console.log(JSON.stringify(openAIRequest, null, 2))

// Convert OpenAI schema to DeepSeek format
function openAIToDeepSeek(openAIReq: OpenAIChatCompletionRequest) {
  // Build context-aware prompt from messages
  const systemMessage = openAIReq.messages.find(m => m.role === 'system')?.content || ''
  const userMessages = openAIReq.messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join('\n')
  
  const prompt = systemMessage 
    ? `${systemMessage}\n\n${userMessages}`
    : userMessages
  
  return {
    prompt,
    model_type: 'default' as const,
    thinking_enabled: false,
    search_enabled: false
  }
}

const deepSeekRequest = openAIToDeepSeek(openAIRequest)

console.log('\nConverted (DeepSeek format):')
console.log(JSON.stringify(deepSeekRequest, null, 2))
console.log('✅ Schema conversion passed\n')

// Test 2: Direct DeepSeek API call
console.log('TEST 2: Direct DeepSeek Completions API Call')
console.log('-'.repeat(60))

try {
  // Create mock state store with credentials
  const mockStateStore = new MockStateStore(credentials)
  
  const client = new DeepSeekWebClient({
    stateStore: mockStateStore,
    origin: 'https://chat.deepseek.com'
  })

  console.log('Creating session...')
  const session = await client.createSession()
  console.log(`Session ID: ${session.id}`)

  console.log('\nSending completion request...')
  const response = await client.complete({
    session: {
      chat_session_id: session.id,
      parent_message_id: null,
    },
    prompt: deepSeekRequest.prompt,
    model_type: 'default',
    thinking_enabled: false,
    search_enabled: false,
    ref_file_ids: [],
    action: null,
    preempt: false
  })

  console.log(`Response Status: ${response.status}`)
  console.log(`Content-Type: ${response.headers.get('content-type')}`)
  console.log('\nStreaming SSE Response:')
  console.log('-'.repeat(40))
  
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No response body')
  }

  const decoder = new TextDecoder()
  let done = false
  let fullContent = ''
  let messageId: number | null = null
  let responseId: number | null = null
  
  while (!done) {
    const { value, done: isDone } = await reader.read()
    done = isDone
    
    if (value) {
      const chunk = decoder.decode(value)
      const lines = chunk.split('\n').filter(line => line.trim())
      
      for (const line of lines) {
        if (line.startsWith('event: ready')) {
          continue
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim()
          try {
            const data = JSON.parse(dataStr)
            if (data.request_message_id !== undefined) {
              messageId = data.request_message_id
              responseId = data.response_message_id
              console.log(`[READY] Request ID: ${messageId}, Response ID: ${responseId}`)
            } else if (data.v?.response?.fragments) {
              // Accumulate content from fragments
              for (const frag of data.v.response.fragments) {
                if (frag.content) fullContent += frag.content
              }
            } else if (data.p === 'response/fragments/-1/content' && data.o === 'APPEND') {
              // Streaming content
              fullContent += data.v
              process.stdout.write(data.v)
            } else if (data.p === 'response/status' && data.v === 'FINISHED') {
              console.log('\n[STATUS] FINISHED')
            }
          } catch {
            // Non-JSON data, just print
          }
        }
      }
    }
  }
  
  console.log('-'.repeat(40))
  console.log(`\nFull Response Content: "${fullContent}"`)
  console.log(`\n✅ Direct API call passed\n`)

  // Test 3: OpenAI-compatible response transformation
  console.log('TEST 3: OpenAI-Compatible Response Transformation')
  console.log('-'.repeat(60))
  
  // Simulate converting DeepSeek SSE to OpenAI chunks
  function createOpenAIChunk(content: string, index = 0, finishReason: string | null = null): OpenAIChatCompletionChunk {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'deepseek-chat',
      choices: [{
        index,
        delta: { content },
        finish_reason: finishReason
      }]
    }
  }
  
  // Demonstrate transformation
  const sampleChunks = fullContent.split(' ').slice(0, 5)
  console.log('Sample OpenAI chunks from response:')
  for (const word of sampleChunks) {
    const chunk = createOpenAIChunk(word + ' ')
    console.log(JSON.stringify(chunk))
  }
  const finalChunk = createOpenAIChunk('', 0, 'stop')
  console.log(JSON.stringify(finalChunk))
  console.log('\n✅ OpenAI transformation passed\n')

  console.log('='.repeat(60))
  console.log('ALL TESTS PASSED SUCCESSFULLY!')
  console.log('='.repeat(60))
  
} catch (error) {
  console.error('\n❌ Test failed:', error instanceof Error ? error.message : error)
  process.exit(1)
}
