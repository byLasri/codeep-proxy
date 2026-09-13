// Test file for translator request functions

import { getXSessionIdFromHeaders, isFirstTurn, buildDeepSeekPrompt, translateOpenAIRequest } from './request.js';
import { OpenAIChatCompletionRequest, OpenAIChatMessage } from './types.js';
import { mapOpenAIModelToDeepSeek } from './models.js';

// Helper to create a Headers object
function createHeaders(init: {[key: string]: string} | string[][] | Headers = {}): Headers {
  if (init instanceof Headers) return init;
  return new Headers(init);
}

// Tests for getXSessionIdFromHeaders
console.log('Testing getXSessionIdFromHeaders...');
{
  // X-Session-Id wins
  let headers = createHeaders({ 'X-Session-Id': 'valid-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'valid-id', 'X-Session-Id should be returned');
  // Case insensitive
  headers = createHeaders({ 'x-session-id': 'valid-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'valid-id', 'x-session-id should be returned');
  // X-Session-Affinity fallback
  headers = createHeaders({ 'X-Session-Affinity': 'affinity-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'affinity-id', 'X-Session-Affinity should be used as fallback');
  // x-session-affinity fallback
  headers = createHeaders({ 'x-session-affinity': 'affinity-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'affinity-id', 'x-session-affinity should be used as fallback');
  // X-Session-Id empty string treated as absent
  headers = createHeaders({ 'X-Session-Id': '', 'X-Session-Affinity': 'affinity-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'affinity-id', 'Empty X-Session-Id should fall back to affinity');
  // X-Session-Id only whitespace treated as absent
  headers = createHeaders({ 'X-Session-Id': '   ', 'X-Session-Affinity': 'affinity-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'affinity-id', 'Whitespace X-Session-Id should fall back');
  // X-Session-Id too long (>128) treated as absent
  const longId = 'a'.repeat(129);
  headers = createHeaders({ 'X-Session-Id': longId, 'X-Session-Affinity': 'affinity-id' });
  console.assert(getXSessionIdFromHeaders(headers) === 'affinity-id', 'Overlong X-Session-Id should fall back');
  // Both absent
  headers = createHeaders({});
  console.assert(getXSessionIdFromHeaders(headers) === undefined, 'Should return undefined when both absent');
  // Both empty
  headers = createHeaders({ 'X-Session-Id': '', 'X-Session-Affinity': '' });
  console.assert(getXSessionIdFromHeaders(headers) === undefined, 'Should return undefined when both empty');
}

// Tests for isFirstTurn
console.log('Testing isFirstTurn...');
{
  // No assistant message -> first turn
  const messagesNoAssistant: OpenAIChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' }
  ];
  console.assert(isFirstTurn(messagesNoAssistant) === true, 'Should be first turn when no assistant');
  // Has assistant message -> not first turn
  const messagesWithAssistant: OpenAIChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
    { role: 'assistant', content: 'assistant' }
  ];
  console.assert(isFirstTurn(messagesWithAssistant) === false, 'Should not be first turn when assistant present');
  // Empty messages -> first turn (no assistant)
  console.assert(isFirstTurn([]) === true, 'Empty messages should be first turn');
}

// Tests for buildDeepSeekPrompt
console.log('Testing buildDeepSeekPrompt...');
{
  // First turn: system + tools + user
  const messagesFirstTurn: OpenAIChatMessage[] = [
    { role: 'system', content: 'system message' },
    { role: 'user', content: 'user message' }
  ];
  const toolsFirstTurn = [{ type: 'function', function: { name: 'test' } }];
  const promptFirstTurn = buildDeepSeekPrompt(messagesFirstTurn, toolsFirstTurn);
  const expectedFirstTurn = 'system message\n\n' + JSON.stringify(toolsFirstTurn) + '\n\nuser message';
  console.assert(promptFirstTurn === expectedFirstTurn, 'First turn prompt mismatch');
  // First turn: no system, no tools
  const messagesFirstTurnNoSysNoTools: OpenAIChatMessage[] = [
    { role: 'user', content: 'user message' }
  ];
  const promptFirstTurnNoSysNoTools = buildDeepSeekPrompt(messagesFirstTurnNoSysNoTools, undefined);
  console.assert(promptFirstTurnNoSysNoTools === 'user message', 'First turn with no system/no tools should be just user');
  // First turn: multiple system messages
  const messagesFirstTurnMultiSys: OpenAIChatMessage[] = [
    { role: 'system', content: 'system 1' },
    { role: 'system', content: 'system 2' },
    { role: 'user', content: 'user' }
  ];
  const promptFirstTurnMultiSys = buildDeepSeekPrompt(messagesFirstTurnMultiSys, undefined);
  const expectedMultiSys = 'system 1\n\nsystem 2\n\nuser';
  console.assert(promptFirstTurnMultiSys === expectedMultiSys, 'Multiple system messages should be concatenated with \\n\\n');
  // Continuation: latest user content only
  const messagesContinuation: OpenAIChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first user' },
    { role: 'assistant', content: 'assistant' },
    { role: 'user', content: 'second user' }
  ];
  const promptContinuation = buildDeepSeekPrompt(messagesContinuation, undefined);
  console.assert(promptContinuation === 'second user', 'Continuation should be latest user content only');
  // Continuation: latest user content is null -> should throw
  try {
    const messagesWithNullUser: OpenAIChatMessage[] = [
      { role: 'user', content: null as unknown as string },
      { role: 'assistant', content: 'assistant' }
    ];
    buildDeepSeekPrompt(messagesWithNullUser, undefined);
    console.assert(false, 'Should have thrown for null user content');
  } catch (e) {
    console.assert(e instanceof Error && e.message === 'No user message found', 'Should throw error for null user content');
  }
  // Continuation: latest user content undefined (missing content field) -> should throw (because we use == null)
  try {
    // This message has no content property at all
    const messagesWithMissingContent: OpenAIChatMessage[] = [
      { role: 'user' } as OpenAIChatMessage, // content is missing -> undefined
      { role: 'assistant', content: 'assistant' }
    ];
    buildDeepSeekPrompt(messagesWithMissingContent, undefined);
    console.assert(false, 'Should have thrown for missing content field');
  } catch (e) {
    console.assert(e instanceof Error && e.message === 'No user message found', 'Should throw error for missing content field');
  }
}

// Tests for mapOpenAIModelToDeepSeek
console.log('Testing mapOpenAIModelToDeepSeek...');
{
  console.assert(mapOpenAIModelToDeepSeek('V4-Pro') === 'expert', '"V4-Pro" should map to "expert"');
  console.assert(mapOpenAIModelToDeepSeek('V4.1-flash') === null, '"V4.1-flash" should map to null');
  console.assert(mapOpenAIModelToDeepSeek('unknown-model') === null, 'Unknown string should map to null');
  console.assert(mapOpenAIModelToDeepSeek(null) === null, 'null input should map to null');
  console.assert(mapOpenAIModelToDeepSeek(undefined) === null, 'undefined input should map to null');
  console.assert(mapOpenAIModelToDeepSeek(123 as unknown as string) === null, 'Non-string input should map to null');
}

// Tests for translateOpenAIRequest
console.log('Testing translateOpenAIRequest...');
{
  const openaiRequest: OpenAIChatCompletionRequest = {
    model: 'V4-Pro',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' }
    ],
    tools: [{ type: 'function', function: { name: 'test' } }],
    stream: false
  };
  const headers = createHeaders({ 'X-Session-Id': 'test-session-id' });
  const deepSeekInput = translateOpenAIRequest(openaiRequest, headers);
  console.assert(deepSeekInput.chat_session_id === undefined, 'chat_session_id should be undefined');
  console.assert(deepSeekInput.prompt === 'sys\n\n' + JSON.stringify([{ type: 'function', function: { name: 'test' } }]) + '\n\nuser', 'Prompt should be built correctly');
  console.assert(deepSeekInput.model_type === 'expert', 'Model type should be "expert" for V4-Pro');
  console.assert(deepSeekInput.thinking_enabled === false, 'thinking_enabled should default to false');
  console.assert(deepSeekInput.search_enabled === false, 'search_enabled should default to false');
  console.assert(deepSeekInput.xSessionId === 'test-session-id', 'xSessionId should be set from header');

  // Test with V4.1-flash
  openaiRequest.model = 'V4.1-flash';
  const deepSeekInput2 = translateOpenAIRequest(openaiRequest, headers);
  console.assert(deepSeekInput2.model_type === null, 'Model type should be null for V4.1-flash');

  // Test with no xSessionId header
  const headersNoSession = createHeaders({});
  const deepSeekInput3 = translateOpenAIRequest(openaiRequest, headersNoSession);
  console.assert(deepSeekInput3.xSessionId === undefined, 'xSessionId should be undefined when header absent');
}

console.log('All tests passed!');