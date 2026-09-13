// Translate DeepSeek SSE stream to OpenAI Chat Completions response (streaming or non-streaming).
/// <reference lib="dom" />
import { OpenAIChatCompletionResponse } from './types.js';

/**
 * Helper function to format an OpenAI SSE chunk line.
 * @param chunk The OpenAIChatCompletionStreamResponse object.
 * @returns A string like "data: {\"id\":...}\\n\\n"
 */
export function formatOpenAISSEChunk(chunk: any): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Helper function to emit the final [DONE] line.
 */
export function formatOpenAIDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * Translate a DeepSeek SSE stream to an OpenAI SSE stream.
 * @param deepSeekStream The raw SSE stream from deepseek_api.
 * @param openaiRequestInfo Information needed to construct OpenAI response chunks (model, id, created timestamp, etc.)
 * @returns A ReadableStream of OpenAI SSE chunk lines.
 */
export function translateDeepSeekStreamToSSE(
  deepSeekStream: ReadableStream<Uint8Array>,
  openaiRequestInfo: {
    model: string;
    id: string; // Will be set to chatcmpl-{responseMessageId}
    created: number; // Unix timestamp
  }
): ReadableStream<Uint8Array> {
  // State variables for the SSE parser
  let buffer = '';
  let currentEvent: string | null = null;
  let currentPath: string | null = null;
  let currentOp: string | null = null;
  let responseMessageId: string | null = null;
  let hasEmittedRole: boolean = false;
  let hasEmittedDone: boolean = false;
  let lastWasAppend: boolean = false;
  let accumulatedContent: string = '';

  return deepSeekStream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      // Split by lines, but keep the last incomplete line in buffer
      const lines = buffer.split('\n');
      // If the buffer ends with a newline, then the last element is an empty string and we have a complete line.
      // Otherwise, the last element is an incomplete line.
      const hasTrailingNewline = buffer.endsWith('\n');
      const processedLines = hasTrailingNewline ? lines : lines.slice(0, -1);
      buffer = hasTrailingNewline ? '' : lines[lines.length - 1];

      // Helper to emit a content chunk (handles role emission on first call)
      const emitContent = (text: string) => {
        if (!hasEmittedRole) {
          hasEmittedRole = true;
          const roleChunk = {
            id: `chatcmpl-${responseMessageId}`,
            object: 'chat.completion.chunk',
            created: openaiRequestInfo.created,
            model: openaiRequestInfo.model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
          };
          controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)));
        }
        accumulatedContent += text;
        const chunk = {
          id: `chatcmpl-${responseMessageId}`,
          object: 'chat.completion.chunk',
          created: openaiRequestInfo.created,
          model: openaiRequestInfo.model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        };
        controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)));
      };

      for (const line of processedLines) {
        // Reset currentEvent on blank line so events delimit correctly
        if (line.trim() === '') {
          currentEvent = null;
          continue;
        }
        if (line.startsWith('event:')) {
          const eventValue = line.substring(6).trim();
          currentEvent = eventValue;
          continue;
        }
        if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          try {
            const parsedJson = JSON.parse(dataStr);

            // Handle close event data: if the previous event was close, we emit [DONE] if not already.
            if (currentEvent === 'close') {
              if (!hasEmittedDone) {
                // Emit final chunk (if we haven't) and [DONE]
                const finalChunk = {
                  id: `chatcmpl-${responseMessageId}`,
                  object: 'chat.completion.chunk',
                  created: openaiRequestInfo.created,
                  model: openaiRequestInfo.model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                };
                controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)));
                controller.enqueue(new TextEncoder().encode(formatOpenAIDone()));
                hasEmittedDone = true;
              }
              // Skip further processing of this data line
              continue;
            }

            // Handle ready event to capture response_message_id
            if (currentEvent === 'ready' && typeof parsedJson.response_message_id === 'number') {
              responseMessageId = String(parsedJson.response_message_id);
            }

            // Handle update_session event for initial content
            if (currentEvent === 'update_session') {
              if (parsedJson.v?.response?.fragments?.[0]?.content !== undefined) {
                const initialContent = parsedJson.v.response.fragments[0].content;
                if (typeof initialContent === 'string') {
                  emitContent(initialContent);
                }
              }
            }

            // Update currentPath and currentOp if p and o are present
            if (parsedJson.p !== undefined && parsedJson.o !== undefined) {
              currentPath = parsedJson.p;
              currentOp = parsedJson.o;
              // Set lastWasAppend based on whether this is an APPEND to the content path
              lastWasAppend = (currentPath === "response/fragments/-1/content" && currentOp === "APPEND");
              // If this line is an APPEND to the content path and v is a string, append the content
              if (lastWasAppend && typeof parsedJson.v === "string") {
                emitContent(parsedJson.v);
              }
            } else {
              // No p and o in this data line
              // If we are in an appending state (last p/o line was an APPEND to the content path) and v is a string, append
              if (lastWasAppend && typeof parsedJson.v === "string") {
                emitContent(parsedJson.v);
              }
            }

            // Check for finish signals
            let isFinish = false;
            if (currentPath === "response/status" && currentOp === "SET") {
              if (typeof parsedJson.v === "string" && parsedJson.v === "FINISHED") {
                isFinish = true;
              }
            } else if (currentPath === "response" && currentOp === "BATCH") {
              if (Array.isArray(parsedJson.v)) {
                const quasiStatusObj = parsedJson.v.find((item: any) => item.p === "quasi_status" && item.v === "FINISHED");
                if (quasiStatusObj !== undefined) {
                  isFinish = true;
                }
              }
            }

            if (isFinish && !hasEmittedDone) {
              // Emit the final chunk with finish_reason: "stop"
              const finalChunk = {
                id: `chatcmpl-${responseMessageId}`,
                object: 'chat.completion.chunk',
                created: openaiRequestInfo.created,
                model: openaiRequestInfo.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              };
              controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)));
              controller.enqueue(new TextEncoder().encode(formatOpenAIDone()));
              hasEmittedDone = true;
            }
          } catch (e) {
            // Ignore invalid JSON
            continue;
          }
          continue;
        }
        // Ignore other lines
      }
    },
    flush(controller) {
      // If we have not emitted [DONE] yet, emit the final chunk and [DONE] now.
      if (!hasEmittedDone) {
        // Emit the final chunk with finish_reason: "stop"
        const finalChunk = {
          id: `chatcmpl-${responseMessageId}`,
          object: 'chat.completion.chunk',
          created: openaiRequestInfo.created,
          model: openaiRequestInfo.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)));
        controller.enqueue(new TextEncoder().encode(formatOpenAIDone()));
        hasEmittedDone = true;
      }
    }
  }));
}

