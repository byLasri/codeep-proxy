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
  toolCallBuffer: string
  isToolCallInProgress: boolean
  parsedToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  parseError: { message: string; syntaxRules: string } | null
  pendingLookahead: string
}

interface DSMLParseResult {
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  isMalformed?: boolean
}

function parseDSMLToolCalls(xml: string): DSMLParseResult {
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  
  // Check for basic DSML structure
  const hasCallsStart = xml.includes('<｜｜DSML｜｜ calls>')
  const hasCallsEnd = xml.includes('</｜｜DSML｜｜ calls>')
  
  if (!hasCallsStart && !hasCallsEnd) {
    // No DSML tool calls present - this is normal for text responses
    return { toolCalls: [] }
  }
  
  // For malformed DSML, we still try to extract what we can
  // and forward partial results instead of returning an error
  // This allows the upstream client (OpenCode) to see the malformed tool call
  // and generate its own native error
  
  // Try to extract invokes even from malformed XML
  // Use a more lenient regex that can handle missing closing tags
  const invokeRegex = /<｜｜DSML｜｜\s+invoke\s+name="([^"]+)"[^>]*>/g
  const paramRegex = /<｜｜DSML｜｜\s+parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)(?:<|<\/)/g
  
  let invokeMatch
  let invokeIndex = 0
  while ((invokeMatch = invokeRegex.exec(xml)) !== null) {
    const toolName = invokeMatch[1]
    
    // Skip if tool name is empty
    if (!toolName || toolName.trim() === '') {
      continue
    }
    
    // Extract parameters for this invoke by looking ahead in the content
    const params: Record<string, string> = {}
    const remainingContent = xml.substring(invokeMatch.index!)
    
    // Find all parameters until next invoke or end of calls
    const paramMatches = [...remainingContent.matchAll(/<｜｜DSML｜｜\s+parameter\s+name="([^"]+)"[^>]*>([^<]*)/g)]
    
    for (const paramMatch of paramMatches) {
      const paramName = paramMatch[1]
      const paramValue = paramMatch[2]?.trim() || ''
      
      // Only include valid parameter names
      if (paramName && paramName.trim() !== '') {
        params[paramName] = paramValue
      }
    }
    
    // Add the tool call even if it might be malformed
    // OpenCode will validate and generate native errors
    toolCalls.push({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(params)
      }
    })
    invokeIndex++
  }
  
  // Mark as malformed if DSML structure is incomplete
  const isMalformed = (hasCallsStart && !hasCallsEnd) || toolCalls.length === 0
  
  return { toolCalls, isMalformed }
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
    currentFragmentType: 'RESPONSE',
    accumulatedReasoning: '',
    toolCallBuffer: '',
    isToolCallInProgress: false,
    parsedToolCalls: [],
    parseError: null,
    pendingLookahead: '',
  }

  const emitFinal = () => {
    if (state.hasEmittedDone) return
    state.hasEmittedDone = true
    
    // Emit tool calls if we have any (including malformed ones - they will be forwarded to OpenCode)
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
      controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(toolCallChunk)))
    } else {
      // No tool calls - emit final stop chunk
      const finalChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))
    }
    
    // Emit usage if available
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
    const DSML_START = '<｜｜DSML｜｜ calls>'
    
    // If tool call buffering is already in progress
    if (state.isToolCallInProgress) {
      state.toolCallBuffer += text
      if (state.toolCallBuffer.includes('</｜｜DSML｜｜ calls>')) {
        const result = parseDSMLToolCalls(state.toolCallBuffer)
        state.parsedToolCalls = result.toolCalls
        state.isToolCallInProgress = false
        state.toolCallBuffer = ''
      }
      return
    }

    // Combine pending lookahead with new text
    const combined = state.pendingLookahead + text
    state.pendingLookahead = ''

    // Build full prospective content
    const fullContent = state.accumulatedContent + combined

    // Check for full DSML start pattern
    if (fullContent.includes(DSML_START)) {
      const dsmlIdx = fullContent.indexOf(DSML_START)
      
      // Emit everything before DSML that hasn't been emitted yet
      const beforeDSML = fullContent.substring(0, dsmlIdx)
      const newSafeContent = beforeDSML.substring(state.accumulatedContent.length)
      if (newSafeContent.length > 0 && state.responseMessageId !== 'null') {
        const isReasoning = state.currentFragmentType === 'THINK'
        if (!state.hasEmittedRole) {
          state.hasEmittedRole = true
          const roleChunk: OpenAIChatCompletionStreamResponse = {
            id: `chatcmpl-${state.responseMessageId}`,
            object: 'chat.completion.chunk',
            created: info.created,
            model: info.model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }
          controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
        }
        const safeChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${state.responseMessageId}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: isReasoning ? { reasoning_content: newSafeContent } : { content: newSafeContent }, finish_reason: null }],
        }
        controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(safeChunk)))
      }
      
      // Start tool call buffering
      state.isToolCallInProgress = true
      state.toolCallBuffer = fullContent.substring(dsmlIdx)
      state.accumulatedContent = beforeDSML
      return
    }

    // Check for partial DSML prefix at the end - HOLD BACK these characters
    let holdbackLength = 0
    for (let i = 1; i < DSML_START.length; i++) {
      if (fullContent.endsWith(DSML_START.substring(0, i))) {
        holdbackLength = i
      }
    }

    if (holdbackLength > 0) {
      // Save partial match in lookahead buffer
      state.pendingLookahead = fullContent.substring(fullContent.length - holdbackLength)
      const safeContent = fullContent.substring(0, fullContent.length - holdbackLength)
      
      // Emit safe content that hasn't been emitted yet
      const newContent = safeContent.substring(state.accumulatedContent.length)
      if (newContent.length > 0 && state.responseMessageId !== 'null') {
        const isReasoning = state.currentFragmentType === 'THINK'
        if (!state.hasEmittedRole) {
          state.hasEmittedRole = true
          const roleChunk: OpenAIChatCompletionStreamResponse = {
            id: `chatcmpl-${state.responseMessageId}`,
            object: 'chat.completion.chunk',
            created: info.created,
            model: info.model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }
          controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
        }
        const chunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${state.responseMessageId}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: isReasoning ? { reasoning_content: newContent } : { content: newContent }, finish_reason: null }],
        }
        controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
      }
      
      state.accumulatedContent = safeContent
      return
    }

    // No DSML pattern at all - emit everything normally
    const newContent = fullContent.substring(state.accumulatedContent.length)
    const isReasoning = state.currentFragmentType === 'THINK'
    
    if (isReasoning) {
      state.accumulatedReasoning += newContent
    } else {
      state.accumulatedContent = fullContent
    }

    if (state.responseMessageId === 'null') {
      state.pendingContent = (state.pendingContent || '') + newContent
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
      controller.enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
    }

    const chunk: OpenAIChatCompletionStreamResponse = {
      id: `chatcmpl-${state.responseMessageId}`,
      object: 'chat.completion.chunk',
      created: info.created,
      model: info.model,
      choices: [{ index: 0, delta: isReasoning ? { reasoning_content: newContent } : { content: newContent }, finish_reason: null }],
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

    // Handle initial fragment content from update_session
    // DeepSeek may send this in a standalone data: line after a blank line,
    // so state.currentEvent may be null. We detect it by checking for v.response.fragments.
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
      
      // Handle new fragment being appended to response/fragments array
      // This happens when transitioning from THINK to RESPONSE, or adding a new fragment
      if (state.currentPath === 'response/fragments' && state.currentOp === 'APPEND') {
        if (Array.isArray(parsed.v) && parsed.v.length > 0) {
          const newFragment = parsed.v[0] as { type?: string; content?: string }
          state.currentFragmentType = newFragment?.type === 'THINK' ? 'THINK' : 'RESPONSE'
          // We are now appending to this new fragment
          state.isAppending = true
          // Emit the initial content if present
          if (typeof newFragment?.content === 'string' && newFragment.content !== '') {
            emitContent(newFragment.content)
          }
        }
      }
      
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

    // 3.5. Handle lines with p but no o (continuation of previous APPEND)
    // Example: {"p":"response/fragments/-1/content","v":" **"}
    if (parsed.p !== undefined && parsed.o === undefined && typeof parsed.v === 'string') {
      if (parsed.p === 'response/fragments/-1/content' && state.isAppending) {
        emitContent(parsed.v)
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
      // Flush any pending lookahead before finalizing
      if (parser.state.pendingLookahead) {
        parser.emitContent('')
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

  // Parse DSML tool calls from accumulated content
  const dsmlResult = parseDSMLToolCalls(accumulatedContent)
  
  // If tool calls are found (including malformed ones), return them with finish_reason: "tool_calls"
  // Malformed tool calls will be forwarded to OpenCode which will generate native errors
  if (dsmlResult.toolCalls.length > 0) {
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
            tool_calls: dsmlResult.toolCalls
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
