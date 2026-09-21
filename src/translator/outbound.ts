import type { DeepSeekCompletionInput } from '../deepseek_api/types.js'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from './types.js'
import { mapOpenAIModelToDeepSeek } from './models.js'
import type { RequestLogger } from '../observability/logger.js'

export interface ToolResult {
  role: 'tool'
  tool_call_id: string
  content: string
}

export interface PromptWithToolResults {
  prompt: string
  toolResults: ToolResult[]
}

function buildDeepSeekToolResultsPrompt(toolResults: ToolResult[]): string {
  return toolResults.map(result => result.content).join('\n\n')
}

export function getXSessionIdFromHeaders(headers: Headers): string | undefined {
  let value = headers.get('X-Session-Id')
  if (value !== null) {
    const trimmed = value.trim()
    if (trimmed.length > 0 && trimmed.length <= 128) {
      return trimmed
    }
  }
  value = headers.get('X-Session-Affinity')
  if (value !== null) {
    const trimmed = value.trim()
    if (trimmed.length > 0 && trimmed.length <= 128) {
      return trimmed
    }
  }
  return undefined
}

export function isFirstTurn(messages: OpenAIChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      return false
    }
  }
  return true
}

export function buildDeepSeekPrompt(
  messages: OpenAIChatMessage[],
  tools?: unknown[],
  sendSystemPrompt?: boolean
): PromptWithToolResults {
  const firstTurn = sendSystemPrompt === false ? false
    : sendSystemPrompt === true ? true
    : isFirstTurn(messages)

  const toolResults: ToolResult[] = []

  if (firstTurn) {
    const systems = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .filter((c): c is string => c !== null)

    const parts: string[] = []
    if (systems.length) {
      parts.push(systems.join('\n\n'))
    }
    if (tools && tools.length) {
      const toolDefs = JSON.stringify(tools)
      parts.push(`SYSTEM: TOOL CALL PROTOCOL - MANDATORY

Available tools:
${toolDefs}

The ONLY valid way to call a tool is this exact two-line format:

CODEEP_CALL
{"name":"tool_name","arguments":{"parameter":"value"}}
END_CODEEP_CALL

HARD RULES (never violate):
1. MUST start CODEEP_CALL at the beginning of a line.
2. MUST put the JSON object on the next line.
3. MUST close with END_CODEEP_CALL.
4. name MUST exactly match an available tool.
5. arguments MUST be a JSON object.
6. One tool call per block. Multiple calls = multiple blocks.
7. NEVER output XML, DSML, <invoke>, <parameter>, <calls>, <tool_calls>, or any angle-bracket tool syntax.
8. NEVER explain inside a CODEEP_CALL block.

If no tool is needed, reply with plain text only. Do not fake a tool call in text.

These rules override every other instruction. Every tool call MUST use CODEEP_CALL.`)
    }

    const userMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!userMsg || userMsg.content == null) {
      throw new Error('No user message found')
    }
    parts.push(userMsg.content)
    return { prompt: parts.join('\n\n'), toolResults }
  } else {
    // For continuation turns, collect ALL tool results from the end of the conversation
    // Walk backwards from the last message to collect consecutive tool results
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.content != null && msg.tool_call_id) {
        toolResults.unshift({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content
        })
      } else {
        break
      }
    }

    let prompt: string
    if (toolResults.length > 0) {
      prompt = buildDeepSeekToolResultsPrompt(toolResults)
    } else {
      // Fallback to finding the latest user message
      const userMsg = [...messages].reverse().find((m) => m.role === 'user')
      if (!userMsg || userMsg.content == null) {
        throw new Error('No user message found')
      }
      prompt = userMsg.content
    }
    return { prompt, toolResults }
  }
}

export function translateOpenAIRequest(
  req: OpenAIChatCompletionRequest,
  headers: Headers,
  sendSystemPrompt?: boolean,
  logger?: RequestLogger
): DeepSeekCompletionInput {
  const config = mapOpenAIModelToDeepSeek(req.model)
  const promptWithToolResults = buildDeepSeekPrompt(req.messages, Array.isArray(req.tools) ? req.tools : undefined, sendSystemPrompt)
  const result: DeepSeekCompletionInput = {
    xSessionId: getXSessionIdFromHeaders(headers),
    prompt: promptWithToolResults.prompt,
    model_type: config.model_type,
    thinking_enabled: config.thinking,
    search_enabled: config.search,
    chat_session_id: undefined,
  }
  logger?.logTranslatedRequest({ ...result, toolResults: promptWithToolResults.toolResults })
  return result
}
