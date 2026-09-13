// Test for translator response functions using the provided fixture.

import assert from 'node:assert/strict';
import { translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON } from './response.js';
import { formatOpenAISSEChunk, formatOpenAIDone } from './response.js';
import { readFile } from 'fs/promises';

// Helper to create a ReadableStream from a string
function streamFromString(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
    cancel() {
      // No-op
    }
  });
}

// Helper to collect all chunks from a readable stream into a string
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  return (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  })();
}

// Helper to count occurrences of a substring in a string
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Helper to strip timestamps from the fixture lines
function stripTimestamps(line: string): string {
  // The fixture lines are like: [2026-09-13T05:57:18.908803] event: ready
  // We remove the timestamp at the start.
  return line.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\]\s/, '');
}

// Read the fixture file
const fixture = await readFile('./deepseek_response.log', 'utf-8');
const lines = fixture.split('\n').map(stripTimestamps).filter(line => line.trim() !== '');
const sseFixture = lines.join('\n');

// OpenAI request info for the test
const openaiRequestInfo = {
  model: 'V4-Pro', // arbitrary, will be overridden by the translator? Actually, the translator uses it for the chunk id and model.
  id: 'chatcmpl-test', // will be overridden by the translator with the response_message_id
  created: Math.floor(Date.now() / 1000)
};

console.log('Testing translateDeepSeekStreamToSSE...');
const sseOut = await collectStream(translateDeepSeekStreamToSSE(streamFromString(sseFixture), openaiRequestInfo));
assert.ok(!sseOut.includes('[object Object]'), 'content contains [object Object]');
assert.ok(!/data: \{[^}]*"content":"FINISHED"/.test(sseOut), 'FINISHED leaked as content');
assert.equal(count(sseOut, '"finish_reason":"stop"'), 1, 'exactly one stop chunk');
assert.equal(count(sseOut, 'data: [DONE]'), 1, 'exactly one [DONE]');
assert.ok(!/data: \[DONE\][\s\S]+data:/.test(sseOut), 'data after [DONE]');

const firstDataLine = sseOut.split('\n').find(l => l.startsWith('data:') && !l.includes('[DONE]'));
assert.ok(firstDataLine, 'no data line found');
const firstChunk = JSON.parse(firstDataLine.slice(5));
assert.equal(firstChunk.choices[0].delta.role, 'assistant', 'first delta missing role');
assert.equal(firstChunk.id, 'chatcmpl-6', 'wrong chunk id');

// --- non-streaming ---
console.log('\nTesting translateDeepSeekStreamToJSON...');
const json = await translateDeepSeekStreamToJSON(streamFromString(sseFixture), openaiRequestInfo);
assert.equal(json.id, 'chatcmpl-6');
assert.equal(json.choices[0].finish_reason, 'stop');
assert.ok(json.choices[0].message.content.length > 3000);
assert.ok(!json.choices[0].message.content.includes('[object Object]'));
assert.equal(typeof json.usage?.total_tokens, 'number', 'usage.total_tokens missing');

// --- synthetic: no initial content in update_session ---
console.log('\nTesting synthetic no initial content...');
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
  ''
].join('\n');
const synthStream = new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode(synthetic)); c.close() }
});
const synthOut = await collectStream(translateDeepSeekStreamToSSE(synthStream, {
  model: 'V4-Pro', id: 'chatcmpl-synth', created: 0, stream: true
}));
const synthFirst = synthOut.split('\n').find(l => l.startsWith('data:') && !l.includes('[DONE]'));
assert.ok(synthFirst, 'synthetic: no data line');
const synthChunk = JSON.parse(synthFirst.slice(5));
assert.equal(synthChunk.choices[0].delta.role, 'assistant', 'synthetic: first delta missing role');

console.log('All assertions passed.');