// DeepSeek Android Protocol Client
// Independent Android protocol profile implementing the CompletionClient
// contract used by the orchestrator.
//
// This client reproduces the captured Android 2.5.3 completion/session/PoW
// semantics. It is intentionally separate from DeepSeekWebClient and:
//   - never imports or calls HIF-LEIM
//   - never sends origin / referer / cookie / x-hif-leim
//   - uses Android headers, identity and completion body
//
// PoW uses the shared solvePow()/encodePowResponse() implementation.

import { DEEPSEEK } from "./constants.js";
import type {
  DeepSeekCredentials,
  DeepSeekSession,
  DeepSeekCompletionInput,
  DeepSeekConversationState,
  DeepSeekApiResponse,
  DeepSeekPowChallenge,
} from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";
import { solvePow, encodePowResponse } from "./pow.js";
import type { ProtocolStateStore } from "./state-store.js";
import type { ProtocolSessionStore, ProxySessionState } from "./session-store.js";
import type { RequestLogger } from "../observability/logger.js";
import { teeAndLogStream } from "../observability/logger.js";
import { createDefaultCredentialsReader, type CompletionResult } from "./client.js";
import { getAndroidIdentity, type AndroidDeviceIdentity } from "./android-identity.js";
import {
  buildAndroidApiHeaders,
  buildAndroidCompletionHeaders,
} from "./android-headers.js";
import { buildAndroidCompletionRequest } from "./android-completion.js";

/** Parse response_message_id from a single SSE line (ready event data payload). */
function extractResponseMessageId(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload.startsWith("{")) return null;
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

export interface DeepSeekAndroidClientConfig {
  stateStore: ProtocolStateStore;
  sessionStore: ProtocolSessionStore;
  origin?: string;
}

export class DeepSeekAndroidClient {
  private readonly stateStore: ProtocolStateStore;
  private readonly sessionStore: ProtocolSessionStore;
  private readonly getCredentials: () => Promise<DeepSeekCredentials>;
  private readonly origin: string;

  constructor(config: DeepSeekAndroidClientConfig) {
    this.stateStore = config.stateStore;
    this.sessionStore = config.sessionStore;
    this.origin = config.origin || DEEPSEEK.ORIGIN;
    const credentialsReader = createDefaultCredentialsReader(this.stateStore);
    this.getCredentials = () => credentialsReader.getCredentials();
  }

  private async getIdentity(): Promise<AndroidDeviceIdentity> {
    return getAndroidIdentity(this.stateStore);
  }

  /**
   * Android session creation: POST /api/v0/chat_session/create with an empty
   * JSON body and the Android header profile.
   */
  async createSession(): Promise<DeepSeekSession> {
    const credentials = await this.getCredentials();
    const identity = await this.getIdentity();
    const headers = buildAndroidApiHeaders(credentials, identity);

    const response = await fetch(`${this.origin}${DEEPSEEK.ENDPOINTS.CREATE_SESSION}`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new DeepSeekProtocolError(
        `DeepSeek Android session creation failed: HTTP ${response.status}`,
        { kind: "session", status: response.status }
      );
    }

    const data = (await response.json()) as DeepSeekApiResponse<{ chat_session: DeepSeekSession }>;
    const session = data?.data?.biz_data?.chat_session;
    if (!session?.id) {
      throw new DeepSeekProtocolError(
        "DeepSeek Android session creation returned invalid response",
        { kind: "session", raw: data }
      );
    }
    return session as DeepSeekSession;
  }

