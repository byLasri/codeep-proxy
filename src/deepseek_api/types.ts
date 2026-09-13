// DeepSeek Web Protocol Types
// Pure protocol types — no application-layer concepts

export type DeepSeekModelType =
  | "expert"
  | "default"
  | null
  | string;

export interface DeepSeekCompletionRequest {
  chat_session_id: string;
  parent_message_id: number | null;
  model_type: DeepSeekModelType;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  action: unknown | null;
  preempt: boolean;
}

export interface DeepSeekSession {
  id: string;
  seq_id?: number;
  agent?: string;
  model_type?: string | null;
  current_message_id?: number | null;
  ttl_seconds?: number;
  [key: string]: unknown;
}

export interface DeepSeekConversationState {
  chat_session_id: string;
  parent_message_id: number | null;

  model_type?: DeepSeekModelType;
  thinking_enabled?: boolean;
  search_enabled?: boolean;

  created_at?: number;
  updated_at?: number;
}

export interface DeepSeekPowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at?: number;
  expire_after?: number;
  target_path: string;

  [key: string]: unknown;
}

export interface DeepSeekPowSolution {
  [key: string]: unknown;
}

export interface DeepSeekClientHeaders {
  authorization?: string;
  cookie?: string;

  "x-client-bundle-id": string;
  "x-client-platform": string;
  "x-client-version": string;
  "x-client-locale": string;
  "x-client-timezone-offset": string;

  "x-hif-leim"?: string;
  "x-ds-pow-response"?: string;

  "content-type": string;
  accept: string;
}

export interface DeepSeekApiResponse<T = unknown> {
  code: number;
  data?: {
    biz_data?: T;
  };
  msg?: string;
}

export interface DeepSeekCompletionInput {
  chat_session_id?: string;
  prompt: string;

  model_type: DeepSeekModelType;  // required - no fallback
  thinking_enabled: boolean;
  search_enabled: boolean;
  // ref_file_ids: [] (FIXED - protocol constant, enforced in deepseek_api)
  // action: null (FIXED - protocol constant, enforced in deepseek_api)
  // preempt: false (FIXED - protocol constant, enforced in deepseek_api)
}

export interface DeepSeekCredentials {
  authorization?: string;
  cookie?: string;
}