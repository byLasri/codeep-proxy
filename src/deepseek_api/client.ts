import { DEEPSEEK } from "./constants.js";
import type {
  DeepSeekCredentials,
  DeepSeekSession,
  DeepSeekCompletionInput,
  DeepSeekConversationState,
} from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";
import { createSession } from "./session.js";
import { createPowChallenge } from "./pow-challenge.js";
import { solvePow, encodePowResponse } from "./pow.js";
import { buildCompletionRequest } from "./completion.js";
import { buildCompletionHeaders } from "./headers.js";
import { HifLeimCache } from "./hif-leim.js";
import type { ProtocolStateStore } from "./state-store.js";
import { PROTOCOL_STATE_KEYS } from "./state-store.js";
import type { ProtocolSessionStore } from "./session-store.js";

export interface StoredDeepSeekCredentials {
  authorizationToken?: string;
  cookies?: Array<{
    name: string;
    value: string;
  }>;
}

/**
 * Reads credentials from ProtocolStateStore using the canonical AUTH key.
 * This is the default credential resolution strategy for the DeepSeek module.
 */
export function createDefaultCredentialsReader(
  stateStore: ProtocolStateStore
): { getCredentials(): Promise<DeepSeekCredentials> } {
  return {
    getCredentials: async (): Promise<DeepSeekCredentials> => {
      const authJson = await stateStore.get(PROTOCOL_STATE_KEYS.AUTH);
      
      if (!authJson) {
        throw new DeepSeekProtocolError(
          "Credentials not found in state store",
          { kind: "credentials", status: 401 }
        );
      }
      
      let stored: unknown;
      try {
        stored = JSON.parse(authJson);
      } catch (e) {
        throw new DeepSeekProtocolError(
          "Invalid credentials format in state store",
          { kind: "credentials", status: 401 }
        );
      }
      
      // Validate shape
      if (typeof stored !== 'object' || stored === null) {
        throw new DeepSeekProtocolError(
          "Credentials must be an object",
          { kind: "credentials", status: 401 }
        );
      }
      
      const obj = stored as Record<string, unknown>;
      
      // Validate authorizationToken if present
      let authorizationToken: string | undefined;
      if (obj.authorizationToken !== undefined) {
        if (typeof obj.authorizationToken !== 'string') {
          throw new DeepSeekProtocolError(
            "authorizationToken must be a string",
            { kind: "credentials", status: 401 }
          );
        }
        authorizationToken = obj.authorizationToken;
      }
      
      // Validate cookies if present
      let cookies: Array<{ name: string; value: string }> | undefined;
      if (obj.cookies !== undefined) {
        if (!Array.isArray(obj.cookies)) {
          throw new DeepSeekProtocolError(
            "cookies must be an array",
            { kind: "credentials", status: 401 }
          );
        }
        
        cookies = obj.cookies.map((cookie: unknown, index: number) => {
          if (typeof cookie !== 'object' || cookie === null) {
            throw new DeepSeekProtocolError(
              `Cookie at index ${index} must be an object`,
              { kind: "credentials", status: 401 }
            );
          }
          
          const c = cookie as Record<string, unknown>;
          if (typeof c.name !== 'string') {
            throw new DeepSeekProtocolError(
              `Cookie at index ${index} missing name`,
              { kind: "credentials", status: 401 }
            );
          }
          if (typeof c.value !== 'string') {
            throw new DeepSeekProtocolError(
              `Cookie at index ${index} missing value`,
              { kind: "credentials", status: 401 }
            );
          }
          
          return { name: c.name, value: c.value };
        });
      }
      
      // Build cookie header
      const cookieHeader = cookies?.map(c => `${c.name}=${c.value}`).join('; ') || '';
      
      return {
        authorization: authorizationToken,
        cookie: cookieHeader || undefined,
      };
    },
  };
}

