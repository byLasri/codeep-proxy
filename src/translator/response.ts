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
  detectedDialect: DSMLDialect | null
}

export interface DSMLParseResult {
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  isMalformed?: boolean
  error?: { message: string; syntaxRules: string }
}

type DSMLDelimiter = 'single' | 'double' | 'mixed' | 'ascii'
type DSMLWrapper = 'function_calls' | 'tool_calls' | 'calls' | 'toolcalls' | 'tool'

interface DSMLDialect {
  delimiter: DSMLDelimiter
  wrapper: DSMLWrapper
  openCalls: string
  closeCalls: string
  openInvoke: string
  closeInvoke: string
  openParameter: string
  closeParameter: string
}

const DELIMITER_PATTERNS: Record<DSMLDelimiter, { prefix: string }> = {
  single: { prefix: '<｜DSML｜' },
  double: { prefix: '<｜｜DSML｜｜' },
  mixed: { prefix: '<｜DSML｜｜' },
  ascii: { prefix: '<||DSML||' },
}

const WRAPPER_NAMES: DSMLWrapper[] = ['function_calls', 'tool_calls', 'calls', 'toolcalls', 'tool']

function detectDialect(xml: string): DSMLDialect | null {
  for (const [delimiterKey, { prefix }] of Object.entries(DELIMITER_PATTERNS) as [DSMLDelimiter, { prefix: string }][]) {
    for (const wrapper of WRAPPER_NAMES) {
      // Try with space first (full-width forms), then without space (ASCII form)
      const openCallsWithSpace = `${prefix} ${wrapper}>`
      const openCallsNoSpace = `${prefix}${wrapper}>`
      const closeCallsWithSpace = `</${prefix.slice(1)} ${wrapper}>`
      const closeCallsNoSpace = `</${prefix.slice(1)}${wrapper}>`
      const openInvokeWithSpace = `${prefix} invoke`
      const openInvokeNoSpace = `${prefix}invoke`
      const closeInvokeWithSpace = `</${prefix.slice(1)} invoke>`
      const closeInvokeNoSpace = `</${prefix.slice(1)}invoke>`
      const openParameterWithSpace = `${prefix} parameter`
      const openParameterNoSpace = `${prefix}parameter`
      const closeParameterWithSpace = `</${prefix.slice(1)} parameter>`
      const closeParameterNoSpace = `</${prefix.slice(1)}parameter>`
      
      // Check both variants
      if (xml.includes(openCallsWithSpace) || xml.includes(openCallsNoSpace)) {
        const hasSpace = xml.includes(openCallsWithSpace)
        return {
          delimiter: delimiterKey,
          wrapper,
          openCalls: hasSpace ? openCallsWithSpace : openCallsNoSpace,
          closeCalls: hasSpace ? closeCallsWithSpace : closeCallsNoSpace,
          openInvoke: hasSpace ? openInvokeWithSpace : openInvokeNoSpace,
          closeInvoke: hasSpace ? closeInvokeWithSpace : closeInvokeNoSpace,
          openParameter: hasSpace ? openParameterWithSpace : openParameterNoSpace,
          closeParameter: hasSpace ? closeParameterWithSpace : closeParameterNoSpace,
        }
      }
    }
  }
  return null
}

function normalizeToCanonical(xml: string, dialect: DSMLDialect): string {
  let normalized = xml
  
  // Replace calls tags
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.openCalls), 'g'), '<｜｜DSML｜｜ calls>')
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.closeCalls), 'g'), '</｜｜DSML｜｜ calls>')
  
  // Replace invoke tags
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.openInvoke), 'g'), '<｜｜DSML｜｜ invoke')
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.closeInvoke), 'g'), '</｜｜DSML｜｜ invoke>')
  
  // Replace parameter tags
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.openParameter), 'g'), '<｜｜DSML｜｜ parameter')
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.closeParameter), 'g'), '</｜｜DSML｜｜ parameter>')
  
  return normalized
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CORRECTIVE_MESSAGE = `Your previous response contained a malformed tool call that could not be parsed.
The tool call was NOT executed.

Here is the EXACT format you must follow:

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="tool_name">
<｜｜DSML｜｜ parameter name="param1" string="true">value1</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="param2" string="false">value2</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="another_tool">
<｜｜DSML｜｜ parameter name="param" string="true">value</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>

Rules:
1. Structure: <｜｜DSML｜｜ calls> contains one or more <｜｜DSML｜｜ invoke> blocks. Each <｜｜DSML｜｜ invoke> contains one or more <｜｜DSML｜｜ parameter> blocks.
2. Parameters MUST be inside an <｜｜DSML｜｜ invoke> block. Never place a parameter outside an invoke.
3. Always use the full tag format: <｜｜DSML｜｜ parameter name="param_name" string="true">value</｜｜DSML｜｜ parameter>
4. Every opening tag must have exactly ONE matching closing tag with a forward slash: </｜｜DSML｜｜ tagname>
5. Closing tags must NOT contain any attributes. Write </｜｜DSML｜｜ invoke>, not <｜｜DSML｜｜ invoke>.
6. Each separate tool call needs its own <｜｜DSML｜｜ invoke name="..."> block.
7. Do not add extra text or tags outside the DSML structure.

Please retry the tool call now using exactly this syntax. Do not add any text outside the DSML structure.`

