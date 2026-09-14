import type { DeepSeekCompletionInput } from '../deepseek_api/types.js'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from './types.js'
import { mapOpenAIModelToDeepSeek } from './models.js'
import type { RequestLogger } from '../observability/logger.js'

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
): string {
  const firstTurn = sendSystemPrompt === false ? false
    : sendSystemPrompt === true ? true
    : isFirstTurn(messages)

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
      parts.push(JSON.stringify(tools))
    }

    const userMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!userMsg || userMsg.content == null) {
      throw new Error('No user message found')
    }
    parts.push(userMsg.content)
    return parts.join('\n\n')
  } else {
    const userMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!userMsg || userMsg.content == null) {
      throw new Error('No user message found')
    }
    return userMsg.content
  }
}

export function translateOpenAIRequest(
  req: OpenAIChatCompletionRequest,
  headers: Headers,
  sendSystemPrompt?: boolean,
  logger?: RequestLogger
): DeepSeekCompletionInput {
  const config = mapOpenAIModelToDeepSeek(req.model)
  const result: DeepSeekCompletionInput = {
    xSessionId: getXSessionIdFromHeaders(headers),
    prompt: buildDeepSeekPrompt(req.messages, Array.isArray(req.tools) ? req.tools : undefined, sendSystemPrompt),
    model_type: config.model_type,
    thinking_enabled: config.thinking,
    search_enabled: config.search,
    chat_session_id: undefined,
  }
  logger?.logTranslatedRequest(result)
  return result
}
