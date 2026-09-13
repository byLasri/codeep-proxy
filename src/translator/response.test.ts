// Test for translator response functions using the provided fixture.

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

// Helper to strip timestamps from the fixture lines
function stripTimestamps(line: string): string {
  // The fixture lines are like: [2026-09-13T05:57:18.908803] event: ready
  // We remove the timestamp at the start.
  return line.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\]\s/, '');
}

// Read the fixture file
const fixture = await readFile('./deepseek_response.log', 'utf-8');
console.log('Fixture length:', fixture.length); // DEBUG
console.log('First 200 chars of fixture:', fixture.substring(0, 200)); // DEBUG
const lines = fixture.split('\n').map(stripTimestamps).filter(line => line.trim() !== '');
console.log('Number of lines after stripping timestamps:', lines.length); // DEBUG
if (lines.length > 0) {
  console.log('First line:', lines[0]); // DEBUG
  console.log('Second line:', lines[1]); // DEBUG
}
const sseFixture = lines.join('\n');
console.log('sseFixture length:', sseFixture.length); // DEBUG
console.log('First 200 chars of sseFixture:', sseFixture.substring(0, 200)); // DEBUG

// OpenAI request info for the test
const openaiRequestInfo = {
  model: 'V4-Pro', // arbitrary, will be overridden by the translator? Actually, the translator uses it for the chunk id and model.
  id: 'chatcmpl-test', // will be overridden by the translator with the response_message_id
  created: Math.floor(Date.now() / 1000)
};

console.log('Testing translateDeepSeekStreamToSSE...');
const stream = translateDeepSeekStreamToSSE(streamFromString(sseFixture), openaiRequestInfo);
let output = '';
for await (const chunk of stream) {
  output += new TextDecoder().decode(chunk);
}
console.log('SSE output length:', output.length);
// We'll do some checks
const linesOut = output.split('\n').filter(line => line.trim() !== '');
console.log('Number of lines:', linesOut.length);
// Check that we don't have [object Object] or FINISHED in the content
const hasObjectObject = output.includes('[object Object]');
const hasFinished = output.includes('FINISHED');
console.log('Contains [object Object]:', hasObjectObject);
console.log('Contains FINISHED:', hasFinished);
// Check that the first delta has role "assistant"
// We'll parse the first data line that is not empty and not [DONE]
let firstDataLine = '';
for (const line of linesOut) {
  if (line.startsWith('data:') && line !== 'data: [DONE]') {
    firstDataLine = line.substring(5).trim();
    break;
  }
}
if (firstDataLine) {
  try {
    const firstChunk = JSON.parse(firstDataLine);
    const delta = firstChunk.choices[0].delta;
    const hasRole = delta.role === 'assistant';
    console.log('First delta has role "assistant":', hasRole);
    if (hasRole) {
      console.log('First delta content:', delta.content);
    }
  } catch (e) {
    console.error('Failed to parse first data line:', e);
  }
}
// Check chunk ids are "chatcmpl-6" (from the fixture's response_message_id: 6)
// We'll look at the id field in the chunks
let ids: string[] = [];
for (const line of linesOut) {
  if (line.startsWith('data:') && line !== 'data: [DONE]') {
    try {
      const chunk = JSON.parse(line.substring(5).trim());
      ids.push(chunk.id);
    } catch (e) {
      // ignore
    }
  }
}
const uniqueIds = [...new Set(ids)];
console.log('Unique chunk ids:', uniqueIds);
const hasCorrectId = uniqueIds.length === 1 && uniqueIds[0] === 'chatcmpl-6';
console.log('All chunk ids are "chatcmpl-6":', hasCorrectId);
// Check that there is exactly one finish_reason "stop" chunk and exactly one "data: [DONE]"
const stopChunks = linesOut.filter(line => line.startsWith('data:') && line.includes('"finish_reason":"stop"'));
const doneLines = linesOut.filter(line => line === 'data: [DONE]');
console.log('Number of stop chunks:', stopChunks.length);
console.log('Number of [DONE] lines:', doneLines.length);
const exactlyOneStop = stopChunks.length === 1;
const exactlyOneDone = doneLines.length === 1;
console.log('Exactly one stop chunk:', exactlyOneStop);
console.log('Exactly one [DONE]:', exactlyOneDone);
// Check that there is no data after [DONE]
const doneIndex = linesOut.indexOf('data: [DONE]');
const afterDone = linesOut.slice(doneIndex + 1);
console.log('Lines after [DONE]:', afterDone.length);
const noAfterDone = afterDone.length === 0;
console.log('No data after [DONE]:', noAfterDone);

// Now test the non-streaming version
console.log('\nTesting translateDeepSeekStreamToJSON...');
const jsonPromise = translateDeepSeekStreamToJSON(streamFromString(sseFixture), openaiRequestInfo);
const jsonResponse = await jsonPromise;
console.log('JSON response:', JSON.stringify(jsonResponse, null, 2));
// Check that the content matches the accumulated prose (we can compute the expected content by stripping the fixture of non-content lines)
// We'll do a simple check: the content should be a string and not empty.
const content = jsonResponse.choices[0].message.content;
console.log('Content length:', content.length);
console.log('Content starts with:', content.substring(0, 100));
// Check finish_reason is "stop"
const finishReason = jsonResponse.choices[0].finish_reason;
console.log('Finish reason:', finishReason);
// Check usage is present
const usage = jsonResponse.usage;
console.log('Usage:', usage);

console.log('\nAll tests completed.');