function parseDSMLToolCalls(xml: string): DSMLParseResult {
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  
  // Detect dialect
  const dialect = detectDialect(xml)
  if (!dialect) {
    // No supported DSML dialect detected - this is normal for text responses
    return { toolCalls: [] }
  }
  
  // Normalize to canonical form for structural validation
  const normalizedXml = normalizeToCanonical(xml, dialect)
  
  // Check for basic DSML structure in normalized form
  const hasCallsStart = normalizedXml.includes('<｜｜DSML｜｜ calls>')
  const hasCallsEnd = normalizedXml.includes('</｜｜DSML｜｜ calls>')
  
  if (!hasCallsStart && !hasCallsEnd) {
    return { toolCalls: [] }
  }
  
  // Validate DSML structure strictly
  // Check for missing closing </｜｜DSML｜｜ calls> tag
  if (hasCallsStart && !hasCallsEnd) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: 'Missing closing </｜｜DSML｜｜ calls> tag',
        syntaxRules: CORRECTIVE_MESSAGE
      }
    }
  }
  
  // Extract content between calls tags
  const callsMatch = normalizedXml.match(/<｜｜DSML｜｜\s+calls>([\s\S]*?)<\/｜｜DSML｜｜\s+calls>/)
  if (!callsMatch) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: 'Invalid DSML calls structure',
        syntaxRules: CORRECTIVE_MESSAGE
      }
    }
  }
  
  const callsContent = callsMatch[1]
  
  // Check for unclosed invoke tags first (before orphan parameter check)
  const openInvokeCount = (callsContent.match(/<｜｜DSML｜｜\s+invoke\s/g) || []).length
  const closedInvokeCount = (callsContent.match(/<\/｜｜DSML｜｜\s+invoke>/g) || []).length
  if (openInvokeCount !== closedInvokeCount) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: `Mismatched <invoke> tags: ${openInvokeCount} opening tags but only ${closedInvokeCount} closing tags`,
        syntaxRules: CORRECTIVE_MESSAGE
      }
    }
  }
  
  // Check for parameters directly under <calls> (outside any <invoke>)
  // First, remove all invoke blocks to see if any parameters remain
  const withoutInvokes = callsContent.replace(/<｜｜DSML｜｜\s+invoke[\s\S]*?<\/｜｜DSML｜｜\s+invoke>/g, '')
  const orphanParamMatch = withoutInvokes.match(/<｜｜DSML｜｜\s+parameter\s/)
  if (orphanParamMatch) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: 'Parameter found outside of <invoke> block. Parameters MUST be inside an <invoke> block.',
        syntaxRules: CORRECTIVE_MESSAGE
      }
    }
  }
  
  // Check for unknown/invalid elements directly under <calls>
  // Valid elements under <calls> are only <invoke> blocks
  const directChildrenRegex = /<｜｜DSML｜｜\s+(?!invoke\b|parameter\b)[a-zA-Z]+/g
  const invalidElementMatch = callsContent.match(directChildrenRegex)
  if (invalidElementMatch) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: `Invalid DSML element found: ${invalidElementMatch[0]}. Only <invoke> elements are allowed inside <calls>.`,
        syntaxRules: CORRECTIVE_MESSAGE
      }
    }
  }
  
  // Extract and validate each invoke block
  const invokeRegex = /<｜｜DSML｜｜\s+invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s+invoke>/g
  let invokeMatch
  
  while ((invokeMatch = invokeRegex.exec(callsContent)) !== null) {
    const toolName = invokeMatch[1]
    const invokeContent = invokeMatch[2]
    
    // Skip if tool name is empty
    if (!toolName || toolName.trim() === '') {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: 'Tool name is empty or missing in <invoke> tag',
          syntaxRules: CORRECTIVE_MESSAGE
        }
      }
    }
    
    // Extract parameters from this invoke block
    const params: Record<string, string> = {}
    const paramRegex = /<｜｜DSML｜｜\s+parameter\s+name="([^"]+)"\s+string="(true|false)"\s*>([^<]*)<\/｜｜DSML｜｜\s+parameter>/g
    let paramMatch
    
    while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
      const paramName = paramMatch[1]
      const paramValue = paramMatch[3]?.trim() || ''
      
      // Only include valid parameter names
      if (paramName && paramName.trim() !== '') {
        params[paramName] = paramValue
      }
    }
    
    // Check for malformed parameter tags within this invoke
    // Look for parameters without proper closing tags
    const malformedParamRegex = /<｜｜DSML｜｜\s+parameter\s+name="[^"]*"[^>]*>(?![^<]*<\/｜｜DSML｜｜\s+parameter>)/g
    const hasMalformedParam = invokeContent.match(malformedParamRegex)
    if (hasMalformedParam) {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: 'Malformed parameter tag detected - missing closing </｜｜DSML｜｜ parameter> tag',
          syntaxRules: CORRECTIVE_MESSAGE
        }
      }
    }

    // Check for parameters missing required string attribute
    const paramWithoutStringRegex = /<｜｜DSML｜｜\s+parameter\s+name="[^"]*"(?![^>]*\s+string="(true|false)")[^>]*>/g
    const hasParamWithoutString = invokeContent.match(paramWithoutStringRegex)
    if (hasParamWithoutString) {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: 'Parameter tag missing required string="true|false" attribute',
          syntaxRules: CORRECTIVE_MESSAGE
        }
      }
    }
    
    // Add the tool call
    toolCalls.push({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(params)
      }
    })
  }
  
  // If no tool calls were found but DSML structure exists, it's malformed
  if (toolCalls.length === 0 && hasCallsStart) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: '<calls> block must contain at least one <invoke> element',
        syntaxRules: CORRECTIVE_MESSAGE
      }
    }
  }
  
  return { toolCalls }
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
    toolCallBuffer: '',
    isToolCallInProgress: false,
    parsedToolCalls: [],
    parseError: null,
    pendingLookahead: '',
    detectedDialect: null,
  }

  const emitFinal = () => {
    if (state.hasEmittedDone) return
    state.hasEmittedDone = true
    
    // Check if DSML parsing failed (malformed DSML detected)
    if (state.parseError) {
      // Malformed DSML detected - emit empty response with no tool calls
      // The caller will detect this and perform internal retry
      // Do NOT emit the corrective message to client - it's for internal retry only
      const finalChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))
      
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
        enqueue(new TextEncoder().encode(formatOpenAISSEChunk(usageChunk)))
      }
      
      enqueue(new TextEncoder().encode(formatOpenAIDone()))
      return
    }
    
    if (state.parsedToolCalls.length > 0) {
      // Emit tool calls if we have any (valid DSML)
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
      // No tool calls - emit final stop chunk (valid text response)
      const finalChunk: OpenAIChatCompletionStreamResponse = {
        id: `chatcmpl-${state.responseMessageId}`,
        object: 'chat.completion.chunk',
        created: info.created,
        model: info.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(finalChunk)))
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
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(usageChunk)))
    }
    
    enqueue(new TextEncoder().encode(formatOpenAIDone()))
  }

  const emitContent = (text: string) => {
    const DSML_START_PATTERNS = [
      '<｜｜DSML｜｜ calls>',
      '<｜DSML｜｜ calls>',
      '<｜DSML｜ calls>',
      '<｜DSML｜ tool_calls>',
      '<｜DSML｜ function_calls>',
      '<｜DSML｜ toolcalls>',
      '<｜DSML｜ tool>',
      '<||DSML||tool_calls>',
      '<||DSML||function_calls>',
      '<||DSML||calls>',
      '<||DSML||toolcalls>',
      '<||DSML||tool>',
    ]
    
    // If tool call buffering is already in progress
    if (state.isToolCallInProgress) {
      state.toolCallBuffer += text
      // Check for any closing calls tag
      if (state.toolCallBuffer.includes('</｜｜DSML｜｜ calls>') || 
          state.toolCallBuffer.includes('</｜DSML｜｜ calls>') ||
          state.toolCallBuffer.includes('</｜DSML｜ calls>') ||
          state.toolCallBuffer.includes('</｜DSML｜ tool_calls>') ||
          state.toolCallBuffer.includes('</｜DSML｜ function_calls>') ||
          state.toolCallBuffer.includes('</｜DSML｜ toolcalls>') ||
          state.toolCallBuffer.includes('</｜DSML｜ tool>') ||
          state.toolCallBuffer.includes('</||DSML||tool_calls>') ||
          state.toolCallBuffer.includes('</||DSML||function_calls>') ||
          state.toolCallBuffer.includes('</||DSML||calls>') ||
          state.toolCallBuffer.includes('</||DSML||toolcalls>') ||
          state.toolCallBuffer.includes('</||DSML||tool>')) {
        const result = parseDSMLToolCalls(state.toolCallBuffer)
        state.parsedToolCalls = result.toolCalls
        // Store parse error in state for malformed DSML detection
        if (result.isMalformed && result.error) {
          state.parseError = result.error
        }
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

    // Check for full DSML start pattern (any supported dialect)
    let dsmlIdx = -1
    let matchedStartPattern = ''
    for (const pattern of DSML_START_PATTERNS) {
      const idx = fullContent.indexOf(pattern)
      if (idx !== -1 && (dsmlIdx === -1 || idx < dsmlIdx)) {
        dsmlIdx = idx
        matchedStartPattern = pattern
      }
    }

    if (dsmlIdx !== -1) {
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
          enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
        }
        const safeChunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${state.responseMessageId}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: isReasoning ? { reasoning_content: newSafeContent } : { content: newSafeContent }, finish_reason: null }],
        }
        enqueue(new TextEncoder().encode(formatOpenAISSEChunk(safeChunk)))
      }
      
      // Start tool call buffering
      state.isToolCallInProgress = true
      state.detectedDialect = detectDialect(matchedStartPattern + '>') // Add > to make it a complete tag for detection
      state.toolCallBuffer = fullContent.substring(dsmlIdx)
      state.accumulatedContent = beforeDSML
      return
    }

    // Check for partial DSML prefix at the end - HOLD BACK these characters
    let holdbackLength = 0
    for (const pattern of DSML_START_PATTERNS) {
      for (let i = 1; i < pattern.length; i++) {
        if (fullContent.endsWith(pattern.substring(0, i))) {
          holdbackLength = Math.max(holdbackLength, i)
        }
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
          enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
        }
        const chunk: OpenAIChatCompletionStreamResponse = {
          id: `chatcmpl-${state.responseMessageId}`,
          object: 'chat.completion.chunk',
          created: info.created,
          model: info.model,
          choices: [{ index: 0, delta: isReasoning ? { reasoning_content: newContent } : { content: newContent }, finish_reason: null }],
        }
        enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
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
      enqueue(new TextEncoder().encode(formatOpenAISSEChunk(roleChunk)))
    }

    const chunk: OpenAIChatCompletionStreamResponse = {
      id: `chatcmpl-${state.responseMessageId}`,
      object: 'chat.completion.chunk',
      created: info.created,
      model: info.model,
      choices: [{ index: 0, delta: isReasoning ? { reasoning_content: newContent } : { content: newContent }, finish_reason: null }],
    }
    enqueue(new TextEncoder().encode(formatOpenAISSEChunk(chunk)))
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

