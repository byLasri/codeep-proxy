export type FragmentType = 'THINK' | 'RESPONSE'

export interface DeepSeekSSEEvent {
  event: string | null
  data: Record<string, unknown>
}

export interface ParserStateSnapshot {
  currentFragmentType: FragmentType | null
  accumulatedReasoning: string
  accumulatedContent: string
  responseMessageId: string | null
  accumulatedTokens: number
  isComplete: boolean
  parseError: ParserError | null
  hasLegacyToolSyntax: boolean
}

export interface ParserError {
  message: string
  syntaxRules: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ParserEvent =
  | { type: 'reasoning'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }
  | { type: 'error'; error: ParserError }
  | { type: 'done'; state: ParserStateSnapshot }
  | { type: 'session_id'; id: string }
  | { type: 'tokens'; count: number }

export interface ParseResult {
  events: ParserEvent[]
  finalState: ParserStateSnapshot
}

export interface DeepSeekParser {
  processChunk(chunk: Uint8Array): ParserEvent[]
  finish(): ParserEvent[]
  getState(): ParserStateSnapshot
}