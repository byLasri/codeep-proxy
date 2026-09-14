import type { OpenAIChatCompletionResponse, OpenAIChatCompletionStreamResponse } from './types.js'
import type { RequestLogger } from '../observability/logger.js'
import { teeAndLogStream } from '../observability/logger.js'

export function formatOpenAISSEChunk(chunk: OpenAIChatCompletionStreamResponse): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function formatOpenAIDone(): string {
  return 'data: [DONE]\n\n'
}

interface SSEParserState {
  accumulatedContent: string
  hasEmittedRole: boolean
  hasEmittedDone: boolean
  responseMessageId: string
  currentEvent: string | null
  currentPath: string | null
  currentOp: string | null
  isAppending: boolean
  accumulatedTokens: number
  pendingContent: string
}

function createParser(
  controller: TransformStreamDefaultController<Uint8Array>,
  info: { model: string; id: string; created: number }
) {
  const state: SSEParserState = {
    accumulatedContent: '',
    hasEmittedRole: false,
    hasEmittedDone: false,
    responseMessageId: 'null',
    currentEvent: null,
    currentPath: null,
    currentOp: null,
    isAppending: false,
    accumulatedTokens: 0,
    pendingContent: '',
  }

  const emitFinal = () => {
    if (state.hasEmittedDone) return
    state.hasEmittedDone = true
    const finalChunk: OpenAIChatCompletionStreamResponse = {
      id: `chatcmpl-${state.responseMessageId}`,
      object: 'chat.completion.chunk',
      created: info.created,
      model: info.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
    controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))
    if (state.accumulatedTokens > 0) {
      const usageChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [],
        usage: {
          prompt_tokens: 0,
          completion_tokens: state.accumulatedTokens,
          total_tokens: state.accumulatedTokens,
        },
      }
      controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(usageChunk)))
    }
    controller.enqueue(new TextEncoder().encode(formatOpenAIDone()))
  }

  const emitContent = (text: string) => {
    if (state.responseMessageId === 'null') {
      // ready event has not arrived yet; buffer this text and flush it when
      // ready sets responseMessageId
      state.pendingContent = (state.pendingContent || '') + text
      return
    }
    state.accumulatedContent += text
    if (!state.hasEmittedRole) {
      state.hasEmittedRole = true
      // Emit role chunk WITH empty content to ensure client processes it
      const roleChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }
      controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
      // Then emit content chunk separately
      const contentChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }
      controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(contentChunk)))
      return
    }
    const chunk: OpenAIChatCompletionStreamResponse = {
      id: `chatcmpl-${state.responseMessageId}`,
      object: 'chat.completion.chunk',
      created: info.created,
      model: info.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }
    controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
  }

  const processLine = (line: string) => {
    if (line === '') {
      state.currentEvent = null
      return
    }
    if (line.startsWith('event: ')) {
      state.currentEvent = line.slice(7).trim()
      return
    }
    if (!line.startsWith('data: ')) return
    const payload = line.slice(6).trim()
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }

    // 1. ready event: capture response_message_id and flush pending content
    if (state.currentEvent === 'ready') {
      if (typeof parsed.response_message_id === 'number') {
        state.responseMessageId = String(parsed.response_message_id)
      }
      // Flush any pending content that arrived before the ready event
      if (state.pendingContent) {
        const pending = state.pendingContent
        state.pendingContent = ''
        emitContent(pending)
      }
      return
    }

    // 2. update_session: capture initial fragment content
    if (state.currentEvent === 'update_session') {
      const v = parsed.v as { response?: { fragments?: Array<{ content?: string }> } } | undefined
      const initial = v?.response?.fragments?.[0]?.content
      if (initial != null && initial !== '') {
        emitContent(initial)
      }
      return
    }

    // 3. p/o lines: reset or set append mode
    if (parsed.p !== undefined && parsed.o !== undefined) {
      state.currentPath = String(parsed.p)
      state.currentOp = String(parsed.o)
      state.isAppending = state.currentPath === 'response/fragments/-1/content' && state.currentOp === 'APPEND'
      if (state.isAppending && typeof parsed.v === 'string') {
        emitContent(parsed.v)
      }
      // capture token usage from BATCH
      if (state.currentPath === 'response' && state.currentOp === 'BATCH' && Array.isArray(parsed.v)) {
        for (const item of parsed.v) {
          const it = item as { p?: string; v?: unknown }
          if (it.p === 'accumulated_token_usage' && typeof it.v === 'number') {
            state.accumulatedTokens = it.v
          }
        }
      }
      // finish signal via status
      if (state.currentPath === 'response/status' && state.currentOp === 'SET' && parsed.v === 'FINISHED') {
        if (!state.hasEmittedDone) {
          emitFinal()
        }
      }
      // finish signal via BATCH quasi_status
      if (state.currentPath === 'response' && state.currentOp === 'BATCH' && Array.isArray(parsed.v)) {
        for (const item of parsed.v) {
          const it = item as { p?: string; v?: unknown }
          if (it.p === 'quasi_status' && it.v === 'FINISHED' && !state.hasEmittedDone) {
            emitFinal()
          }
        }
      }
      return
    }

    // 4. v-only lines: append ONLY while isAppending
    if (parsed.v !== undefined && state.isAppending && typeof parsed.v === 'string') {
      emitContent(parsed.v)
      return
    }

    // 5. close event: ensure [DONE]
    if (state.currentEvent === 'close') {
      if (!state.hasEmittedDone) {
        emitFinal()
      }
      return
    }
  }

  return { state, emitFinal, emitContent, processLine }
}