export { parseDSMLToolCalls, CORRECTIVE_MESSAGE }

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

  // Check for unclosed DSML at EOF
  const closingTags = [
    '</｜｜DSML｜｜ calls>',
    '</｜DSML｜｜ calls>',
    '</｜DSML｜ calls>',
    '</｜DSML｜ tool_calls>',
    '</｜DSML｜ function_calls>',
    '</｜DSML｜ toolcalls>',
    '</｜DSML｜ tool>',
    '</||DSML||tool_calls>',
    '</||DSML||function_calls>',
    '</||DSML||calls>',
    '</||DSML||toolcalls>',
    '</||DSML||tool>',
  ]
  if (parser.state.isToolCallInProgress && !closingTags.some(tag => parser.state.toolCallBuffer.includes(tag))) {
    const result = parseDSMLToolCalls(parser.state.toolCallBuffer)
    parser.state.parsedToolCalls = result.toolCalls
    if (result.isMalformed && result.error) {
      parser.state.parseError = result.error
    }
    parser.state.isToolCallInProgress = false
    parser.state.toolCallBuffer = ''
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
  
  // If DSML is malformed, return error info WITHOUT sending to client
  // The caller (index.ts) will handle the internal retry loop
  if (dsmlResult.isMalformed && dsmlResult.error) {
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
      _malformedError: dsmlResult.error,
    }
    logger?.logOutgoingToClient(result)
    return result
  }
  
  // If tool calls are found (valid DSML), return them with finish_reason: "tool_calls"
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
