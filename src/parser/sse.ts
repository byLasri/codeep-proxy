import type { DeepSeekSSEEvent, ParserEvent, ParserStateSnapshot, ParserError, ToolCall, FragmentType } from './types.js'

interface InternalParserState {
  buffer: string
  currentEvent: string | null
  currentPath: string | null
  currentOp: string | null
  isAppending: boolean
  responseMessageId: string | null
  currentFragmentType: FragmentType | null
  accumulatedReasoning: string
  accumulatedContent: string
  accumulatedTokens: number
  toolCallBuffer: string
  isToolCallInProgress: boolean
  parsedToolCalls: ToolCall[]
  parseError: ParserError | null
  pendingLookahead: string
  hasEmittedDone: boolean
  pendingInitialContent: string
  pendingInitialFragmentType: FragmentType | null
}

function createInitialState(): InternalParserState {
  return {
    buffer: '',
    currentEvent: null,
    currentPath: null,
    currentOp: null,
    isAppending: false,
    responseMessageId: null,
    currentFragmentType: null,
    accumulatedReasoning: '',
    accumulatedContent: '',
    accumulatedTokens: 0,
    toolCallBuffer: '',
    isToolCallInProgress: false,
    parsedToolCalls: [],
    parseError: null,
    pendingLookahead: '',
    hasEmittedDone: false,
    pendingInitialContent: '',
    pendingInitialFragmentType: null,
  }
}

function createEmptySnapshot(state: InternalParserState): ParserStateSnapshot {
  return {
    currentFragmentType: state.currentFragmentType,
    accumulatedReasoning: state.accumulatedReasoning,
    accumulatedContent: state.accumulatedContent,
    responseMessageId: state.responseMessageId,
    accumulatedTokens: state.accumulatedTokens,
    isComplete: state.hasEmittedDone,
    parseError: state.parseError,
  }
}

function emitReasoning(content: string): ParserEvent {
  return { type: 'reasoning', content }
}

function emitContent(content: string): ParserEvent {
  return { type: 'content', content }
}

function emitToolCalls(toolCalls: ToolCall[]): ParserEvent {
  return { type: 'tool_calls', toolCalls }
}

function emitError(error: ParserError): ParserEvent {
  return { type: 'error', error }
}

function emitDone(state: InternalParserState): ParserEvent {
  return { type: 'done', state: createEmptySnapshot(state) }
}

function emitSessionId(id: string): ParserEvent {
  return { type: 'session_id', id }
}

function emitTokens(count: number): ParserEvent {
  return { type: 'tokens', count }
}

