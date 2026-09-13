// Translate DeepSeek SSE stream to OpenAI Chat Completions response (streaming or non-streaming).

/**
 * State for the SSE parser.
 */
interface SSEParserState {
  currentEvent: string | null;
  currentData: string;
  currentPath: string | null;
  currentOp: string | null;
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
  let accumulatedContent: string = '';

  const handleDataLine = (parsedJson: any, event: string | null, controller: TransformStreamDefaultController<Uint8Array>) => {
    // Handle update_session event for initial content
    if (event === "update_session") {
      if (parsedJson.v?.response?.fragments?.[0]?.content !== undefined) {
        const initialContent = parsedJson.v.response.fragments[0].content;
        if (!hasEmittedRole) {
          const chunk = createOpenAIChunk({
            role: 'assistant',
            content: initialContent
          }, false);
          emitChunk(chunk, controller);
          hasEmittedRole = true;
        }
      }
    }

    // Update currentPath and currentOp if p and o are present
    if (parsedJson.p !== undefined && parsedJson.o !== undefined) {
      currentPath = parsedJson.p;
      currentOp = parsedJson.o;
    }

    // Handle content appends
    if (parsedJson.v !== undefined) {
      const isAppendLine = (currentPath === "response/fragments/-1/content" && currentOp === "APPEND");
      if (isAppendLine) {
        accumulatedContent += parsedJson.v;
        const chunk = createOpenAIChunk({
          content: parsedJson.v
        }, false);
        emitChunk(chunk, controller);
      } else {
        // If we have a currentPath and currentOp set (from a previous data line) and we have a v field, we append.
        // Note: currentPath and currentOp might have been set by this data line if it had p and o but not the append condition.
        if (currentPath !== null && currentOp !== null && parsedJson.v !== undefined) {
          accumulatedContent += parsedJson.v;
          const chunk = createOpenAIChunk({
            content: parsedJson.v
          }, false);
          emitChunk(chunk, controller);
        }
      }
    }

    // Check for finish signals
    let isFinish = false;
    if (currentPath === "response" && currentOp === "SET") {
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
      const finalChunk = createOpenAIChunk({}, true);
      emitChunk(finalChunk, controller);
      emitDone(controller);
      hasEmittedDone = true;
    }
  };

  // Helper functions that do not need controller
  const formatOpenAISSEChunk = (chunk: any): string => {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  const formatOpenAIDone = (): string => {
    return 'data: [DONE]\n\n';
  };

  const createOpenAIChunk = (delta: { role?: string; content?: string }, isFinal: boolean): any => {
    let finish_reason: string | undefined = undefined;
    if (isFinal) {
      finish_reason = "stop";
    }
    return {
      id: `chatcmpl-${responseMessageId}`,
      object: 'chat.completion.chunk',
      created: openaiRequestInfo.created,
      model: openaiRequestInfo.model,
      choices: [
        {
          index: 0,
          delta: delta,
          finish_reason: finish_reason
        }
      ]
    };
  };

  const emitChunk = (chunk: any, controller: TransformStreamDefaultController<Uint8Array>) => {
    const chunkLine = formatOpenAISSEChunk(chunk);
    controller.enqueue(new TextEncoder().encode(chunkLine));
  };

  const emitDone = (controller: TransformStreamDefaultController<Uint8Array>) => {
    const doneLine = formatOpenAIDone();
    controller.enqueue(new TextEncoder().encode(doneLine));
  };

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

      for (const line of processedLines) {
        if (line.trim() === '') {
          // Blank line: ignore (we don't use blank lines to delimit events)
          continue;
        }
        if (line.startsWith('event:')) {
          const eventValue = line.substring(6).trim();
          currentEvent = eventValue;
          // If we see a close event, we don't reset currentPath and currentOp? We'll leave them.
          // We'll handle the close event in the data line handler.
          continue;
        }
        if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          try {
            const parsedJson = JSON.parse(dataStr);
            handleDataLine(parsedJson, currentEvent, controller);
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
      // Process any remaining buffer
      if (buffer !== '') {
        // We'll treat the remaining buffer as a line (even if it doesn't end with newline)
        const line = buffer;
        buffer = '';
        if (line.trim() !== '') {
          if (line.startsWith('event:')) {
            const eventValue = line.substring(6).trim();
            currentEvent = eventValue;
          } else if (line.startsWith('data:')) {
            const dataStr = line.substring(5).trim();
            try {
              const parsedJson = JSON.parse(dataStr);
              handleDataLine(parsedJson, currentEvent, controller);
            } catch (e) {
              // Ignore
            }
          }
        }
      }

      // If we have not emitted [DONE] yet, emit the final chunk and [DONE] now.
      if (!hasEmittedDone) {
        // Emit the final chunk with finish_reason: "stop"
        const finalChunk = createOpenAIChunk({}, true);
        emitChunk(finalChunk, controller);
        emitDone(controller);
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
): Promise<any> {
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
    let accumulatedContent: string = '';

    const handleDataLine = (parsedJson: any, event: string | null) => {
      // Handle update_session event for initial content
      if (event === "update_session") {
        if (parsedJson.v?.response?.fragments?.[0]?.content !== undefined) {
          const initialContent = parsedJson.v.response.fragments[0].content;
          if (!hasEmittedRole) {
            accumulatedContent += initialContent;
            hasEmittedRole = true;
          }
        }
      }

      // Update currentPath and currentOp if p and o are present
      if (parsedJson.p !== undefined && parsedJson.o !== undefined) {
        currentPath = parsedJson.p;
        currentOp = parsedJson.o;
      }

      // Handle content appends
      if (parsedJson.v !== undefined) {
        const isAppendLine = (currentPath === "response/fragments/-1/content" && currentOp === "APPEND");
        if (isAppendLine) {
          accumulatedContent += parsedJson.v;
        } else {
          if (currentPath !== null && currentOp !== null && parsedJson.v !== undefined) {
            accumulatedContent += parsedJson.v;
          }
        }
      }

      // Check for finish signals
      let isFinish = false;
      if (currentPath === "response" && currentOp === "SET") {
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

      if (isFinish) {
        hasEmittedDone = true;
        // We don't break here because we want to consume the rest of the stream? But we can break to save time.
        // However, we must still parse the rest of the stream to get the buffer ready for the next line? 
        // Since we are not emitting chunks, we can break early.
        // But note: we might have multiple finish signals? We'll just set the flag and continue.
      }
    };

    const reader = deepSeekStream.getReader();
    const pump = (): Promise<void> => {
      return reader.read().then(({ done, value }) => {
        if (done) {
          // Process any remaining buffer
          if (buffer !== '') {
            const line = buffer;
            buffer = '';
            if (line.trim() !== '') {
              if (line.startsWith('event:')) {
                const eventValue = line.substring(6).trim();
                currentEvent = eventValue;
              } else if (line.startsWith('data:')) {
                const dataStr = line.substring(5).trim();
                try {
                  const parsedJson = JSON.parse(dataStr);
                  handleDataLine(parsedJson, currentEvent);
                } catch (e) {
                  // Ignore
                }
              }
            }
          }

          // If we have not encountered a finish signal, we treat it as finished anyway.
          if (!hasEmittedDone) {
            hasEmittedDone = true;
          }

          // Build the OpenAI response object
          const response = {
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
              completion_tokens: 0,
              total_tokens: 0
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