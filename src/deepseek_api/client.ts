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
import type { ProtocolSessionStore, ProxySessionState } from "./session-store.js";
import type { RequestLogger } from '../observability/logger.js'
import { teeAndLogStream } from '../observability/logger.js'
import { editMessage, type EditMessageOptions } from "./edit-message.js";

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

export interface EditMessageIds {
  request_message_id: number;
  response_message_id: number;
}

export interface CompletionResult {
  response: Response;
  sessionUpdatePromise: Promise<void>;
  editMessageIdsPromise?: Promise<EditMessageIds>;
}

export interface ResolvedSession {
  chat_session_id: string;
  parent_message_id: number | null;
  existingState: ProxySessionState | null;
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
  async resolveSession(input: DeepSeekCompletionInput): Promise<ResolvedSession> {
    const xSessionId = input.xSessionId;
    const existingState = xSessionId
      ? await this.sessionStore.get(xSessionId)
      : null;

    if (existingState) {
      return {
        chat_session_id: existingState.chat_session_id,
        parent_message_id: existingState.parent_message_id,
        existingState,
      };
    }

    if (input.chat_session_id) {
      return {
        chat_session_id: input.chat_session_id,
        parent_message_id: null,
        existingState: null,
      };
    }

    const newSession = await this.createSession();
    return {
      chat_session_id: newSession.id,
      parent_message_id: null,
      existingState: null,
    };
  }

  async completeWithAutoSession(
    input: DeepSeekCompletionInput,
    logger?: RequestLogger,
    resolvedSession?: ResolvedSession
  ): Promise<CompletionResult> {
    const resolved = resolvedSession ?? await this.resolveSession(input);

    const completionInput: DeepSeekCompletionInput = {
      ...input,
      chat_session_id: resolved.chat_session_id,
    };

    const sessionState: DeepSeekConversationState = {
      chat_session_id: resolved.chat_session_id,
      parent_message_id: resolved.parent_message_id,
    };

    return this.completeWithSessionUpdate(sessionState, completionInput, logger);
  }