function processLine(state: InternalParserState, line: string): ParserEvent[] {
  const events: ParserEvent[] = []
  
  if (line === '') {
    state.currentEvent = null
    return events
  }
  
  if (line.startsWith('event: ')) {
    state.currentEvent = line.slice(7).trim()
    return events
  }
  
  if (!line.startsWith('data: ')) return events
  
  const payload = line.slice(6).trim()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(payload)
  } catch {
    return events
  }

  if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
    const v = parsed.v as { response?: { fragments?: Array<{ type?: string; content?: string }> } };
    const fragments = v?.response?.fragments;
    if (Array.isArray(fragments) && fragments.length > 0) {
      const frag = fragments[0];
      const fragType = frag?.type === 'THINK' ? 'THINK' : 'RESPONSE'
      state.currentFragmentType = fragType
      if (state.responseMessageId === null) {
        state.pendingInitialContent = frag.content || ''
        state.pendingInitialFragmentType = fragType
      } else {
        if (typeof frag?.content === 'string' && frag.content !== '') {
          events.push(...emitContentForFragment(state, frag.content, fragType))
        }
      }
    }
    return events
  }

  if (state.currentEvent === 'ready') {
    if (typeof parsed.response_message_id === 'number') {
      state.responseMessageId = String(parsed.response_message_id)
      events.push(emitSessionId(state.responseMessageId))
    }
    if (state.pendingInitialContent) {
      events.push(...emitContentForFragment(state, state.pendingInitialContent, state.pendingInitialFragmentType!))
      state.pendingInitialContent = ''
      state.pendingInitialFragmentType = null
    }
    return events
  }

  if (state.currentEvent === 'update_session') {
    const v = parsed.v as { response?: { fragments?: Array<{ content?: string }> } } | undefined
    const initial = v?.response?.fragments?.[0]?.content
    if (initial != null && initial !== '') {
      if (state.responseMessageId === null) {
        state.pendingInitialContent += initial
      } else {
        events.push(...emitContentForFragment(state, initial, state.currentFragmentType!))
      }
    }
    return events
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
          events.push(...emitContentForFragment(state, newFragment.content, state.currentFragmentType))
        }
      }
    }
    
    if (state.isAppending && typeof parsed.v === 'string') {
      events.push(...emitContentForFragment(state, parsed.v, state.currentFragmentType!))
    }
    
    if (state.currentPath === 'response' && state.currentOp === 'BATCH' && Array.isArray(parsed.v)) {
      for (const item of parsed.v) {
        const it = item as { p?: string; v?: unknown }
        if (it.p === 'accumulated_token_usage' && typeof it.v === 'number') {
          state.accumulatedTokens = it.v
          events.push(emitTokens(it.v))
        }
      }
    }
    
    if (state.currentPath === 'response/status' && state.currentOp === 'SET' && parsed.v === 'FINISHED') {
      if (!state.hasEmittedDone) {
        state.hasEmittedDone = true
        events.push(emitDone(state))
      }
    }
    
    if (state.currentPath === 'response' && state.currentOp === 'BATCH' && Array.isArray(parsed.v)) {
      for (const item of parsed.v) {
        const it = item as { p?: string; v?: unknown }
        if (it.p === 'quasi_status' && it.v === 'FINISHED' && !state.hasEmittedDone) {
          state.hasEmittedDone = true
          events.push(emitDone(state))
        }
      }
    }
    return events
  }

  if (parsed.p !== undefined && parsed.o === undefined && typeof parsed.v === 'string') {
    if (parsed.p === 'response/fragments/-1/content' && state.isAppending) {
      events.push(...emitContentForFragment(state, parsed.v, state.currentFragmentType!))
    }
    return events
  }

  if (parsed.v !== undefined && state.isAppending && typeof parsed.v === 'string') {
    events.push(...emitContentForFragment(state, parsed.v, state.currentFragmentType!))
    return events
  }

  if (state.currentEvent === 'close') {
    if (!state.hasEmittedDone) {
      state.hasEmittedDone = true
      events.push(emitDone(state))
    }
    return events
  }

  return events
}

function emitContentForFragment(state: InternalParserState, text: string, fragmentType: FragmentType): ParserEvent[] {
  const events: ParserEvent[] = []

  if (fragmentType === 'THINK') {
    state.accumulatedReasoning += text
    if (text.length > 0) {
      events.push(emitReasoning(text))
    }
    return events
  }

  if (state.isToolCallInProgress) {
    state.toolCallBuffer += text
    const endMarker = 'END_CODEEP_CALL'
    const endIdx = state.toolCallBuffer.indexOf(endMarker)
    if (endIdx !== -1) {
      const jsonStr = state.toolCallBuffer.substring(0, endIdx).trim()
      state.toolCallBuffer = state.toolCallBuffer.substring(endIdx + endMarker.length)
      state.isToolCallInProgress = false
      
      try {
        const parsed = JSON.parse(jsonStr)
        if (parsed && typeof parsed.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object') {
          const toolCall: ToolCall = {
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments)
            }
          }
          state.parsedToolCalls.push(toolCall)
          events.push(emitToolCalls([toolCall]))
        }
      } catch {
        state.parseError = {
          message: 'Invalid CODEEP_CALL JSON format',
          syntaxRules: 'Tool call must be valid JSON with "name" (string) and "arguments" (object) fields.'
        }
      }
    }
    return events
  }

  const combined = state.pendingLookahead + text
  state.pendingLookahead = ''

  const fullContent = state.accumulatedContent + combined

  const startMarker = 'CODEEP_CALL'
  const startIdx = fullContent.indexOf(startMarker)

  if (startIdx !== -1) {
    const beforeMarker = fullContent.substring(0, startIdx)
    const newSafeContent = beforeMarker.substring(state.accumulatedContent.length)
    if (newSafeContent.length > 0) {
      state.accumulatedContent = beforeMarker
      events.push(emitContent(newSafeContent))
    }

    state.isToolCallInProgress = true
    state.toolCallBuffer = fullContent.substring(startIdx + startMarker.length)
    state.accumulatedContent = beforeMarker
    return events
  }

  const holdbackPatterns = [startMarker]
  let holdbackLength = 0
  for (const pattern of holdbackPatterns) {
    for (let i = 1; i < pattern.length; i++) {
      if (fullContent.endsWith(pattern.substring(0, i))) {
        holdbackLength = Math.max(holdbackLength, i)
      }
    }
  }

  if (holdbackLength > 0) {
    state.pendingLookahead = fullContent.substring(fullContent.length - holdbackLength)
    const safeContent = fullContent.substring(0, fullContent.length - holdbackLength)
    
    const newContent = safeContent.substring(state.accumulatedContent.length)
    if (newContent.length > 0) {
      state.accumulatedContent = safeContent
      events.push(emitContent(newContent))
    }
    
    state.accumulatedContent = safeContent
    return events
  }

  const newContent = fullContent.substring(state.accumulatedContent.length)
  
  state.accumulatedContent = fullContent
  if (newContent.length > 0) {
    events.push(emitContent(newContent))
  }

  return events
}