/**
 * Translate a DeepSeek SSE stream to a full OpenAI chat completion JSON object (non-streaming).
 * @param deepSeekStream The raw SSE stream from deepseek_api.
 * @param openaiRequestInfo Information needed to construct OpenAI response (model, id, created timestamp, etc.)
 * @returns A Promise that resolves to the full OpenAI chat completion JSON object.
 */
export function translateDeepSeekStreamToJSON(
  deepSeekStream: ReadableStream<Uint8Array>,
  openaiRequestInfo: {
    model: string;
    id: string; // Will be set to chatcmpl-{responseMessageId}
    created: number; // Unix timestamp
  }
): Promise<OpenAIChatCompletionResponse> {
  // We'll collect the entire stream into a string, then parse it line by line using the same logic as the streaming version,
  // but instead of emitting chunks, we accumulate the content and detect the finish signals.
  // At the end, we build the OpenAI response object.

  return new Promise((resolve, reject) => {
    // State variables for the SSE parser
    let buffer = '';
    let currentEvent: string | null = null;
    let currentPath: string | null = null;
    let currentOp: string | null = null;
    let responseMessageId: string | null = null;
    let hasEmittedRole: boolean = false;
    let hasEmittedDone: boolean = false;
    let lastWasAppend: boolean = false;
    let accumulatedContent: string = '';
    let accumulatedTokens: number = 0; // To store accumulated_token_usage from BATCH

    const reader = deepSeekStream.getReader();
    const pump = (): Promise<void> => {
      return reader.read().then((result: ReadableStreamReadResult<Uint8Array>) => {
        const { done, value } = result;
        if (done) {
          // Process the entire buffer line by line, similar to the streaming version
          const lines = buffer.split('\n');
          // If the buffer ends with a newline, then the last element is an empty string and we have a complete line.
          // Otherwise, the last element is an incomplete line.
          const hasTrailingNewline = buffer.endsWith('\n');
          const processedLines = hasTrailingNewline ? lines : lines.slice(0, -1);
          buffer = hasTrailingNewline ? '' : lines[lines.length - 1];

          for (const line of processedLines) {
            // Reset currentEvent on blank line so events delimit correctly
            if (line.trim() === '') {
              currentEvent = null;
              continue;
            }
            if (line.startsWith('event:')) {
              const eventValue = line.substring(6).trim();
              currentEvent = eventValue;
              continue;
            }
            if (line.startsWith('data:')) {
              const dataStr = line.substring(5).trim();
              try {
                const parsedJson = JSON.parse(dataStr);

                // Handle close event data: if the previous event was close, we treat it as finished.
                if (currentEvent === 'close') {
                  if (!hasEmittedDone) {
                    hasEmittedDone = true;
                  }
                  // Skip further processing of this data line
                } else {
                  // Handle ready event to capture response_message_id
                  if (currentEvent === 'ready' && typeof parsedJson.response_message_id === 'number') {
                    responseMessageId = String(parsedJson.response_message_id);
                  }

                  // Handle update_session event for initial content
                  if (currentEvent === 'update_session') {
                    if (parsedJson.v?.response?.fragments?.[0]?.content !== undefined) {
                      const initialContent = parsedJson.v.response.fragments[0].content;
                      if (typeof initialContent === 'string' && !hasEmittedRole) {
                        accumulatedContent += initialContent;
                        hasEmittedRole = true;
                      }
                    }
                  }

                  // Update currentPath and currentOp if p and o are present
                  if (parsedJson.p !== undefined && parsedJson.o !== undefined) {
                    currentPath = parsedJson.p;
                    currentOp = parsedJson.o;
                    // Set lastWasAppend based on whether this is an APPEND to the content path
                    lastWasAppend = (currentPath === "response/fragments/-1/content" && currentOp === "APPEND");
                    // If this line is an APPEND to the content path and v is a string, append the content
                    if (lastWasAppend && typeof parsedJson.v === "string") {
                      accumulatedContent += parsedJson.v;
                    }
                  } else {
                    // No p and o in this data line
                    // If we are in an appending state (last p/o line was an APPEND to the content path) and v is a string, append
                    if (lastWasAppend && typeof parsedJson.v === "string") {
                      accumulatedContent += parsedJson.v;
                    }
                  }

                  // Check for finish signals and accumulate token usage
                  let isFinish = false;
                  if (currentPath === "response/status" && currentOp === "SET") {
                    if (typeof parsedJson.v === "string" && parsedJson.v === "FINISHED") {
                      isFinish = true;
                    }
                  } else if (currentPath === "response" && currentOp === "BATCH") {
                    if (Array.isArray(parsedJson.v)) {
                      // Look for accumulated_token_usage in the BATCH array
                      const usageObj = parsedJson.v.find((item: any) => item.p === "accumulated_token_usage");
                      if (usageObj !== undefined && typeof usageObj.v === "number") {
                        accumulatedTokens = usageObj.v;
                      }
                      const quasiStatusObj = parsedJson.v.find((item: any) => item.p === "quasi_status" && item.v === "FINISHED");
                      if (quasiStatusObj !== undefined) {
                        isFinish = true;
                      }
                    }
                  }

                  if (isFinish) {
                    hasEmittedDone = true;
                    // We don't break here because we want to consume the rest of the stream? But we can break to save time.
                    // However, we must still parse the rest of the stream to get the buffer ready for the next line? 
                    // Since we are not emitting chunks, we can break early.
                    // But note: we might have multiple finish signals? We'll just set the flag and continue.
                  }
                }
              } catch (e) {
                // Ignore invalid JSON
              }
            }
          }

          // If we have not encountered a finish signal, we treat it as finished anyway.
          if (!hasEmittedDone) {
            hasEmittedDone = true;
          }

          // Build the OpenAI response object
          const response: OpenAIChatCompletionResponse = {
            id: `chatcmpl-${responseMessageId}`,
            object: 'chat.completion',
            created: openaiRequestInfo.created,
            model: openaiRequestInfo.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: accumulatedContent
                },
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: accumulatedTokens,
              total_tokens: accumulatedTokens
            }
          };

          resolve(response);
          return;
        }

        buffer += new TextDecoder().decode(value);
        return pump();
      });
    };

    pump().catch(reject);
  });
}