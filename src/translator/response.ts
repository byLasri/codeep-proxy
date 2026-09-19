import type { OpenAIChatCompletionResponse, OpenAIChatCompletionStreamResponse, ToolCall } from './types.js'
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
  currentFragmentType: 'THINK' | 'RESPONSE' | null
  accumulatedReasoning: string
  parseError: { message: string; syntaxRules: string } | null
  pendingToolCallContent: string
}

const FORBIDDEN_DSML_DELIMITERS = [
  '｜｜DSML｜｜',
  '｜DSML｜｜',
  '｜DSML｜',
  '||DSML||'
]

const DSML_CORRECTIVE_MESSAGE = `<error>
Invalid tool call syntax.
｜｜DSML｜｜ , ｜DSML｜｜ , ｜DSML｜ , ||DSML|| are not allowed.
correct example:
<calls>
<invoke name="read">
<parameter name="filePath">C:\\your\\path\\here</parameter>
</invoke>
</calls>
Try again.
</error>`

function detectDSML(content: string): boolean {
  return FORBIDDEN_DSML_DELIMITERS.some(d => content.includes(d))
}

function parseCleanToolCalls(content: string): ToolCall[] {
  const callsMatch = content.match(/<calls>([\s\S]*?)<\/calls>/)
  if (!callsMatch) return []

  const toolCalls: ToolCall[] = []
  const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g
  let invokeMatch

  while ((invokeMatch = invokeRegex.exec(callsMatch[1])) !== null) {
    const functionName = invokeMatch[1]
    const invokeContent = invokeMatch[2]
    const args: Record<string, string> = {}

    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g
    let paramMatch
    while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim()
    }

    toolCalls.push({
      id: `call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name: functionName,
        arguments: JSON.stringify(args)
      }
    })
  }
  return toolCalls
}

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
    accumulatedReasoning: '',
    parseError: null,
    pendingToolCallContent: '',
  }

  const emitFinal = () => {
    if (state.hasEmittedDone) return
    state.hasEmittedDone = true

    const isDSML = detectDSML(state.accumulatedContent)
    if (isDSML) {
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
      state.parseError = { message: 'DSML_DETECTED', syntaxRules: DSML_CORRECTIVE_MESSAGE }
      return
    }

    const toolCalls = parseCleanToolCalls(state.accumulatedContent)
    if (toolCalls.length > 0) {
      const toolCallChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, idx) => ({
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
      // Emit buffered normal content
      if (state.pendingToolCallContent.length > 0) {
        const contentChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${state.responseMessageId}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: { content: state.pendingToolCallContent }, finish_reason: null }],
        }
        enqueue(new TextEncoder().encode(formatOpenAISSEChunk(contentChunk)))
      }
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

  const emitContent = (text: string) => {
    if (state.responseMessageId === 'null') {
      state.pendingContent = (state.pendingContent || '') + text
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

    const isReasoning = state.currentFragmentType === 'THINK'

    if (isReasoning) {
      state.accumulatedReasoning += text
      const chunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
    } else {
      state.accumulatedContent += text
      state.pendingToolCallContent += text
    }
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

    if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
      const v = parsed.v as { response?: { fragments?: Array<{ type?: string; content?: string }> } };
      const fragments = v?.response?.fragments;
      if (Array.isArray(fragments) && fragments.length > 0) {
        const frag = fragments[0];
        const fragType = frag?.type === 'THINK' ? 'THINK' : 'RESPONSE'
        state.currentFragmentType = fragType
        if (typeof frag?.content === 'string' && frag.content !== '') {
          emitContent(frag.content)
        }
      }
      return;
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

    if (state.currentEvent === 'update_session') {
      const v = parsed.v as { response?: { fragments?: Array<{ content?: string }> } } | undefined
      const initial = v?.response?.fragments?.[0]?.content
      if (initial != null && initial !== '') {
        emitContent(initial)
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
      if (state.currentPath === 'response/status' && state.currentOp === 'SET' && parsed.v === 'FINISHED') {
        if (!state.hasEmittedDone) {
          emitFinal()
        }
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

    if (state.currentEvent === 'close') {
      if (!state.hasEmittedDone) {
        emitFinal()
      }
      return
    }
  }

  return { state, emitFinal, emitContent, processLine }
}

export interface SSEParseResult {
  stream: ReadableStream<Uint8Array>
  parseError: { message: string; syntaxRules: string } | null
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

  buffer += decoder.decode()

  if (buffer.length > 0) {
    const trimmed = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    parser.processLine(trimmed)
    buffer = ''
  }

  if (parser.state.pendingContent) {
    parser.emitContent(parser.state.pendingContent)
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
  }
}

export async function translateDeepSeekStreamToJSON(
  deepSeekStream: ReadableStream<Uint8Array>,
  info: { model: string; id: string; created: number },
  logger?: RequestLogger
): Promise<OpenAIChatCompletionResponse & { _malformedError?: { message: string; syntaxRules: string } }> {
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

        if (currentEvent === 'ready') {
          if (typeof parsed.response_message_id === 'number') {
            responseMessageId = String(parsed.response_message_id)
          }
          continue
        }

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

        if (parsed.p !== undefined && parsed.o !== undefined) {
          currentPath = String(parsed.p)
          currentOp = String(parsed.o)
          isAppending = currentPath === 'response/fragments/-1/content' && currentOp === 'APPEND'

          if (currentPath === 'response/fragments' && currentOp === 'APPEND') {
            if (Array.isArray(parsed.v) && parsed.v.length > 0) {
              const newFragment = parsed.v[0] as { type?: string; content?: string }
              currentFragmentType = newFragment?.type === 'THINK' ? 'THINK' : 'RESPONSE'
              isAppending = true
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

  if (buffer.length > 0) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    if (line.startsWith('data: ')) {
      const payload = line.slice(6).trim()
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = JSON.parse(payload)
      } catch {
      }
      if (parsed && parsed.p !== undefined && parsed.o !== undefined) {
        const path = String(parsed.p)
        const op = String(parsed.o)
        const appending = path === 'response/fragments/-1/content' && op === 'APPEND'

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

  const isDSML = detectDSML(accumulatedContent)
  if (isDSML) {
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
      _malformedError: { message: 'DSML_DETECTED', syntaxRules: DSML_CORRECTIVE_MESSAGE },
    }
    logger?.logOutgoingToClient(result)
    return result
  }

  const toolCalls = parseCleanToolCalls(accumulatedContent)
  if (toolCalls.length > 0) {
    const result: OpenAIChatCompletionResponse = {
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
            tool_calls: toolCalls
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

  const result: OpenAIChatCompletionResponse = {
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
  }
  logger?.logOutgoingToClient(result)
  return result
}