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
      } catch {
        throw new DeepSeekProtocolError(
          "Invalid credentials format in state store",
          { kind: "credentials", status: 401 }
        );
      }

      if (typeof stored !== "object" || stored === null) {
        throw new DeepSeekProtocolError(
          "Credentials must be an object",
          { kind: "credentials", status: 401 }
        );
      }

      const obj = stored as Record<string, unknown>;
      let authorizationToken: string | undefined;
      if (obj.authorizationToken !== undefined) {
        if (typeof obj.authorizationToken !== "string") {
          throw new DeepSeekProtocolError(
            "authorizationToken must be a string",
            { kind: "credentials", status: 401 }
          );
        }
        authorizationToken = obj.authorizationToken;
      }

      let cookies: Array<{ name: string; value: string }> | undefined;
      if (obj.cookies !== undefined) {
        if (!Array.isArray(obj.cookies)) {
          throw new DeepSeekProtocolError(
            "cookies must be an array",
            { kind: "credentials", status: 401 }
          );
        }

        cookies = obj.cookies.map((cookie: unknown, index: number) => {
          if (typeof cookie !== "object" || cookie === null) {
            throw new DeepSeekProtocolError(
              `Cookie at index ${index} must be an object`,
              { kind: "credentials", status: 401 }
            );
          }

          const c = cookie as Record<string, unknown>;
          if (typeof c.name !== "string") {
            throw new DeepSeekProtocolError(
              `Cookie at index ${index} missing name`,
              { kind: "credentials", status: 401 }
            );
          }
          if (typeof c.value !== "string") {
            throw new DeepSeekProtocolError(
              `Cookie at index ${index} missing value`,
              { kind: "credentials", status: 401 }
            );
          }

          return { name: c.name, value: c.value };
        });
      }

      return {
        authorization: authorizationToken,
        cookie: cookies?.map(c => `${c.name}=${c.value}`).join('; ') || undefined,
      };
    },
  };
}

export interface DeepSeekWebClientConfig {
  stateStore: ProtocolStateStore;
  sessionStore: ProtocolSessionStore;
  origin?: string;
}

export interface DeepSeekProtocolRequest {
  session?: Pick<DeepSeekConversationState, "chat_session_id">;
  prompt: string;
  model_type: DeepSeekCompletionInput["model_type"];
  thinking_enabled: boolean;
  search_enabled: boolean;
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
    this.hifLeimCache = new HifLeimCache(this.stateStore);
    this.getCredentials = createDefaultCredentialsReader(this.stateStore).getCredentials;
  }

  async initialize(): Promise<void> {
    await this.sessionStore.initialize();
  }

  async createSession(): Promise<DeepSeekSession> {
    const credentials = await this.getCredentials();
    const session = await createSession(credentials, this.origin);
    await this.sessionStore.create(session.id);
    return session;
  }

  async completeProtocol(input: DeepSeekProtocolRequest): Promise<Response> {
    if (!input.prompt || typeof input.prompt !== "string") {
      throw new DeepSeekProtocolError(
        "Prompt is required",
        { kind: "protocol", status: 400 }
      );
    }

    if (input.model_type === undefined) {
      throw new DeepSeekProtocolError(
        "model_type is required",
        { kind: "protocol", status: 400 }
      );
    }

    let state: DeepSeekConversationState;

    if (!input.session?.chat_session_id) {
      const session = await this.createSession();
      state = {
        chat_session_id: session.id,
        parent_message_id: null,
      };
    } else {
      const stored = await this.sessionStore.get(input.session.chat_session_id);
      if (!stored) {
        throw new DeepSeekProtocolError(
          "Session not found in store",
          { kind: "protocol", status: 404 }
        );
      }
      state = {
        chat_session_id: stored.chat_session_id,
        parent_message_id: stored.parent_message_id,
      };
    }

    const request = buildCompletionRequest(state, input.prompt, {
      model_type: input.model_type,
      thinking_enabled: input.thinking_enabled,
      search_enabled: input.search_enabled,
    });

    const response = await this.sendCompletion(request);
    if (!response.body) {
      throw new DeepSeekProtocolError(
        "DeepSeek completion returned no body",
        { kind: "completion", status: 502 }
      );
    }

    const trackedBody = this.trackResponseMessageId(response.body, state.chat_session_id);
    return new Response(trackedBody, { status: response.status, headers: response.headers });
  }

  private async sendCompletion(request: ReturnType<typeof buildCompletionRequest>): Promise<Response> {
    const hifLeim = await this.hifLeimCache.getValue();
    const credentials = await this.getCredentials();
    const challenge = await createPowChallenge(credentials, this.origin);
    const solution = solvePow(challenge);
    const powHeader = encodePowResponse(solution);
    const headers = buildCompletionHeaders(credentials, powHeader, hifLeim);

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

    return response;
  }

  private trackResponseMessageId(
    body: ReadableStream<Uint8Array>,
    chatSessionId: string
  ): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent: string | null = null;
    let persisted = false;

    const parseLine = async (line: string): Promise<void> => {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        return;
      }

      if (!line.startsWith("data:")) return;

      const dataText = line.slice(5).trim();
      if (!dataText || persisted) return;

      let data: unknown;
      try {
        data = JSON.parse(dataText);
      } catch {
        return;
      }

      if (
        currentEvent === "ready" &&
        typeof data === "object" &&
        data !== null &&
        "response_message_id" in data &&
        "request_message_id" in data
      ) {
        const responseMessageId = (data as { response_message_id?: unknown }).response_message_id;
        if (typeof responseMessageId === "number" && Number.isInteger(responseMessageId)) {
          persisted = true;
          await this.sessionStore.advance(chatSessionId, responseMessageId);
        }
      }
    };

    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: async (chunk, controller) => {
          controller.enqueue(chunk);
          buffer += decoder.decode(chunk, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            await parseLine(line.replace(/\r$/, ""));
          }
        },
        flush: async () => {
          buffer += decoder.decode();
          if (buffer) {
            await parseLine(buffer.replace(/\r$/, ""));
          }
        },
      })
    );
  }
}
