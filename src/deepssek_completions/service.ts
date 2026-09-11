import { OpenAICompletionRequest, CompletionSessionState, DeepSeekCompletionInput } from './types.js';
import { extractLatestUserPrompt, translateToDeepSeekInput } from './request.js';
import { parseSSEEvents, extractResponseMessageId, extractContentDeltas } from './sse.js';
import type { DeepSeekWebClient, DeepSeekSession } from '../deepseek/index.js';

/**
 * Service for handling OpenAI-compatible completions
 */
export class CompletionService {
  constructor(private readonly deepSeekClient: DeepSeekWebClient) {}

  /**
   * Process a completion request
   */
  async processCompletion(
    request: OpenAICompletionRequest,
    sessionState: CompletionSessionState | null
  ): Promise<{
    stream: ReadableStream<Uint8Array>;
    newState: CompletionSessionState;
  }> {
    // Extract prompt from messages
    const prompt = extractLatestUserPrompt(request.messages);

    let chat_session_id: string;
    let parent_message_id: number | null;

    if (sessionState) {
      // Reuse existing session
      chat_session_id = sessionState.chat_session_id;
      parent_message_id = sessionState.parent_message_id;
    } else {
      // Create new DeepSeek session
      const newSession = await this.deepSeekClient.createSession();
      chat_session_id = newSession.id;
      parent_message_id = null;
    }

    // Build DeepSeek completion input with all required fields
    const input: DeepSeekCompletionInput = translateToDeepSeekInput(
      chat_session_id,
      parent_message_id,
      prompt
    );

    // Call DeepSeek completion
    const response = await this.deepSeekClient.complete(input);

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
    }

    // Read and parse SSE response
    const rawText = await response.text();
    const events = parseSSEEvents(rawText);

    // Extract new parent_message_id from ready event
    const responseMessageId = extractResponseMessageId(events);
    if (responseMessageId === null) {
      throw new Error('Missing ready.response_message_id in DeepSeek response');
    }

    // Update session state
    const newState: CompletionSessionState = {
      chat_session_id,
      parent_message_id: responseMessageId,
      updated_at: Date.now(),
    };

    // Generate OpenAI-compatible SSE stream
    const stream = this.generateOpenAISSEStream(events, request.model);

    return { stream, newState };
  }

  /**
   * Generate OpenAI-compatible SSE stream from DeepSeek events
   */
  private generateOpenAISSEStream(
    events: unknown[],
    model: string
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const deltas = extractContentDeltas(events as Array<{ event: string; data: unknown }>);

    return new ReadableStream({
      start(controller) {
        const requestId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        // Send content deltas
        for (const delta of deltas) {
          const chunk = {
            id: requestId,
            object: 'chat.completion.chunk' as const,
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: delta,
                },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        // Send final chunk with finish_reason
        const finalChunk = {
          id: requestId,
          object: 'chat.completion.chunk' as const,
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
  }
}