export function translateDeepSeekStreamToSSE(
  deepSeekStream: ReadableStream<Uint8Array>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  let parser: ReturnType<typeof createParser> | null = null

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (parser === null) parser = createParser(controller, info)
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        parser.processLine(trimmed)
      }
    },
    flush(controller) {
      if (parser === null) parser = createParser(controller, info)
      if (buffer.length > 0) {
        const trimmed = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        parser.processLine(trimmed)
        buffer = ''
      }
      parser.emitFinal()
    },
  })
  const stream = deepSeekStream.pipeThrough(transform)
  if (logger) {
    const final = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush(controller) {
        logger.logOutgoingToClient({ info, event: 'sse_stream_complete' })
      },
    })
    return stream.pipeThrough(final)
  }
  return stream
}

export async function translateDeepSeekStreamToJSON(
  deepSeekStream: ReadableStream<Uint8Array>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): Promise<OpenAIChatCompletionResponse> {
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedContent = ''
  let responseMessageId = 'null'
  let accumulatedTokens = 0
  let currentEvent: string | null = null
  let currentPath: string | null = null
  let currentOp: string | null = null
  let isAppending = false

  const reader = deepSeekStream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') {
          currentEvent = null
          continue
        }
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
          continue
        }
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        // 1. ready event: capture response_message_id
        if (currentEvent === 'ready') {
          if (typeof parsed.response_message_id === 'number') {
            responseMessageId = String(parsed.response_message_id)
          }
          continue
        }

        // 2. update_session: capture initial fragment content
        if (currentEvent === 'update_session') {
          const v = parsed.v as { response?: { fragments?: Array<{ content?: string }> } } | undefined
          const initial = v?.response?.fragments?.[0]?.content
          if (initial != null && initial !== '') {
            accumulatedContent += initial
          }
          continue
        }

        // 3. p/o lines
        if (parsed.p !== undefined && parsed.o !== undefined) {
          currentPath = String(parsed.p)
          currentOp = String(parsed.o)
          isAppending = currentPath === 'response/fragments/-1/content' && currentOp === 'APPEND'
          if (isAppending && typeof parsed.v === 'string') {
            accumulatedContent += parsed.v
          }
          // capture token usage from BATCH
          if (currentPath === 'response' && currentOp === 'BATCH' && Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              const it = item as { p?: string; v?: unknown }
              if (it.p === 'accumulated_token_usage' && typeof it.v === 'number') {
                accumulatedTokens = it.v
              }
            }
          }
          continue
        }

        // 4. v-only lines: append ONLY while isAppending
        if (parsed.v !== undefined && isAppending && typeof parsed.v === 'string') {
          accumulatedContent += parsed.v
          continue
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Handle any remaining buffer
  if (buffer.length > 0) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    if (line.startsWith('data: ')) {
      const payload = line.slice(6).trim()
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = JSON.parse(payload)
      } catch {
        // ignore
      }
      if (parsed && parsed.p !== undefined && parsed.o !== undefined) {
        const path = String(parsed.p)
        const op = String(parsed.o)
        const appending = path === 'response/fragments/-1/content' && op === 'APPEND'
        if (appending && typeof parsed.v === 'string') {
          accumulatedContent += parsed.v
        }
        if (path === 'response' && op === 'BATCH' && Array.isArray(parsed.v)) {
          for (const item of parsed.v) {
            const it = item as { p?: string; v?: unknown }
            if (it.p === 'accumulated_token_usage' && typeof it.v === 'number') {
              accumulatedTokens = it.v
            }
          }
        }
      } else if (parsed && parsed.v !== undefined && isAppending && typeof parsed.v === 'string') {
        accumulatedContent += parsed.v
      }
    }
  }

  const result: OpenAIChatCompletionResponse = {
    id: `chatcmpl-${responseMessageId}`,
    object: 'chat.completion',
    created: info.created,
    model: info.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: accumulatedContent },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: accumulatedTokens,
      total_tokens: accumulatedTokens,
    },
  }
  logger?.logOutgoingToClient(result)
  return result
}
