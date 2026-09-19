import type { OpenAIChatCompletionResponse, OpenAIChatCompletionStreamResponse } from './types.js'
import type { RequestLogger } from '../observability/logger.js'
import { parseCleanToolCalls, CORRECTIVE_MESSAGE as ACTIVE_CORRECTIVE_MESSAGE } from './clean-tool-calls.js'

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
  currentFragmentType: 'THINK' | 'RESPONSE' | null
  toolCallBuffer: string
  isToolCallInProgress: boolean
  parsedToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  parseError: { message: string; syntaxRules: string } | null
  pendingLookahead: string
}

const FORBIDDEN_DSML_MARKERS = ['｜｜DSML｜｜', '｜DSML｜｜', '｜DSML｜', '||DSML||']
function createParser(
  enqueue: (chunk: Uint8Array) => void,
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
    currentFragmentType: 'RESPONSE',
    toolCallBuffer: '',
    isToolCallInProgress: false,
    parsedToolCalls: [],
    parseError: null,
    pendingLookahead: '',
  }

  const emitFinal = () => {
    if (state.hasEmittedDone) return
    state.hasEmittedDone = true

    if (state.parseError) {
      const finalChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))

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
        enqueue(new TextEncoder().encode(formatOpenAISSEChunk(usageChunk)))
      }

      enqueue(new TextEncoder().encode(formatOpenAIDone()))
      return
    }

    if (state.parsedToolCalls.length > 0) {
      const toolCallChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: state.parsedToolCalls.map((tc, idx) => ({
              index: idx,
              id: tc.id,
              type: tc.type,
              function: tc.function
            }))
          },
          finish_reason: 'tool_calls'
        }]
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(toolCallChunk)))
    } else {
      const finalChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))
    }

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
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(usageChunk)))
    }

    enqueue(new TextEncoder().encode(formatOpenAIDone()))
  }

  const emitText = (text: string) => {
    const isReasoning = state.currentFragmentType === 'THINK'
    if (isReasoning) {
      state.accumulatedReasoning += text
    } else {
      state.accumulatedContent += text
    }

    if (state.responseMessageId === 'null') {
      state.pendingContent += text
      return
    }

    if (!state.hasEmittedRole) {
      state.hasEmittedRole = true
      const roleChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
    }

    const chunk: OpenAIChatCompletionStreamResponse = {
      id: `chatcmpl-${state.responseMessageId}`,
      object: 'chat.completion.chunk',
      created: info.created,
      model: info.model,
      choices: [{
        index: 0,
        delta: isReasoning ? { reasoning_content: text } : { content: text },
        finish_reason: null
      }],
    }
    enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
  }

  const emitContent = (text: string) => {
    if (state.parseError) return

    if (state.isToolCallInProgress) {
      state.toolCallBuffer += text
      const forbiddenMarker = FORBIDDEN_DSML_MARKERS.find(marker => state.toolCallBuffer.includes(marker))
      if (forbiddenMarker) {
        state.parseError = {
          message: `Forbidden DSML tool-call delimiter detected: ${forbiddenMarker}`,
          syntaxRules: CLEAN_CORRECTIVE_MESSAGE,
        }
        state.isToolCallInProgress = false
        state.toolCallBuffer = ''
        return
      }
      if (state.toolCallBuffer.includes('</calls>')) {
        const result = parseCleanToolCalls(state.toolCallBuffer)
        state.parsedToolCalls = result.toolCalls
        if (result.isMalformed && result.error) state.parseError = result.error
        state.isToolCallInProgress = false
        state.toolCallBuffer = ''
      }
      return
    }

    const combined = state.pendingLookahead + text
    state.pendingLookahead = ''
    const fullContent = state.accumulatedContent + combined

    const forbiddenMarker = FORBIDDEN_DSML_MARKERS.find(marker => fullContent.includes(marker))
    if (forbiddenMarker) {
      state.parseError = {
        message: `Forbidden DSML tool-call delimiter detected: ${forbiddenMarker}`,
        syntaxRules: CLEAN_CORRECTIVE_MESSAGE,
      }
      return
    }

    const cleanCallsIdx = fullContent.indexOf('<calls>')
    if (cleanCallsIdx !== -1) {
      const beforeCalls = fullContent.slice(0, cleanCallsIdx)
      const newSafeContent = beforeCalls.slice(state.accumulatedContent.length)
      if (newSafeContent.length > 0) emitText(newSafeContent)

      state.accumulatedContent = beforeCalls
      state.isToolCallInProgress = true
      state.toolCallBuffer = fullContent.slice(cleanCallsIdx)
      return
    }

    let holdbackLength = 0
    const cleanPrefix = '<calls>'
    for (let i = 1; i < cleanPrefix.length; i++) {
      if (fullContent.endsWith(cleanPrefix.slice(0, i))) {
        holdbackLength = Math.max(holdbackLength, i)
      }
    }

    if (holdbackLength > 0) {
      state.pendingLookahead = fullContent.slice(fullContent.length - holdbackLength)
      const safeContent = fullContent.slice(0, fullContent.length - holdbackLength)
      const newContent = safeContent.slice(state.accumulatedContent.length)
      if (newContent.length > 0) emitText(newContent)
      state.accumulatedContent = safeContent
      return
    }

    const newContent = fullContent.slice(state.accumulatedContent.length)
    if (newContent.length > 0) emitText(newContent)
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

    if (state.currentEvent === 'ready') {
      if (typeof parsed.response_message_id === 'number') {
        state.responseMessageId = String(parsed.response_message_id)
      }
      if (state.pendingContent) {
        const pending = state.pendingContent
        state.pendingContent = ''
        emitContent(pending)
      }
      return
    }

    if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
      const v = parsed.v as { response?: { fragments?: Array<{ type?: string; content?: string }> } }
      const fragments = v.response?.fragments
      if (Array.isArray(fragments) && fragments.length > 0) {
        const frag = fragments[0]
        state.currentFragmentType = frag?.type === 'THINK' ? 'THINK' : 'RESPONSE'
        if (typeof frag?.content === 'string' && frag.content !== '') {
          emitContent(frag.content)
        }
      }
      return
    }

    if (state.currentEvent === 'update_session') {
      const v = parsed.v as { response?: { fragments?: Array<{ content?: string; type?: string }> } } | undefined
      const fragments = v?.response?.fragments
      if (Array.isArray(fragments) && fragments.length > 0) {
        const frag = fragments[0]
        state.currentFragmentType = frag?.type === 'THINK' ? 'THINK' : 'RESPONSE'
        if (typeof frag.content === 'string' && frag.content !== '') {
          emitContent(frag.content)
        }
      }
      return
    }

    if (parsed.p !== undefined && parsed.o !== undefined) {
      state.currentPath = String(parsed.p)
      state.currentOp = String(parsed.o)
      state.isAppending = state.currentPath === 'response/fragments/-1/content' && state.currentOp === 'APPEND'

      if (state.currentPath === 'response/fragments' && state.currentOp === 'APPEND') {
        if (Array.isArray(parsed.v) && parsed.v.length > 0) {
          const newFragment = parsed.v[0] as { type?: string; content?: string }
          state.currentFragmentType = newFragment?.type === 'THINK' ? 'THINK' : 'RESPONSE'
          state.isAppending = true
          if (typeof newFragment?.content === 'string' && newFragment.content !== '') {
            emitContent(newFragment.content)
          }
        }
      }

      if (state.isAppending && typeof parsed.v === 'string') {
        emitContent(parsed.v)
      }
      if (state.currentPath === 'response' && state.currentOp === 'BATCH' && Array.isArray(parsed.v)) {
        for (const item of parsed.v) {
          const it = item as { p?: string; v?: unknown }
          if (it.p === 'accumulated_token_usage' && typeof it.v === 'number') {
            state.accumulatedTokens = it.v
          }
        }
      }
      if (state.currentPath === 'response/status' && state.currentOp === 'SET' && parsed.v === 'FINISHED' && !state.hasEmittedDone) {
        emitFinal()
      }
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

    if (parsed.p !== undefined && parsed.o === undefined && typeof parsed.v === 'string') {
      if (parsed.p === 'response/fragments/-1/content' && state.isAppending) {
        emitContent(parsed.v)
      }
      return
    }

    if (parsed.v !== undefined && state.isAppending && typeof parsed.v === 'string') {
      emitContent(parsed.v)
      return
    }

    if (state.currentEvent === 'close' && !state.hasEmittedDone) {
      emitFinal()
    }
  }

  return { state, emitFinal, emitContent, processLine }
}