  /**
   * Android PoW challenge: POST /api/v0/chat/create_pow_challenge with the
   * Android header profile and {"target_path":"/api/v0/chat/completion"}.
   */
  private async createPowChallenge(): Promise<DeepSeekPowChallenge> {
    const credentials = await this.getCredentials();
    const identity = await this.getIdentity();
    const headers = buildAndroidApiHeaders(credentials, identity);

    const response = await fetch(`${this.origin}${DEEPSEEK.ENDPOINTS.CREATE_POW}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target_path: DEEPSEEK.ENDPOINTS.COMPLETION }),
    });

    if (!response.ok) {
      throw new DeepSeekProtocolError(
        `DeepSeek Android PoW challenge failed: HTTP ${response.status}`,
        { kind: "pow", status: response.status }
      );
    }

    const data = (await response.json()) as DeepSeekApiResponse<{ challenge: DeepSeekPowChallenge }>;
    const challenge = data?.data?.biz_data?.challenge;
    if (!challenge) {
      throw new DeepSeekProtocolError(
        "DeepSeek Android PoW challenge returned invalid response",
        { kind: "pow", raw: data }
      );
    }
    return challenge as DeepSeekPowChallenge;
  }

  /**
   * Complete with automatic session management (Android profile).
   * Session semantics (xSessionId, parent_message_id, turn_count) are
   * unchanged from the web client.
   */
  async completeWithAutoSession(
    input: DeepSeekCompletionInput,
    logger?: RequestLogger
  ): Promise<CompletionResult> {
    let resolvedParentMessageId: number | null = null;
    let resolvedChatSessionId: string;
    const xSessionId = input.xSessionId;
    let existingState: ProxySessionState | null = null;

    if (xSessionId) {
      existingState = await this.sessionStore.get(xSessionId);
    }

    if (existingState) {
      resolvedChatSessionId = existingState.chat_session_id;
      resolvedParentMessageId = existingState.parent_message_id;
    } else if (input.chat_session_id) {
      resolvedChatSessionId = input.chat_session_id;
      resolvedParentMessageId = null;
    } else {
      const newSession = await this.createSession();
      resolvedChatSessionId = newSession.id;
      resolvedParentMessageId = null;
    }

    const sessionState: DeepSeekConversationState = {
      chat_session_id: resolvedChatSessionId,
      parent_message_id: resolvedParentMessageId,
    };

    const { response, sessionUpdatePromise } = await this.completeWithSessionUpdate(
      sessionState,
      input.prompt,
      {
        model_type: input.model_type,
        thinking_enabled: input.thinking_enabled ?? false,
        search_enabled: input.search_enabled ?? false,
      },
      xSessionId,
      existingState,
      logger
    );

    return { response, sessionUpdatePromise };
  }

  private async completeWithSessionUpdate(
    session: DeepSeekConversationState,
    prompt: string,
    options: {
      model_type: DeepSeekConversationInputModel;
      thinking_enabled: boolean;
      search_enabled: boolean;
    },
    xSessionId: string | undefined,
    existingState: ProxySessionState | null,
    logger?: RequestLogger
  ): Promise<{ response: Response; sessionUpdatePromise: Promise<void> }> {
    const request = buildAndroidCompletionRequest(session, prompt, options);

    // Android flow: PoW challenge directly (no HIF-LEIM).
    const credentials = await this.getCredentials();
    const identity = await this.getIdentity();
    const challenge = await this.createPowChallenge();
    const solution = solvePow(challenge);
    const powHeader = encodePowResponse(solution);

    const headers = buildAndroidCompletionHeaders(credentials, identity, powHeader);

    if (logger) {
      logger.logUpstreamRequest(`${this.origin}${DEEPSEEK.ENDPOINTS.COMPLETION}`, {
        method: "POST",
        headers: Object.fromEntries(headers.entries()),
        body: JSON.stringify(request),
      });
    }

    const response = await fetch(`${this.origin}${DEEPSEEK.ENDPOINTS.COMPLETION}`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new DeepSeekProtocolError(
        `DeepSeek Android completion failed: HTTP ${response.status}`,
        { kind: "completion", status: response.status }
      );
    }

    if (!response.body) {
      throw new DeepSeekProtocolError(
        "DeepSeek Android completion returned no body",
        { kind: "completion", status: 502 }
      );
    }

    const { stream: instrumentedBody, sessionUpdatePromise: persistPromise } =
      this.attachSessionPersistence(response.body, session.chat_session_id, xSessionId, existingState, logger);

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
   * Forwards SSE chunks while buffering lines so a split `ready` event still
   * yields response_message_id. Persists it as parent_message_id for the next
   * turn using the existing session semantics.
   */
  private attachSessionPersistence(
    body: ReadableStream<Uint8Array>,
    chatSessionId: string,
    xSessionId: string | undefined,
    existingState: ProxySessionState | null,
    logger?: RequestLogger
  ): { stream: ReadableStream<Uint8Array>; sessionUpdatePromise: Promise<void> } {
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let persistPromise: Promise<void> | null = null;

    const persistParent = async (responseMessageId: number): Promise<void> => {
      try {
        if (xSessionId) {
          const newTurnCount = (existingState?.turn_count || 0) + 1;
          // Same turn semantics as the web client:
          // turns 1-2 keep the existing parent_message_id; from turn 3 on the
          // new response_message_id becomes the parent.
          const newParentId = (newTurnCount < 2) ? (existingState?.parent_message_id ?? null) : responseMessageId;

          await this.sessionStore.set(xSessionId, {
            x_session_id: xSessionId,
            chat_session_id: chatSessionId,
            parent_message_id: newParentId,
            turn_count: newTurnCount,
            created_at: existingState?.created_at || Date.now(),
            updated_at: Date.now(),
          });
        }
      } catch (error) {
        console.error("[DeepSeekAndroidClient] Failed to store session info:", error);
      }
    };

    const consumeLine = (line: string) => {
      if (persistPromise) return;
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

    let finalStream = stream;
    if (logger) {
      finalStream = teeAndLogStream(stream, logger, "upstream_response");
    }

    return { stream: finalStream, sessionUpdatePromise };
  }

  async complete(input: DeepSeekCompletionInput, logger?: RequestLogger): Promise<CompletionResult> {
    return this.completeWithAutoSession(input, logger);
  }
}

type DeepSeekConversationInputModel = DeepSeekCompletionInput["model_type"];
