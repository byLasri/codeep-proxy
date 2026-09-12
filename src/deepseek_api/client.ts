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
  origin?: string;
}

export class DeepSeekWebClient {
  private readonly stateStore: ProtocolStateStore;
  private readonly getCredentials: () => Promise<DeepSeekCredentials>;
  private readonly origin: string;
  private readonly hifLeimCache: HifLeimCache;

  constructor(config: DeepSeekWebClientConfig) {
    this.stateStore = config.stateStore;
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
   * Complete with automatic session creation if session not provided.
   * Internal method - not exposed publicly.
   * 
   * Flow:
   * 1. If no session provided -> create new session via /create
   * 2. If session provided -> validation happens at worker level with D1
   * 3. Send completion to external /completion endpoint
   * 4. On success, worker stores session with updated parent_message_id from response
   */
  async completeWithAutoSession(input: DeepSeekCompletionInput): Promise<Response> {
    let session: DeepSeekConversationState = input.session!;
    let sessionWasAutoCreated = false;
    
    // Auto-create session if not provided
    if (!session?.chat_session_id) {
      const newSession = await this.createSession();
      session = {
        chat_session_id: newSession.id,
        parent_message_id: null, // First turn always uses null
      };
      sessionWasAutoCreated = true;
    }

    // Build completion input with session
    const completionInput: DeepSeekCompletionInput = {
      ...input,
      session: {
        chat_session_id: session.chat_session_id,
        parent_message_id: session.parent_message_id ?? null,
      },
    };

    // Send completion and capture response for session update
    const response = await this.completeWithSessionUpdate(completionInput, sessionWasAutoCreated);
    
    return response;
  }

  /**
   * Sends completion request and updates session in KV on success.
   * Parses the SSE stream to extract the new response_message_id.
   */
  private async completeWithSessionUpdate(
    input: DeepSeekCompletionInput,
    sessionWasAutoCreated: boolean
  ): Promise<Response> {
    const { session, prompt, ...options } = input;

    if (!session) {
      throw new DeepSeekProtocolError(
        "Session is required for completion",
        { kind: "protocol", status: 400 }
      );
    }

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
    this.extractAndStoreSession(responseForParsing, session.chat_session_id, sessionWasAutoCreated);

    // Return streamed response to caller
    return new Response(responseForStream, {
      headers: response.headers,
    });
  }

  /**
   * Extracts response_message_id from SSE 'ready' event and stores session in KV.
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
        // Session storage is now handled at worker level with D1
        console.log("[DeepSeekWebClient] Found response_message_id:", responseMessageId, "- worker will store session");
      } else if (sessionWasAutoCreated) {
        console.log("[DeepSeekWebClient] No response_message_id found for auto-created session");
      }
    } catch (error) {
      // Log error but don't fail the main response
      console.error("[DeepSeekWebClient] Failed to extract session info:", error);
    }
  }

  async complete(input: DeepSeekCompletionInput): Promise<Response> {
    const { session, prompt, ...options } = input;

    if (!session) {
      throw new DeepSeekProtocolError(
        "Session is required for completion. Use completeWithAutoSession for automatic session creation.",
        { kind: "protocol", status: 400 }
      );
    }

    // Build the DeepSeek completion request
    const request = buildCompletionRequest(session, prompt, options);

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

    // Return raw Response - caller handles SSE parsing
    return response;
  }
}