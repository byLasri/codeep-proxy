import { OpenAICompletionRequest } from './types.js'
import { extractLatestUserPrompt, translateToDeepSeekInput } from './request.js'
import { 
  IncrementalSSEParser, 
  parseDeepSeekEvents,
  normalizeDeepSeekEvents,
  TypedDeepSeekEvent,
} from './sse.js'
import type { DeepSeekWebClient, DeepSeekSession } from '../deepseek/index.js'

/**
 * Stateless service for handling OpenAI-compatible completions
 * Uses protocol-compliant SSE parsing and patch application
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
   * Uses normalized completion events for proper protocol translation
   */
  private createStreamingResponse(
    deepSeekBody: ReadableStream<Uint8Array>,
    model: string,
    chat_session_id: string
  ): Response {
    const completionId = `chatcmpl-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    
    // State tracking
    let modelTypeFromReady: string | null = null
    let hasSentRole = false
    let isCompleted = false
    
    const encoder = new TextEncoder()
    
    // Create exactly one parser instance per response
    const parser = new IncrementalSSEParser()

    const openaiStream = deepSeekBody.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          // Parse chunk into raw SSE frames
          const frames = parser.parseChunk(chunk)
          
          if (frames.length === 0) {
            return // No complete frames yet
          }
          
          // Convert frames to typed DeepSeek events
          const typedEvents = parseDeepSeekEvents(frames)
          
          // Normalize to completion events
          const normalizedEvents = normalizeDeepSeekEvents(typedEvents)
          
          // Process normalized events
          for (const evt of normalizedEvents) {
            // Handle ready event - extract model_type
            if (evt.type === 'ready') {
              modelTypeFromReady = evt.modelType
              continue // Internal metadata, not sent to client
            }
            
            // Handle content deltas
            if (evt.type === 'content_delta') {
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
                  delta: { content: evt.text },
                  finish_reason: null,
                }],
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
            }
            
            // Handle reasoning deltas (if web-client schema supports it)
            if (evt.type === 'reasoning_delta') {
              // For now, reasoning is internal - could be exposed via custom field
              // Not sending to standard OpenAI clients
            }
            
            // Handle completed event - send final chunk exactly once
            if (evt.type === 'completed' && !isCompleted) {
              isCompleted = true
              const finalChunk = {
                id: completionId,
                object: 'chat.completion.chunk' as const,
                created,
                model: modelTypeFromReady ?? model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: evt.finishReason,
                }],
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            }
            
            // Metadata events are internal only
          }
        },
        
        flush: (controller) => {
          // Finalize the parser at EOF
          const finalFrames = parser.finalize()
          
          if (finalFrames.length > 0) {
            const typedEvents = parseDeepSeekEvents(finalFrames)
            const normalizedEvents = normalizeDeepSeekEvents(typedEvents)
            
            for (const evt of normalizedEvents) {
              if (evt.type === 'ready') {
                modelTypeFromReady = evt.modelType
                continue
              }
              
              if (evt.type === 'content_delta') {
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
                
                const contentChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk' as const,
                  created,
                  model: modelTypeFromReady ?? model,
                  choices: [{
                    index: 0,
                    delta: { content: evt.text },
                    finish_reason: null,
                  }],
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
              }
              
              if (evt.type === 'completed' && !isCompleted) {
                isCompleted = true
                const finalChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk' as const,
                  created,
                  model: modelTypeFromReady ?? model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: evt.finishReason,
                  }],
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              }
            }
          }
          
          // Ensure final chunk if we sent content but no close event
          if (hasSentRole && !isCompleted) {
            isCompleted = true
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
   * Consumes entire stream, finalizes parser, applies all patches, reconstructs state
   */
  private async createNonStreamingResponse(
    deepSeekBody: ReadableStream<Uint8Array>,
    model: string,
    chat_session_id: string
  ): Promise<Response> {
    const completionId = `chatcmpl-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let modelTypeFromReady: string | null = null

    // Create exactly one parser instance per response
    const parser = new IncrementalSSEParser()
    
    // Accumulate typed events for processing after stream ends
    const allTypedEvents: TypedDeepSeekEvent[] = []

    const reader = deepSeekBody.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // Parse chunk into raw SSE frames
        const frames = parser.parseChunk(value)
        
        if (frames.length > 0) {
          // Convert to typed events
          const typedEvents = parseDeepSeekEvents(frames)
          allTypedEvents.push(...typedEvents)
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Finalize the parser at EOF
    const finalFrames = parser.finalize()
    if (finalFrames.length > 0) {
      const finalTypedEvents = parseDeepSeekEvents(finalFrames)
      allTypedEvents.push(...finalTypedEvents)
    }

    // Normalize all events - this applies patches and generates deltas
    const normalizedEvents = normalizeDeepSeekEvents(allTypedEvents)

    // Extract model_type from ready event
    for (const evt of normalizedEvents) {
      if (evt.type === 'ready') {
        modelTypeFromReady = evt.modelType
        break
      }
    }

    // Build final content from accumulated deltas
    let fullContent = ''
    for (const evt of normalizedEvents) {
      if (evt.type === 'content_delta') {
        fullContent += evt.text
      }
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