    private async completeWithSessionUpdate(
    session: DeepSeekConversationState,
    input: DeepSeekCompletionInput,
    logger?: RequestLogger
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

    // Create PoW challenge with session ID for session-aware Referer
    const credentials = await this.getCredentials();
    const challenge = await createPowChallenge(credentials, this.origin, session.chat_session_id);

    // Solve PoW
    const solution = solvePow(challenge);

    // Encode PoW response
    const powHeader = encodePowResponse(solution);

    // Build completion headers with HIF-LEIM and session ID for Referer
    const headers = buildCompletionHeaders(credentials, powHeader, hifLeim, session.chat_session_id);

    // Log upstream request
    if (logger) {
      const initForLog = {
        method: "POST",
        headers: Object.fromEntries(headers.entries()),
        body: JSON.stringify(request),
      };
      logger.logUpstreamRequest(`${this.origin}${DEEPSEEK.ENDPOINTS.COMPLETION}`, initForLog);
    }

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

    if (!response.body) {
      throw new DeepSeekProtocolError(
        "DeepSeek completion returned no body",
        { kind: "completion", status: 502 }
      );
    }

    const { stream: instrumentedBody, sessionUpdatePromise: persistPromise } =
      this.attachSessionPersistence(response.body, logger);

    const outboundHeaders = new Headers(response.headers);
    outboundHeaders.set("X-Chat-Session-Id", session.chat_session_id);

    return {
      response: new Response(instrumentedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: outboundHeaders,
      }),
      sessionUpdatePromise: persistPromise,
    };
  }

  /**
       * Forwards SSE chunks to the caller without session persistence.
       * Session persistence is now handled in the Worker layer (index.ts) AFTER
       * response validation succeeds, so retries don't corrupt turn counting.
       */
  private attachSessionPersistence(
    body: ReadableStream<Uint8Array>,
    logger?: RequestLogger
  ): { stream: ReadableStream<Uint8Array>; sessionUpdatePromise: Promise<void> } {
    const sessionUpdatePromise = Promise.resolve();

        // Wrap with teeAndLogStream if logger is provided
        let finalStream = body;
        if (logger) {
          finalStream = teeAndLogStream(body, logger, "upstream_response");
        }

        return { stream: finalStream, sessionUpdatePromise };
      }

  async complete(input: DeepSeekCompletionInput, logger?: RequestLogger): Promise<CompletionResult> {
    // Delegate to completeWithAutoSession which handles session resolution and persistence
    return this.completeWithAutoSession(input, logger);
  }

  /**
     * Edit a message in an existing chat session using the native /api/v0/chat/edit_message endpoint.
     * 
     * Flow:
     * 1. Retrieve session state from sessionStore
     * 2. Fetch fresh PoW challenge (session-aware)
     * 3. POST /api/v0/chat/edit_message with messageId and edited prompt
     * 4. Parse response to extract request_message_id and response_message_id
     * 5. Return response plus parsed edit IDs for the caller/session layer
     */
    async editMessage(
      xSessionId: string,
      messageId: number,
      prompt: string,
      options?: EditMessageOptions,
      logger?: RequestLogger
    ): Promise<CompletionResult> {
      const existingState = await this.sessionStore.get(xSessionId);
      if (!existingState) {
        throw new DeepSeekProtocolError(
          "Session not found for edit_message",
          { kind: "edit_message", status: 404 }
        );
      }

      const credentials = await this.getCredentials();
      const chatSessionId = existingState.chat_session_id;

      const hifLeim = await this.hifLeimCache.getValue();
      const challenge = await createPowChallenge(credentials, this.origin, chatSessionId);
      const solution = solvePow(challenge);
      const powHeader = encodePowResponse(solution);
      const headers = buildCompletionHeaders(credentials, powHeader, hifLeim, chatSessionId);

      const response = await editMessage(
        headers,
        chatSessionId,
        messageId,
        prompt,
        this.origin,
        options ?? {}
      );

      const [stream1, stream2] = response.body!.tee();
      const idsPromise = this.parseEditMessageIds(stream1);
      const instrumentedBody = stream2;

      // Return response and IDs promise - caller handles session persistence
      let finalStream = instrumentedBody;
      if (logger) {
        finalStream = teeAndLogStream(instrumentedBody, logger, "upstream_response");
      }

      const outboundHeaders = new Headers(response.headers);
      outboundHeaders.set("X-Chat-Session-Id", chatSessionId);

      return {
        response: new Response(finalStream, {
          status: response.status,
          statusText: response.statusText,
          headers: outboundHeaders,
        }),
        sessionUpdatePromise: Promise.resolve(),
        editMessageIdsPromise: idsPromise,
      };
    }

  private async parseEditMessageIds(
    body: ReadableStream<Uint8Array>
  ): Promise<{ request_message_id: number; response_message_id: number }> {
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let result: { request_message_id: number; response_message_id: number } | null = null;
    const reader = body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
          if (!payload.startsWith("{")) continue;
          try {
            const data = JSON.parse(payload) as { request_message_id?: unknown; response_message_id?: unknown };
            const requestId = typeof data.request_message_id === "number" ? data.request_message_id : null;
            const responseId = typeof data.response_message_id === "number" ? data.response_message_id : null;
            if (requestId !== null && responseId !== null) {
              result = { request_message_id: requestId, response_message_id: responseId };
            }
          } catch { /* ignore */ }
        }
      }
      
      // Process remaining buffer after stream ends (final unterminated line)
      if (sseBuffer.trim()) {
        const trimmed = sseBuffer.trim();
        const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (payload.startsWith("{")) {
          try {
            const data = JSON.parse(payload) as { request_message_id?: unknown; response_message_id?: unknown };
            const requestId = typeof data.request_message_id === "number" ? data.request_message_id : null;
            const responseId = typeof data.response_message_id === "number" ? data.response_message_id : null;
            if (requestId !== null && responseId !== null) {
              result = { request_message_id: requestId, response_message_id: responseId };
            }
          } catch { /* ignore */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!result) {
      throw new DeepSeekProtocolError("DeepSeek edit_message returned no valid response", { kind: "edit_message", raw: "No response_message_id found" });
    }
    return result;
  }
}
