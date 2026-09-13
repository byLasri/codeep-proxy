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

/** Parse response_message_id from a single SSE line (ready event data payload). */
function extractResponseMessageId(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload.startsWith("{")) {
    return null;
  }
  try {
    const data = JSON.parse(payload) as { response_message_id?: unknown };
    if (typeof data.response_message_id === "number") {
      return data.response_message_id;
    }
  } catch {
    // Incomplete or non-JSON line
  }
  return null;
}

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
      // D1 stores first-turn null as 0 (INTEGER NOT NULL). Wire protocol uses null.
      const storedParent = existingSession.parent_message_id ?? null;
      resolvedParentMessageId = storedParent === 0 ? null : storedParent;
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
      completionInput
    );

    return { response, sessionUpdatePromise };
  }

  /**
   * Sends completion request and updates session in KV on success.
   * Parses the SSE stream to extract the new response_message_id.
   */
  private async completeWithSessionUpdate(
    session: DeepSeekConversationState,
    input: DeepSeekCompletionInput
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

    if (!response.body) {
      throw new DeepSeekProtocolError(
        "DeepSeek completion returned no body",
        { kind: "completion", status: 502 }
      );
    }

    const { stream: instrumentedBody, sessionUpdatePromise: persistPromise } =
      this.attachSessionPersistence(response.body, session.chat_session_id);

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
   * Forwards SSE chunks to the caller while buffering lines so a split
   * `ready` event still yields response_message_id. Upserts that id as
   * parent_message_id for the next turn as soon as it is seen.
   */
  private attachSessionPersistence(
    body: ReadableStream<Uint8Array>,
    chatSessionId: string
  ): { stream: ReadableStream<Uint8Array>; sessionUpdatePromise: Promise<void> } {
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let persistPromise: Promise<void> | null = null;

    const persistParent = async (responseMessageId: number): Promise<void> => {
      try {
        const existingSession = await this.sessionStore.get(chatSessionId);
        await this.sessionStore.set(chatSessionId, {
          chat_session_id: chatSessionId,
          parent_message_id: responseMessageId,
          created_at: existingSession?.created_at ?? Date.now(),
          updated_at: Date.now(),
        });
        console.log(
          "[DeepSeekWebClient] Stored session",
          chatSessionId,
          "parent_message_id:",
          responseMessageId
        );
      } catch (error) {
        console.error("[DeepSeekWebClient] Failed to store session info:", error);
      }
    };

    const consumeLine = (line: string) => {
      if (persistPromise) {
        return;
      }
      const id = extractResponseMessageId(line);
      if (id !== null) {
        persistPromise = persistParent(id).finally(() => resolveUpdate());
      }
    };

    let resolveUpdate: () => void;
    const sessionUpdatePromise = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });

    const finish = async () => {
      consumeLine(sseBuffer);
      sseBuffer = "";
      if (persistPromise) {
        await persistPromise;
      } else {
        console.log(
          "[DeepSeekWebClient] No response_message_id found for session",
          chatSessionId
        );
      }
      resolveUpdate();
    };

    const stream = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          sseBuffer += decoder.decode(chunk, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";
          for (const line of lines) {
            consumeLine(line);
          }
        },
        async flush() {
          await finish();
        },
      })
    );

    return { stream, sessionUpdatePromise };
  }

  async complete(input: DeepSeekCompletionInput): Promise<CompletionResult> {
    // Delegate to completeWithAutoSession which handles session resolution and persistence
    return this.completeWithAutoSession(input);
  }
}