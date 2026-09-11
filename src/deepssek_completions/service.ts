import { OpenAICompletionRequest, CompletionSessionState, DeepSeekCompletionInput } from './types.js';
import { extractLatestUserPrompt, translateToDeepSeekInput } from './request.js';
import { IncrementalSSEParser, DeepSeekSSEEvent, ReadyEvent, DataEvent } from './sse.js';
import type { DeepSeekWebClient, DeepSeekSession } from '../deepseek/index.js';

/**
 * Service for handling OpenAI-compatible completions
 */
export class CompletionService {
  constructor(private readonly deepSeekClient: DeepSeekWebClient) {}

  /**
   * Process a completion request - returns the appropriate response based on stream flag
   */
  async processCompletion(
    request: OpenAICompletionRequest,
    sessionState: CompletionSessionState | null,
    env: { AUTH_KV: KVNamespace }
  ): Promise<Response> {
    const isStreaming = request.stream ?? true;
    
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

    if (!response.body) {
      throw new Error('DeepSeek API returned no body');
    }

    // Generate OpenAI-compatible response
    if (isStreaming) {
      return this.createStreamingResponse(
        response.body,
        request.model,
        chat_session_id,
        parent_message_id,
        env
      );
    } else {
      return this.createNonStreamingResponse(
        response.body,
        request.model,
        chat_session_id,
        parent_message_id,
        env
      );
    }
  }

  /**
   * Create streaming SSE response
   */
  private createStreamingResponse(
    deepSeekBody: ReadableStream<Uint8Array>,
    model: string,
    chat_session_id: string,
    initial_parent_message_id: number | null,
    env: { AUTH_KV: KVNamespace }
  ): Response {
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let parent_message_id = initial_parent_message_id;

    const transformStream = new TransformStream<Uint8Array, Uint8Array>({
      transform: async (chunk, controller) => {
        // This will be handled by the pipeThrough below
      }
    });

    const encoder = new TextEncoder();
    let hasSentRole = false;
    let contentBuffer = '';

    const openaiStream = deepSeekBody.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          const parser = new IncrementalSSEParser();
          const events = parser.parseChunk(chunk);
          
          for (const evt of events) {
            // Handle ready event - extract response_message_id
            if (evt.event === 'ready') {
              const readyData = evt.data as Partial<ReadyEvent>;
              if (typeof readyData.response_message_id === 'number') {
                parent_message_id = readyData.response_message_id;
              }
              continue; // Skip ready events - internal to DeepSeek
            }

            // Handle data events - extract content deltas
            if (evt.event === 'data') {
              const dataEvt = evt.data as DataEvent;
              const response = dataEvt.v?.response;
              
              let contentDelta: string | null = null;
              
              // Canonical extraction: prefer fragments over direct content
              if (response?.fragments) {
                for (const frag of response.fragments) {
                  if (frag.o === 'APPEND' && typeof frag.v === 'string') {
                    contentDelta = (contentDelta || '') + frag.v;
                  }
                }
              } else if (response?.content && typeof response.content === 'string') {
                contentDelta = response.content;
              }

              if (contentDelta) {
                contentBuffer += contentDelta;
                
                // First chunk: send role
                if (!hasSentRole) {
                  const roleChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk' as const,
                    created,
                    model,
                    choices: [{
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null,
                    }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
                  hasSentRole = true;
                }

                // Send content delta
                const contentChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk' as const,
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: contentDelta },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
              }
            }

            // Handle close event - send final chunk
            if (evt.event === 'close') {
              const finalChunk = {
                id: completionId,
                object: 'chat.completion.chunk' as const,
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
          }
        },
        flush: (controller) => {
          // Ensure we send final chunk if stream ends without explicit close
          if (hasSentRole) {
            const finalChunk = {
              id: completionId,
              object: 'chat.completion.chunk' as const,
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
        }
      })
    );

    // Save updated session state asynchronously (don't block streaming)
    this.saveSessionStateAsync(chat_session_id, parent_message_id, env);

    return new Response(openaiStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  }

  /**
   * Create non-streaming JSON response
   */
  private async createNonStreamingResponse(
    deepSeekBody: ReadableStream<Uint8Array>,
    model: string,
    chat_session_id: string,
    initial_parent_message_id: number | null,
    env: { AUTH_KV: KVNamespace }
  ): Promise<Response> {
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let parent_message_id = initial_parent_message_id;

    const decoder = new TextDecoder();
    const parser = new IncrementalSSEParser();
    let fullContent = '';
    let hasReceivedData = false;

    const reader = deepSeekBody.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const events = parser.parseChunk(value);
        
        for (const evt of events) {
          if (evt.event === 'ready') {
            const readyData = evt.data as Partial<ReadyEvent>;
            if (typeof readyData.response_message_id === 'number') {
              parent_message_id = readyData.response_message_id;
            }
          } else if (evt.event === 'data') {
            hasReceivedData = true;
            const dataEvt = evt.data as DataEvent;
            const response = dataEvt.v?.response;
            
            if (response?.fragments) {
              for (const frag of response.fragments) {
                if (frag.o === 'APPEND' && typeof frag.v === 'string') {
                  fullContent += frag.v;
                }
              }
            } else if (response?.content && typeof response.content === 'string') {
              fullContent += response.content;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Save updated session state
    await this.saveSessionState(chat_session_id, parent_message_id, env);

    const responseBody = {
      id: completionId,
      object: 'chat.completion' as const,
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent,
        },
        finish_reason: 'stop',
      }],
    };

    return new Response(JSON.stringify(responseBody), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Save session state asynchronously (non-blocking)
   */
  private async saveSessionStateAsync(
    chat_session_id: string,
    parent_message_id: number | null,
    env: { AUTH_KV: KVNamespace }
  ): Promise<void> {
    // Fire and forget - don't block streaming
    this.saveSessionState(chat_session_id, parent_message_id, env).catch(console.error);
  }

  /**
   * Save session state to KV storage
   */
  private async saveSessionState(
    chat_session_id: string,
    parent_message_id: number | null,
    env: { AUTH_KV: KVNamespace }
  ): Promise<void> {
    // Store in a key derived from chat_session_id
    const stateKey = `session:${chat_session_id}`;
    const state: CompletionSessionState = {
      chat_session_id,
      parent_message_id,
      updated_at: Date.now(),
    };
    await env.AUTH_KV.put(stateKey, JSON.stringify(state));
  }
}
