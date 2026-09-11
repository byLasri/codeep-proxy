import type { CompletionSessionState } from './deepssek_completions/types.js';
import type { DeepSeekCompletionInput } from './deepseek/index.js';
import { CompletionService, validateCompletionRequest } from './deepssek_completions/index.js';
import { CloudflareKVStateStore } from './adapters/cloudflare-kv-state-store.js';
import { DeepSeekWebClient } from './deepseek/index.js';

interface Env {
  AUTH_KV: KVNamespace;
  COMPLETION_SESSIONS: DurableObjectNamespace;
}

export class CompletionSessionDO {
  private state: DurableObjectState;
  private env: Env;
  private client: DeepSeekWebClient | null = null;
  private processingLock: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Initialize SQLite storage
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chat_session_id TEXT NOT NULL,
        parent_message_id INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/completions' && request.method === 'POST') {
      return this.handleCompletion(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleCompletion(request: Request): Promise<Response> {
    try {
      const body = await request.json();

      // Validate request using shared validation logic
      try {
        const openAIRequest = validateCompletionRequest(body);
        
        // Get or create DeepSeek client
        const client = await this.getDeepSeekClient();

        // Load or create session state
        let sessionState = await this.loadSessionState();

        if (!sessionState) {
          // First request - create new DeepSeek session
          const session = await client.createSession();
          sessionState = {
            chat_session_id: session.id,
            parent_message_id: null,
            updated_at: Date.now(),
          };
          await this.saveSessionState(sessionState);
        }

        // Use CompletionService for OpenAI translation
        const service = new CompletionService(client);
        
        // Use processing lock to serialize requests for this conversation
        return await this.withProcessingLock(async () => {
          return await service.processCompletion(openAIRequest, sessionState, { AUTH_KV: this.env.AUTH_KV });
        });
      } catch (err) {
        return new Response(JSON.stringify({
          error: {
            message: err instanceof Error ? err.message : 'Invalid request',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (err) {
      console.error('Completion error:', err);
      const status = this.mapErrorToStatus(err);
      return new Response(JSON.stringify({
        error: {
          message: err instanceof Error ? err.message : 'Internal server error',
        },
      }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async getDeepSeekClient(): Promise<DeepSeekWebClient> {
    if (!this.client) {
      const stateStore = new CloudflareKVStateStore(
        this.env.AUTH_KV
      );

      this.client = new DeepSeekWebClient({
        stateStore,
      });
    }
    return this.client;
  }

  private async loadSessionState(): Promise<CompletionSessionState | null> {
    const result = this.state.storage.sql
      .exec('SELECT chat_session_id, parent_message_id, updated_at FROM session_state WHERE id = 1')
      .one() as { chat_session_id: string; parent_message_id: number | null; updated_at: number } | undefined;

    if (!result) {
      return null;
    }

    return {
      chat_session_id: result.chat_session_id,
      parent_message_id: result.parent_message_id,
      updated_at: result.updated_at,
    };
  }

  private async saveSessionState(state: CompletionSessionState): Promise<void> {
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO session_state (id, chat_session_id, parent_message_id, updated_at)
       VALUES (1, ?, ?, ?)`,
      [1, state.chat_session_id, state.parent_message_id, state.updated_at]
    );
  }

  private async withProcessingLock<T>(fn: () => Promise<T>): Promise<T> {
    // Wait for any ongoing processing to complete
    while (this.processingLock) {
      await this.processingLock;
    }

    // Create new lock
    let releaseLock: () => void;
    this.processingLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      return await fn();
    } finally {
      releaseLock!();
      this.processingLock = null;
    }
  }

  private mapErrorToStatus(err: unknown): number {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes('credentials') || msg.includes('auth')) return 401;
      if (msg.includes('invalid') || msg.includes('missing')) return 400;
    }
    return 502;
  }
}