export interface SSEParseResult {
  stream: ReadableStream<Uint8Array>
  parseError: { message: string; syntaxRules: string } | null
  responseMessageId: number | null
}

export async function translateDeepSeekStreamToSSE(
  deepSeekStream: ReadableStream<Uint8Array>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): Promise<SSEParseResult> {
  const decoder = new TextDecoder()
  let buffer = ''
  const outputChunks: Uint8Array[] = []
  let parseError: { message: string; syntaxRules: string } | null = null

  const enqueue = (chunk: Uint8Array) => {
    outputChunks.push(chunk)
  }

  const reader = deepSeekStream.getReader()
  const parser = createParser(enqueue, info)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        parser.processLine(trimmed)
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Finalize decoder at EOF to handle any partial UTF-8 characters
  buffer += decoder.decode()

  if (buffer.length > 0) {
    const trimmed = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    parser.processLine(trimmed)
    buffer = ''
  }

  if (parser.state.pendingLookahead) {
    parser.emitContent('')
  }

  // Finalize any unclosed active tool-call block.
  if (parser.state.isToolCallInProgress) {
    if (parser.state.detectedDialect) {
      parser.state.parseError = {
        message: `Forbidden DSML tool-call delimiter detected (incomplete block at EOF)`,
        syntaxRules: ACTIVE_CORRECTIVE_MESSAGE,
      }
    } else {
      const result = parseCleanToolCalls(parser.state.toolCallBuffer)
      parser.state.parsedToolCalls = result.toolCalls
      if (result.isMalformed && result.error) parser.state.parseError = result.error
    }
    parser.state.isToolCallInProgress = false
    parser.state.toolCallBuffer = ''
    parser.state.detectedDialect = null
  }

  // Reject forbidden DSML markers even when they never formed a complete block.
  if (!parser.state.parseError) {
    const forbiddenDsmlMarkers = ['｜｜DSML｜｜', '｜DSML｜｜', '｜DSML｜', '||DSML||']
    const forbiddenMarker = forbiddenDsmlMarkers.find(marker => parser.state.accumulatedContent.includes(marker))
    if (forbiddenMarker) {
      parser.state.parseError = {
        message: `Forbidden DSML tool-call delimiter detected: ${forbiddenMarker}`,
        syntaxRules: ACTIVE_CORRECTIVE_MESSAGE,
      }
    }
  }

  // Parse complete clean calls that arrived in the accumulated content.
  if (!parser.state.parseError && parser.state.accumulatedContent) {
    const result = parseCleanToolCalls(parser.state.toolCallBuffer)
    parser.state.parsedToolCalls = result.toolCalls
    if (result.isMalformed && result.error) parser.state.parseError = result.error
    parser.state.isToolCallInProgress = false
    parser.state.toolCallBuffer = ''
  }

  // Parse complete clean calls that arrived in the accumulated content.
  if (!parser.state.parseError && parser.state.accumulatedContent) {
    const cleanResult = parseCleanToolCalls(parser.state.accumulatedContent)
    if (cleanResult.isMalformed && cleanResult.error) parser.state.parseError = cleanResult.error
  }

  parseError = parser.state.parseError
  parser.emitFinal()

  if (logger) {
    logger.logOutgoingToClient({ info, event: 'sse_stream_complete' })
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of outputChunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })

  return {
    stream,
    parseError,
    responseMessageId: parser.state.responseMessageId === 'null' ? null : Number(parser.state.responseMessageId),
  }
}

