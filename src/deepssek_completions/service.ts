import { OpenAICompletionRequest } from './types.js'
import { extractLatestUserPrompt, translateToDeepSeekInput } from './request.js'
import { IncrementalSSEParser, DeepSeekSSEEvent, ReadyEvent, DataEvent } from './sse.js'
import type { DeepSeekWebClient, DeepSeekSession } from '../deepseek/index.js'

/**
 * Stateless service for handling OpenAI-compatible completions
 */
export class CompletionService {
  constructor(private readonly deepSeekClient: DeepSeekWebClient) {}

  /**
   * Process a completion request - returns the appropriate response based on stream flag
   * Creates a fresh DeepSeek session for every request (stateless)
   */
  async processCompletion(request: OpenAICompletionRequest): Promise<Response> {
    const isStreaming = request.stream ?? true

    // Extract prompt from messages
    const prompt = extractLatestUserPrompt(request.messages)

    // Create fresh DeepSeek session for this request
    const newSession = await this.deepSeekClient.createSession()
    const chat_session_id = newSession.id
    const parent_message_id = null

    // Map OpenAI model to DeepSeek model_type
    const modelType = this.mapModelToDeepSeek(request.model)

    // Build DeepSeek completion input
    const input = translateToDeepSeekInput(chat_session_id, parent_message_id, prompt, modelType)

    // Call DeepSeek completion
    const response = await this.deepSeekClient.complete(input)

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error('DeepSeek API returned no body')
    }

    // Generate OpenAI-compatible response
    if (isStreaming) {
      return this.createStreamingResponse(response.body, request.model, chat_session_id)
    } else {
      return this.createNonStreamingResponse(response.body, request.model, chat_session_id)
    }
  }

  /**
   * Map OpenAI model name to DeepSeek model_type
   * - deepseek-chat -> null (default)
   * - deepseek-reasoner / expert -> "expert"
   * - default -> null
   */
  private mapModelToDeepSeek(model: string): string | null {
    if (model === 'deepseek-reasoner' || model === 'expert') {
      return 'expert'
    }
    // deepseek-chat or any other model defaults to null (default/Instant path)
    return null
  }

  /**
   * Create streaming SSE response
   */
  private createStreamingResponse(
    deepSeekBody: ReadableStream<Uint8Array>,
    model: string,
    chat_session_id: string
  ): Response {
    const completionId = `chatcmpl-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let modelTypeFromReady: string | null = null
    let hasSentRole = false

    const encoder = new TextEncoder()

    const openaiStream = deepSeekBody.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          const parser = new IncrementalSSEParser()
          const events = parser.parseChunk(chunk)

          for (const evt of events) {
            // Handle ready event - extract model_type for OpenAI response
            if (evt.event === 'ready') {
              const readyData = evt.data as Partial<ReadyEvent>
              if (typeof readyData.model_type === 'string') {
                modelTypeFromReady = readyData.model_type
              }
              continue // Skip ready events - internal to DeepSeek
            }

            // Handle data events - extract content deltas
            if (evt.event === 'data') {
              const dataEvt = evt.data as DataEvent
              const response = dataEvt.v?.response

              let contentDelta: string | null = null

              // Canonical extraction: prefer fragments over direct content
              if (response?.fragments) {
                for (const frag of response.fragments) {
                  if (frag.o === 'APPEND' && typeof frag.v === 'string') {
                    contentDelta = (contentDelta || '') + frag.v
                  }
                }
              } else if (response?.content && typeof response.content === 'string') {
                contentDelta = response.content
              }

              if (contentDelta) {
                // First chunk: send role
                if (!hasSentRole) {
                  const roleChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk' as const,
                    created,
                    model: modelTypeFromReady ?? model,
                    choices: [{
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null,
                    }],
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`))
                  hasSentRole = true
                }

                // Send content delta
                const contentChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk' as const,
                  created,
                  model: modelTypeFromReady ?? model,
                  choices: [{
                    index: 0,
                    delta: { content: contentDelta },
                    finish_reason: null,
                  }],
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
              }
            }

            // Handle close event - send final chunk
            if (evt.event === 'close') {
              const finalChunk = {
                id: completionId,
                object: 'chat.completion.chunk' as const,
                created,
                model: modelTypeFromReady ?? model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
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
              model: modelTypeFromReady ?? model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
              }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          }
        }
      })
    )

    return new Response(openaiStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    })
  }

  /**
   * Create non-streaming JSON response
   */
  private async createNonStreamingResponse(
    deepSeekBody: ReadableStream<Uint8Array>,
    model: string,
    chat_session_id: string
  ): Promise<Response> {
    const completionId = `chatcmpl-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let modelTypeFromReady: string | null = null

    const decoder = new TextDecoder()
    const parser = new IncrementalSSEParser()
    let fullContent = ''
    let hasReceivedData = false

    const reader = deepSeekBody.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const events = parser.parseChunk(value)

        for (const evt of events) {
          if (evt.event === 'ready') {
            const readyData = evt.data as Partial<ReadyEvent>
            if (typeof readyData.model_type === 'string') {
              modelTypeFromReady = readyData.model_type
            }
          } else if (evt.event === 'data') {
            hasReceivedData = true
            const dataEvt = evt.data as DataEvent
            const response = dataEvt.v?.response

            if (response?.fragments) {
              for (const frag of response.fragments) {
                if (frag.o === 'APPEND' && typeof frag.v === 'string') {
                  fullContent += frag.v
                }
              }
            } else if (response?.content && typeof response.content === 'string') {
              fullContent += response.content
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const responseBody = {
      id: completionId,
      object: 'chat.completion' as const,
      created,
      model: modelTypeFromReady ?? model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent,
        },
        finish_reason: 'stop',
      }],
    }

    return new Response(JSON.stringify(responseBody), {
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }
}