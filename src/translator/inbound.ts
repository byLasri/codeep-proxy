import type { OpenAIChatCompletionResponse, OpenAIChatCompletionStreamResponse, ToolCall } from './types.js'
import type { RequestLogger } from '../observability/logger.js'
import type { ParserEvent, ParserError, ToolCall as ParserToolCall } from '../parser/index.js'

export function formatOpenAISSEChunk(chunk: OpenAIChatCompletionStreamResponse): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function formatOpenAIDone(): string {
  return 'data: [DONE]\n\n'
}

function mapToolCall(tc: ParserToolCall): ToolCall {
  return {
    id: tc.id,
    type: tc.type,
    function: tc.function
  }
}

interface SSEEventHandlerContext {
  enqueue: (chunk: Uint8Array) => void
  hasEmittedRole: () => boolean
  setHasEmittedRole: (v: boolean) => void
  responseMessageId: () => string
  setResponseMessageId: (v: string) => void
  hasEmittedToolCalls: () => boolean
  setHasEmittedToolCalls: (v: boolean) => void
  toolCallIndex: () => number
  incrementToolCallIndex: () => void
}

function handleParserEventSSE(
  event: ParserEvent,
  info: { model: string; id: string; created: number },
  ctx: SSEEventHandlerContext
): void {
  switch (event.type) {
    case 'session_id': {
      ctx.setResponseMessageId(event.id)
      break
    }
    case 'reasoning': {
      if (!ctx.hasEmittedRole()) {
        ctx.setHasEmittedRole(true)
        const roleChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${ctx.responseMessageId()}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }
        ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
      }
      const chunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${ctx.responseMessageId()}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
      }
      ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
      break
    }
    case 'content': {
      if (!ctx.hasEmittedRole()) {
        ctx.setHasEmittedRole(true)
        const roleChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${ctx.responseMessageId()}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }
        ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
      }
      const chunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${ctx.responseMessageId()}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
      }
      ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
      break
    }
    case 'tool_calls': {
      if (event.toolCalls.length > 0) {
        ctx.setHasEmittedToolCalls(true)
        const baseIndex = ctx.toolCallIndex()
        const toolCallChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${ctx.responseMessageId()}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: event.toolCalls.map((tc, idx) => ({
                index: baseIndex + idx,
                id: tc.id,
                type: tc.type,
                function: tc.function
              }))
            },
            finish_reason: null
          }]
        }
        ctx.incrementToolCallIndex()
        ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(toolCallChunk)))
      }
      break
    }
    case 'done': {
      const finalChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${ctx.responseMessageId()}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: {}, finish_reason: ctx.hasEmittedToolCalls() ? 'tool_calls' : 'stop' }],
      }
      ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))
      
      if (event.state.accumulatedTokens > 0) {
        const usageChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${ctx.responseMessageId()}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [],
          usage: {
            prompt_tokens: 0,
            completion_tokens: event.state.accumulatedTokens,
            total_tokens: event.state.accumulatedTokens,
          },
        }
        ctx.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(usageChunk)))
      }
      ctx.enqueue(new TextEncoder().encode(formatOpenAIDone()))
      break
    }
    case 'tokens': {
      break
    }
    case 'error': {
      ctx.enqueue(new TextEncoder().encode(
        formatOpenAISSEChunk({
          id: `chatcmpl-${ctx.responseMessageId()}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          error: { message: event.error.message, type: 'parser_error' },
        } as OpenAIChatCompletionStreamResponse)
      ))
      break
    }
  }
}

export async function translateParserEventsToSSE(
  events: AsyncIterable<ParserEvent>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): Promise<ReadableStream<Uint8Array>> {
  let hasEmittedRole = false
  let responseMessageId: string = 'null'
  let hasEmittedToolCalls = false
  let toolCallIndex = 0

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: Uint8Array) => {
        controller.enqueue(chunk)
      }

      const ctx: SSEEventHandlerContext = {
        enqueue,
        hasEmittedRole: () => hasEmittedRole,
        setHasEmittedRole: (v: boolean) => { hasEmittedRole = v },
        responseMessageId: () => responseMessageId,
        setResponseMessageId: (v: string) => { responseMessageId = v },
        hasEmittedToolCalls: () => hasEmittedToolCalls,
        setHasEmittedToolCalls: (v: boolean) => { hasEmittedToolCalls = v },
        toolCallIndex: () => toolCallIndex,
        incrementToolCallIndex: () => { toolCallIndex += 1; },
      }

      try {
        for await (const event of events) {
          handleParserEventSSE(event, info, ctx)
        }
      } finally {
        controller.close()
      }
    },
  })

  if (logger) {
    logger.logOutgoingToClient({ info, event: 'sse_stream_complete' })
  }

  return stream
}

interface JSONAccumulatorContext {
  accumulatedReasoning: string
  accumulatedContent: string
  responseMessageId: string
  accumulatedTokens: number
  hasToolCalls: boolean
  toolCalls: ParserToolCall[]
  parseError: ParserError | null
}

function handleJSONEvent(
  event: ParserEvent,
  ctx: JSONAccumulatorContext
): void {
  switch (event.type) {
    case 'session_id':
      ctx.responseMessageId = event.id
      break
    case 'reasoning':
      ctx.accumulatedReasoning += event.content
      break
    case 'content':
      ctx.accumulatedContent += event.content
      break
    case 'tool_calls':
      ctx.hasToolCalls = true
      ctx.toolCalls = event.toolCalls
      break
    case 'error':
      ctx.parseError = event.error
      break
    case 'tokens':
      ctx.accumulatedTokens = event.count
      break
    case 'done':
      if (event.state.parseError) {
        ctx.parseError = event.state.parseError
      }
      if (event.state.accumulatedTokens > 0) {
        ctx.accumulatedTokens = event.state.accumulatedTokens
      }
      break
  }
}

export async function translateParserEventsToJSON(
  events: AsyncIterable<ParserEvent>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): Promise<OpenAIChatCompletionResponse> {
  const ctx: JSONAccumulatorContext = {
    accumulatedReasoning: '',
    accumulatedContent: '',
    responseMessageId: 'null',
    accumulatedTokens: 0,
    hasToolCalls: false,
    toolCalls: [],
    parseError: null,
  }

  for await (const event of events) {
    handleJSONEvent(event, ctx)
  }

  if (ctx.parseError) {
    const result: OpenAIChatCompletionResponse = {
      id: `chatcmpl-${ctx.responseMessageId}`,
      object: 'chat.completion',
      created: info.created,
      model: info.model,
      choices: [
        {
          index: 0,
          message: { 
            role: 'assistant', 
            content: '',
            reasoning_content: ctx.accumulatedReasoning || undefined,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: ctx.accumulatedTokens,
        total_tokens: ctx.accumulatedTokens,
      },
    }
    logger?.logOutgoingToClient(result)
    return result
  }
  
  if (ctx.hasToolCalls && ctx.toolCalls.length > 0) {
    const result: OpenAIChatCompletionResponse = {
      id: `chatcmpl-${ctx.responseMessageId}`,
      object: 'chat.completion',
      created: info.created,
      model: info.model,
      choices: [
        {
          index: 0,
          message: { 
            role: 'assistant', 
            content: null,
            reasoning_content: ctx.accumulatedReasoning || undefined,
            tool_calls: ctx.toolCalls.map(mapToolCall)
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: ctx.accumulatedTokens,
        total_tokens: ctx.accumulatedTokens,
      },
    }
    logger?.logOutgoingToClient(result)
    return result
  }

  const result: OpenAIChatCompletionResponse = {
    id: `chatcmpl-${ctx.responseMessageId}`,
    object: 'chat.completion',
    created: info.created,
    model: info.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: ctx.accumulatedContent, reasoning_content: ctx.accumulatedReasoning || undefined },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: ctx.accumulatedTokens,
      total_tokens: ctx.accumulatedTokens,
    },
  }
  logger?.logOutgoingToClient(result)
  return result
}