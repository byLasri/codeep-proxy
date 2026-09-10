import { DEEPSEEK } from "./constants.js";
import type {
  DeepSeekCredentials,
  DeepSeekConversationState,
  DeepSeekSession,
  DeepSeekCompletionInput,
  DeepSeekCompletionResult,
  DeepSeekApiResponse,
} from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";
import { createSession } from "./session.js";
import { createPowChallenge } from "./pow-challenge.js";
import { solvePow, encodePowResponse } from "./pow.js";
import { buildCompletionRequest } from "./completion.js";
import { buildCompletionHeaders } from "./headers.js";
import { parseCompletionStream } from "./sse.js";

export type CredentialsProvider = () => Promise<DeepSeekCredentials>;

export interface DeepSeekWebClientConfig {
  credentials: DeepSeekCredentials | CredentialsProvider;
  origin?: string;
}

export class DeepSeekWebClient {
  private readonly credentialsProvider: CredentialsProvider;
  private readonly origin: string;

  constructor(config: DeepSeekWebClientConfig) {
    this.credentialsProvider = (async () => {
      if (typeof config.credentials === "function") {
        return config.credentials();
      }
      return config.credentials;
    }) as CredentialsProvider;
    this.origin = config.origin || DEEPSEEK.ORIGIN;
  }

  private async getCredentials(): Promise<DeepSeekCredentials> {
    return this.credentialsProvider();
  }

  async createSession(): Promise<DeepSeekSession> {
    const credentials = await this.getCredentials();
    return createSession(credentials, this.origin);
  }

  async complete(input: DeepSeekCompletionInput): Promise<DeepSeekCompletionResult> {
    const { session, prompt, ...options } = input;

    // Build the DeepSeek completion request
    const request = buildCompletionRequest(session, prompt, options);

    // Create PoW challenge
    const credentials = await this.getCredentials();
    const challenge = await createPowChallenge(credentials, this.origin);

    // Solve PoW
    const solution = solvePow(challenge);

    // Encode PoW response
    const powHeader = encodePowResponse(solution);

    // Build completion headers
    const headers = buildCompletionHeaders(credentials, powHeader);

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

    // Parse SSE stream
    const result = await parseCompletionStream(response);

    if (result.response_message_id === null) {
      throw new DeepSeekProtocolError(
        "DeepSeek completion did not provide response_message_id",
        { kind: "protocol" }
      );
    }

    return result;
  }

  private async buildBaseHeaders(): Promise<Record<string, string>> {
    const credentials = await this.getCredentials();
    const headers: Record<string, string> = {
      "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
      "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
      "x-client-version": DEEPSEEK.CLIENT.VERSION,
      "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
      "x-client-timezone-offset": "3600",
      "content-type": "application/json",
    };

    if (credentials.authorization) {
      headers["authorization"] = credentials.authorization;
    }

    if (credentials.cookie) {
      headers["cookie"] = credentials.cookie;
    }

    return headers;
  }

  // Convenience method: create session and complete in one call
    async startConversation(input: Omit<DeepSeekCompletionInput, "session">): Promise<{
      session: DeepSeekSession;
      result: DeepSeekCompletionResult;
      state: DeepSeekConversationState;
    }> {
      const session = await this.createSession();
      const state: DeepSeekConversationState = {
        chat_session_id: session.id,
        parent_message_id: null,
        model_type: input.model_type,
        thinking_enabled: input.thinking_enabled,
        search_enabled: input.search_enabled,
        created_at: Date.now(),
      };

      const result = await this.complete({ session: state, ...input });

      const nextState: DeepSeekConversationState = {
        ...state,
        parent_message_id: result.response_message_id,
        updated_at: Date.now(),
      };

      return { session, result, state: nextState };
    }

    // Convenience method for continuing a conversation
    async continueConversation(
      state: DeepSeekConversationState,
      prompt: string,
      options: Omit<DeepSeekCompletionInput, "session" | "prompt">
    ): Promise<{ result: DeepSeekCompletionResult; state: DeepSeekConversationState }> {
      const result = await this.complete({
        session: state,
        prompt,
        ...options,
      });

      const nextState: DeepSeekConversationState = {
        ...state,
        parent_message_id: result.response_message_id,
        model_type: options.model_type ?? state.model_type,
        thinking_enabled: options.thinking_enabled ?? state.thinking_enabled,
        search_enabled: options.search_enabled ?? state.search_enabled,
        updated_at: Date.now(),
      };

      return { result, state: nextState };
    }
}

export function createConversationState(session: DeepSeekSession): DeepSeekConversationState {
  return {
    chat_session_id: session.id,
    parent_message_id: null,
    created_at: Date.now(),
  };
}