export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
}

export interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIChatMessage[]
  tools?: unknown[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  temperature?: number
  [key: string]: unknown
}

export interface OpenAIChatCompletionChoice {
  index: number
  message: { role: 'assistant'; content: string; reasoning_content?: string }
  finish_reason: string
}

export interface OpenAIChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChatCompletionChoice[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface OpenAIChatCompletionStreamChoice {
  index: number
  delta: { role?: 'assistant'; content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id: string; type: 'function'; function: { name: string; arguments: string } }> }
  finish_reason: string | null
}

export interface OpenAIChatCompletionStreamResponse {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: OpenAIChatCompletionStreamChoice[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}
