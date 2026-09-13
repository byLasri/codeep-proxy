import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON } from './response.js'

// Helper to collect stream output
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])))
}

// Helper to count occurrences
function count(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

// Load and strip timestamps from fixture, then convert to proper SSE format
function loadFixture(): string {
  const raw = readFileSync('deepseek_response.txt', 'utf-8')
  // Strip [timestamp] prefix from each line
  const stripped = raw
    .split('\n')
    .map((line) => {
      const match = line.match(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\]\s*(.*)$/)
      return match ? match[1] : line
    })

  // Convert to proper SSE format (add blank lines between event blocks)
  let sseFormat = ''
  let prevEventType = ''
  for (const line of stripped) {
    if (line.startsWith('event:')) {
      if (prevEventType !== '' && sseFormat.length > 0) {
        sseFormat += '\n'  // blank line before new event
      }
      prevEventType = line.slice(7).trim()
    }
    sseFormat += line + '\n'
  }
  return sseFormat
}

function createFixtureStream(chunkSize = 64): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(loadFixture())
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= bytes.length) { c.close(); return }
      const end = Math.min(offset + chunkSize, bytes.length)
      c.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
}

// Get single-chunk version for comparison
function createSingleChunkFixtureStream(): ReadableStream<Uint8Array> {
  const stripped = loadFixture()
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(stripped))
      c.close()
    },
  })
}

// Streaming tests - multi-chunk
const sseOut = await collect(
  translateDeepSeekStreamToSSE(createFixtureStream(), {
    model: 'V4-Pro',
    id: 'chatcmpl',
    created: 0,
  })
)

assert.ok(!sseOut.includes('[object Object]'), 'content contains [object Object]')
assert.ok(!sseOut.includes('"content":"FINISHED"'), 'FINISHED leaked as content')
assert.equal(count(sseOut, '"finish_reason":"stop"'), 1, 'exactly one stop chunk')
assert.equal(count(sseOut, 'data: [DONE]'), 1, 'exactly one [DONE]')

const firstData = sseOut.split('\n').find((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
assert.ok(firstData)
const firstChunk = JSON.parse(firstData.slice(6))
assert.equal(firstChunk.id, 'chatcmpl-6', 'chunk id must be chatcmpl-6')
assert.equal(firstChunk.choices[0].delta.role, 'assistant', 'first delta must have role')
assert.equal(typeof firstChunk.choices[0].delta.content, 'string', 'first delta must have content')
assert.ok(firstChunk.choices[0].delta.content.length > 0, 'first delta content must not be empty')

// every chunk id must be chatcmpl-6, not chatcmpl-null
const allIds = sseOut.split('\n')
  .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
  .map((l) => JSON.parse(l.slice(6)).id)
assert.ok(allIds.length > 1, 'expected multiple chunks')
assert.ok(allIds.every((id) => id === 'chatcmpl-6'), 'some chunk id is not chatcmpl-6')

// exactly one role chunk across the whole stream
const roleChunks = sseOut.split('\n')
  .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
  .filter((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.role === 'assistant')
assert.equal(roleChunks.length, 1, 'role chunk emitted more than once')

// Non-streaming test - multi-chunk
const json = await translateDeepSeekStreamToJSON(createFixtureStream(), {
  model: 'V4-Pro',
  id: 'chatcmpl',
  created: 0,
})
assert.equal(json.id, 'chatcmpl-6')
assert.equal(json.choices[0].finish_reason, 'stop')
assert.ok(json.choices[0].message.content.length > 0, 'content too short')
assert.ok(!json.choices[0].message.content.includes('[object Object]'))
assert.ok(!json.choices[0].message.content.endsWith('FINISHED'))
assert.equal(typeof json.usage?.total_tokens, 'number', 'usage.total_tokens missing')

// Get single-chunk json for comparison
const singleChunkJson = await translateDeepSeekStreamToJSON(createSingleChunkFixtureStream(), {
  model: 'V4-Pro',
  id: 'chatcmpl',
  created: 0,
})

// content must equal the single-chunk run
assert.equal(json.choices[0].message.content, singleChunkJson.choices[0].message.content, 'multi-chunk content differs from single-chunk content')

// Synthetic test: update_session with NO initial content, then one APPEND
const synthetic = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":99,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"Hi"}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n')
const synthStream = new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(new TextEncoder().encode(synthetic))
    c.close()
  },
})
const synthOut = await collect(
  translateDeepSeekStreamToSSE(synthStream, {
    model: 'V4-Pro',
    id: 'chatcmpl',
    created: 0,
  })
)
const synthFirstData = synthOut.split('\n').find((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
assert.ok(synthFirstData)
const synthFirst = JSON.parse(synthFirstData.slice(6))
assert.equal(synthFirst.choices[0].delta.role, 'assistant', 'synthetic: first delta missing role')
assert.equal(synthFirst.id, 'chatcmpl-99')

console.log('All assertions passed.')
