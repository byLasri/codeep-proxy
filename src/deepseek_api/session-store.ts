export interface ProtocolSession {
  chat_session_id: string;
  parent_message_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProtocolSessionStore {
  initialize(): Promise<void>;
  get(chatSessionId: string): Promise<ProtocolSession | null>;
  create(chatSessionId: string): Promise<void>;
  advance(chatSessionId: string, parentMessageId: number): Promise<void>;
}