export async function translateDeepSeekStreamToJSON(
  deepSeekStream: ReadableStream<Uint8Array>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): Promise<OpenAIChatCompletionResponse & { _malformedError?: { message: string; syntaxRules: string }; _responseMessageId?: number }> {
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedContent = ''
  let responseMessageId = 'null'
  let accumulatedTokens = 0
  let currentEvent: string | null = null
  let currentPath: string | null = null
  let currentOp: string | null = null
  let isAppending = false
  let accumulatedReasoning = ''
  let currentFragmentType: 'THINK' | 'RESPONSE' = 'RESPONSE'

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

        // Handle initial fragment content from update_session
        // DeepSeek may send this in a standalone data: line after a blank line,
        // so currentEvent may be null. We detect it by checking for v.response.fragments.
        if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
          const v = parsed.v as { response?: { fragments?: Array<{ type?: string; content?: string }> } };
          const fragments = v?.response?.fragments;
          if (Array.isArray(fragments) && fragments.length > 0) {
            const frag = fragments[0];
            currentFragmentType = frag?.type === 'THINK' ? 'THINK' : 'RESPONSE'
            if (typeof frag?.content === 'string' && frag.content !== '') {
              if (currentFragmentType === 'THINK') {
                accumulatedReasoning += frag.content
              } else {
                accumulatedContent += frag.content
              }
            }
          }
          continue;
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
          const v = parsed.v as { response?: { fragments?: Array<{ type?: string; content?: string }> } } | undefined
          const fragments = v?.response?.fragments
          if (Array.isArray(fragments) && fragments.length > 0) {
            const frag = fragments[0]
            currentFragmentType = frag?.type === 'THINK' ? 'THINK' : 'RESPONSE'
            const initial = frag?.content
            if (initial != null && initial !== '') {
              if (currentFragmentType === 'THINK') {
                accumulatedReasoning += initial
              } else {
                accumulatedContent += initial
              }
            }
          }
          continue
        }

        // 3. p/o lines
        if (parsed.p !== undefined && parsed.o !== undefined) {
          currentPath = String(parsed.p)
          currentOp = String(parsed.o)
          isAppending = currentPath === 'response/fragments/-1/content' && currentOp === 'APPEND'
          
          // Handle new fragment being appended to response/fragments array
          // This happens when transitioning from THINK to RESPONSE, or adding a new fragment
          if (currentPath === 'response/fragments' && currentOp === 'APPEND') {
            if (Array.isArray(parsed.v) && parsed.v.length > 0) {
              const newFragment = parsed.v[0] as { type?: string; content?: string }
              currentFragmentType = newFragment?.type === 'THINK' ? 'THINK' : 'RESPONSE'
              // We are now appending to this new fragment
              isAppending = true
              // Emit the initial content if present
              if (typeof newFragment?.content === 'string' && newFragment.content !== '') {
                if (currentFragmentType === 'THINK') {
                  accumulatedReasoning += newFragment.content
                } else {
                  accumulatedContent += newFragment.content
                }
              }
            }
          }
          
          if (isAppending && typeof parsed.v === 'string') {
            if (currentFragmentType === 'THINK') {
              accumulatedReasoning += parsed.v
            } else {
              accumulatedContent += parsed.v
            }
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

        // 3.5. Handle lines with p but no o (continuation of previous APPEND)
        // Example: {"p":"response/fragments/-1/content","v":" **"}
        if (parsed.p !== undefined && parsed.o === undefined && typeof parsed.v === 'string') {
          if (parsed.p === 'response/fragments/-1/content' && isAppending) {
            if (currentFragmentType === 'THINK') {
              accumulatedReasoning += parsed.v
            } else {
              accumulatedContent += parsed.v
            }
          }
          continue
        }

        // 4. v-only lines: append ONLY while isAppending
        if (parsed.v !== undefined && isAppending && typeof parsed.v === 'string') {
          if (currentFragmentType === 'THINK') {
            accumulatedReasoning += parsed.v
          } else {
            accumulatedContent += parsed.v
          }
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
        
        // Handle new fragment being appended to response/fragments array
        if (path === 'response/fragments' && op === 'APPEND') {
          if (Array.isArray(parsed.v) && parsed.v.length > 0) {
            const newFragment = parsed.v[0] as { type?: string; content?: string }
            currentFragmentType = newFragment?.type === 'THINK' ? 'THINK' : 'RESPONSE'
            if (typeof newFragment?.content === 'string' && newFragment.content !== '') {
              if (currentFragmentType === 'THINK') {
                accumulatedReasoning += newFragment.content
              } else {
                accumulatedContent += newFragment.content
              }
            }
          }
        }
        
        if (appending && typeof parsed.v === 'string') {
          if (currentFragmentType === 'THINK') {
            accumulatedReasoning += parsed.v
          } else {
            accumulatedContent += parsed.v
          }
        }
        if (path === 'response' && op === 'BATCH' && Array.isArray(parsed.v)) {
          for (const item of parsed.v) {
            const it = item as { p?: string; v?: unknown }
            if (it.p === 'accumulated_token_usage' && typeof it.v === 'number') {
              accumulatedTokens = it.v
            }
          }
        }
      } else if (parsed && parsed.p !== undefined && parsed.o === undefined && typeof parsed.v === 'string') {
        if (parsed.p === 'response/fragments/-1/content' && isAppending) {
          if (currentFragmentType === 'THINK') {
            accumulatedReasoning += parsed.v
          } else {
            accumulatedContent += parsed.v
          }
        }
      } else if (parsed && parsed.v !== undefined && isAppending && typeof parsed.v === 'string') {
        if (currentFragmentType === 'THINK') {
          accumulatedReasoning += parsed.v
        } else {
          accumulatedContent += parsed.v
        }
      }
    }
  }

  // DSML delimiters are forbidden on the active path.
  const forbiddenDsmlMarkers = ['｜｜DSML｜｜', '｜DSML｜｜', '｜DSML｜', '||DSML||']
  const forbiddenMarker = forbiddenDsmlMarkers.find(marker => accumulatedContent.includes(marker))
  const cleanResult = parseCleanToolCalls(accumulatedContent)
  const activeParseError = forbiddenMarker
    ? { message: `Forbidden DSML tool-call delimiter detected: ${forbiddenMarker}`, syntaxRules: ACTIVE_CORRECTIVE_MESSAGE }
    : cleanResult.isMalformed && cleanResult.error
      ? cleanResult.error
      : null

  // Malformed active tool calls are returned only through the existing internal retry path.
  if (activeParseError) {
    const result: OpenAIChatCompletionResponse & { _malformedError?: { message: string; syntaxRules: string } } = {
      id: `chatcmpl-${responseMessageId}`,
      object: 'chat.completion',
      created: info.created,
      model: info.model,
      choices: [
        {
          index: 0,
          message: { 
            role: 'assistant', 
            content: '',
            reasoning_content: accumulatedReasoning || undefined,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: accumulatedTokens,
        total_tokens: accumulatedTokens,
      },
      _malformedError: activeParseError,
      _responseMessageId: responseMessageId === 'null' ? undefined : Number(responseMessageId),
    }
    logger?.logOutgoingToClient(result)
    return result
  }
  
  // If clean tool calls are found, return the existing OpenAI-compatible tool_calls shape.
  if (cleanResult.toolCalls.length > 0) {
    const result: OpenAIChatCompletionResponse & { _responseMessageId?: number } = {
      id: `chatcmpl-${responseMessageId}`,
      object: 'chat.completion',
      created: info.created,
      model: info.model,
      choices: [
        {
          index: 0,
          message: { 
            role: 'assistant', 
            content: null,
            reasoning_content: accumulatedReasoning || undefined,
            tool_calls: cleanResult.toolCalls
          },
          finish_reason: 'tool_calls',
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

  // No tool calls - return standard text response
  const result: OpenAIChatCompletionResponse & { _responseMessageId?: number } = {
    id: `chatcmpl-${responseMessageId}`,
    object: 'chat.completion',
    created: info.created,
    model: info.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: accumulatedContent, reasoning_content: accumulatedReasoning || undefined },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: accumulatedTokens,
      total_tokens: accumulatedTokens,
    },
    _responseMessageId: responseMessageId === 'null' ? undefined : Number(responseMessageId),
  }
  logger?.logOutgoingToClient(result)
  return result
}