function finalizeToolCallBuffer(state: InternalParserState): ParserEvent[] {
  const events: ParserEvent[] = []
  
  if (state.isToolCallInProgress) {
    const endMarker = 'END_CODEEP_CALL'
    const endIdx = state.toolCallBuffer.indexOf(endMarker)
    if (endIdx !== -1) {
      const jsonStr = state.toolCallBuffer.substring(0, endIdx).trim()
      try {
        const parsed = JSON.parse(jsonStr)
        if (parsed && typeof parsed.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object') {
          const toolCall: ToolCall = {
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments)
            }
          }
          state.parsedToolCalls.push(toolCall)
          events.push(emitToolCalls([toolCall]))
        }
      } catch {
        state.parseError = {
          message: 'Invalid CODEEP_CALL JSON format',
          syntaxRules: 'Tool call must be valid JSON with "name" (string) and "arguments" (object) fields.'
        }
      }
    } else {
      state.parseError = {
        message: 'Unclosed CODEEP_CALL block at end of response',
        syntaxRules: 'Each CODEEP_CALL must have a matching END_CODEEP_CALL marker.'
      }
    }
    state.isToolCallInProgress = false
    state.toolCallBuffer = ''
  }
  
  return events
}

export class DeepSeekSSEParser {
  private state = createInitialState()
  private decoder = new TextDecoder()
  
  processChunk(chunk: Uint8Array): ParserEvent[] {
    const text = this.decoder.decode(chunk, { stream: true })
    this.state.buffer += text
    const lines = this.state.buffer.split('\n')
    this.state.buffer = lines.pop() || ''
    
    const events: ParserEvent[] = []
    for (const line of lines) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      events.push(...processLine(this.state, trimmed))
    }
    return events
  }
  
  finish(): ParserEvent[] {
    this.state.buffer += this.decoder.decode()
    
    const events: ParserEvent[] = []
    
    if (this.state.buffer.length > 0) {
      const trimmed = this.state.buffer.endsWith('\r') ? this.state.buffer.slice(0, -1) : this.state.buffer
      events.push(...processLine(this.state, trimmed))
      this.state.buffer = ''
    }
    
    if (this.state.pendingLookahead) {
      events.push(...emitContentForFragment(this.state, '', this.state.currentFragmentType!))
    }
    
    events.push(...finalizeToolCallBuffer(this.state))
    
    if (!this.state.hasEmittedDone) {
      this.state.hasEmittedDone = true
      events.push(emitDone(this.state))
    }
    
    return events
  }
  
  getState(): ParserStateSnapshot {
    return createEmptySnapshot(this.state)
  }
}

export async function* parseDeepSeekSSE(
  deepSeekStream: ReadableStream<Uint8Array>
): AsyncGenerator<ParserEvent> {
  const parser = new DeepSeekSSEParser()
  const reader = deepSeekStream.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      for (const event of parser.processChunk(value)) {
        yield event
      }
    }
  } finally {
    reader.releaseLock()
  }

  for (const event of parser.finish()) {
    yield event
  }
}
