// OpenAI Chat Completions types for the translator module

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: any[]; // OpenAI tools for function calling
  stream?: boolean;
  // We can add other fields as needed, but for now we focus on the required ones.
  // The translator will ignore unsupported fields.
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  // ... etc
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number; // Unix timestamp
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | null | 'length' | 'content_filter' | 'tool_calls';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionStreamResponse {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: any[];
    };
    finish_reason: 'stop' | null | 'length' | 'content_filter' | 'tool_calls' | undefined;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}