export interface DeepSeekWebClientConfig {
  stateStore: ProtocolStateStore;
  sessionStore: ProtocolSessionStore;
  origin?: string;
}

export interface CompletionResult {
  response: Response;
  sessionUpdatePromise: Promise<void>;
}

export class DeepSeekWebClient {
  private readonly stateStore: ProtocolStateStore;
  private readonly sessionStore: ProtocolSessionStore;
  private readonly getCredentials: () => Promise<DeepSeekCredentials>;
  private readonly origin: string;
  private readonly hifLeimCache: HifLeimCache;

  constructor(config: DeepSeekWebClientConfig) {
    this.stateStore = config.stateStore;
    this.sessionStore = config.sessionStore;
    this.origin = config.origin || DEEPSEEK.ORIGIN;

    // Initialize HIF-LEIM cache with the protocol state store
    this.hifLeimCache = new HifLeimCache(this.stateStore);

    // Create default credentials reader that reads from state store
    const credentialsReader = createDefaultCredentialsReader(this.stateStore);
    this.getCredentials = () => credentialsReader.getCredentials();
  }

  async createSession(): Promise<DeepSeekSession> {
    const credentials = await this.getCredentials();
    return createSession(credentials, this.origin);
  }

  /**
   * Complete with automatic session management.
   * 
   * Flow:
   * 1. If chat_session_id provided -> retrieve parent_message_id from sessionStore
   * 2. If no chat_session_id -> create new DeepSeek session, parent_message_id = null
   * 3. Send completion to external /completion endpoint with resolved parent_message_id
   * 4. On success, extract response_message_id and store as new parent_message_id
   */
  async completeWithAutoSession(input: DeepSeekCompletionInput): Promise<CompletionResult> {
    const chat_session_id = input.chat_session_id;
    let sessionWasAutoCreated = false;
    let resolvedParentMessageId: number | null = null;
    let resolvedChatSessionId: string;

    if (chat_session_id) {
      // Caller provided a session ID - resolve parent_message_id from store
      const existingSession = await this.sessionStore.get(chat_session_id);
      if (!existingSession) {
        throw new DeepSeekProtocolError(
          `Session not found: ${chat_session_id}`,
          { kind: "session", status: 404 }
        );
      }
      resolvedChatSessionId = chat_session_id;
      resolvedParentMessageId = existingSession.parent_message_id ?? null;
    } else {
      // No session ID provided - create new DeepSeek session
      const newSession = await this.createSession();
      resolvedChatSessionId = newSession.id;
      resolvedParentMessageId = null; // First turn always uses null
      sessionWasAutoCreated = true;

      // Store initial session state
      await this.sessionStore.set(resolvedChatSessionId, {
        chat_session_id: resolvedChatSessionId,
        parent_message_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    // Build completion input with protocol-resolved session state
    const completionInput: DeepSeekCompletionInput = {
      ...input,
      chat_session_id: resolvedChatSessionId,
    };

    // Create a session state object for the completion request
    const sessionState: DeepSeekConversationState = {
      chat_session_id: resolvedChatSessionId,
      parent_message_id: resolvedParentMessageId,
    };

    // Send completion and capture response for session update
    const { response, sessionUpdatePromise } = await this.completeWithSessionUpdate(
      sessionState,
      completionInput,
      sessionWasAutoCreated
    );

    return { response, sessionUpdatePromise };
  }

  /**
   * Sends completion request and updates session in KV on success.
   * Parses the SSE stream to extract the new response_message_id.
   */
  private async completeWithSessionUpdate(
    session: DeepSeekConversationState,
    input: DeepSeekCompletionInput,
    sessionWasAutoCreated: boolean
  ): Promise<{ response: Response; sessionUpdatePromise: Promise<void> }> {
    const { prompt, ...options } = input;

    // Build the DeepSeek completion request
    // Only pass required options - fixed values (action, preempt, ref_file_ids) enforced in buildCompletionRequest
    const request = buildCompletionRequest(session, prompt, {
      model_type: options.model_type,
      thinking_enabled: options.thinking_enabled ?? false,
      search_enabled: options.search_enabled ?? false,
    });

    // Fetch HIF-LEIM value (cached with automatic refresh and concurrency deduplication)
    const hifLeim = await this.hifLeimCache.getValue();

    // Create PoW challenge
    const credentials = await this.getCredentials();
    const challenge = await createPowChallenge(credentials, this.origin);

    // Solve PoW
    const solution = solvePow(challenge);

    // Encode PoW response
    const powHeader = encodePowResponse(solution);

    // Build completion headers with HIF-LEIM
    const headers = buildCompletionHeaders(credentials, powHeader, hifLeim);

    // Send completion request
    const response = await fetch(`${this.origin}${DEEPSEEK.ENDPOINTS.COMPLETION}`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new DeepSeekProtocolError(
        `DeepSeek completion failed: HTTP ${response.status}`,
        { kind: "completion", status: response.status }
      );
    }

    // Clone response body for session extraction (we need to read it twice)
    const [responseForStream, responseForParsing] = response.body!.tee();

    console.log("[DeepSeekWebClient] Response received, starting session extraction...");

    // Parse SSE stream in background to extract response_message_id and store session
    const sessionUpdatePromise = this.extractAndStoreSession(responseForParsing, session.chat_session_id, sessionWasAutoCreated);

    // Return streamed response to caller
    return {
      response: new Response(responseForStream, {
        headers: response.headers,
      }),
      sessionUpdatePromise,
    };
  }

  /**
   * Extracts response_message_id from SSE 'ready' event and stores session via ProtocolSessionStore.
   * Runs asynchronously to not block the response stream.
   */
  private async extractAndStoreSession(
    body: ReadableStream<Uint8Array>,
    chat_session_id: string,
    sessionWasAutoCreated: boolean
  ): Promise<void> {
    try {
      console.log("[DeepSeekWebClient] extractAndStoreSession started for:", chat_session_id);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let responseMessageId: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[DeepSeekWebClient] Stream reading done");
          break;
        }

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            try {
              const data = JSON.parse(dataStr);

              // Look for ready event with response_message_id
              if (data.response_message_id !== undefined && data.request_message_id !== undefined) {
                responseMessageId = data.response_message_id;
                console.log("[DeepSeekWebClient] Found response_message_id:", responseMessageId);
                break;
              }
            } catch {
              // Non-JSON data, ignore
            }
          }
        }

        if (responseMessageId !== null) break;
      }

      reader.releaseLock();

      if (responseMessageId !== null) {
        // Store the updated session with new parent_message_id
        const existingSession = await this.sessionStore.get(chat_session_id);
        if (existingSession) {
          await this.sessionStore.set(chat_session_id, {
            ...existingSession,
            parent_message_id: responseMessageId,
            updated_at: Date.now(),
          });
          console.log("[DeepSeekWebClient] Stored session with parent_message_id:", responseMessageId);
        } else if (sessionWasAutoCreated) {
          // Fallback: session wasn't found, create it
          await this.sessionStore.set(chat_session_id, {
            chat_session_id,
            parent_message_id: responseMessageId,
            created_at: Date.now(),
            updated_at: Date.now(),
          });
          console.log("[DeepSeekWebClient] Created and stored session with parent_message_id:", responseMessageId);
        }
      } else if (sessionWasAutoCreated) {
        console.log("[DeepSeekWebClient] No response_message_id found for auto-created session");
      }
    } catch (error) {
      // Log error but don't fail the main response
      console.error("[DeepSeekWebClient] Failed to extract session info:", error);
    }
  }

  async complete(input: DeepSeekCompletionInput): Promise<CompletionResult> {
    // Delegate to completeWithAutoSession which handles session resolution and persistence
    return this.completeWithAutoSession(input);
  }
}