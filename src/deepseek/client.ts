import { DEEPSEEK } from "./constants.js";
import type {
  DeepSeekCredentials,
  DeepSeekConversationState,
  DeepSeekSession,
  DeepSeekCompletionInput,
  DeepSeekApiResponse,
} from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";
import { createSession } from "./session.js";
import { createPowChallenge } from "./pow-challenge.js";
import { solvePow, encodePowResponse } from "./pow.js";
import { buildCompletionRequest } from "./completion.js";
import { buildCompletionHeaders } from "./headers.js";
import { HifLeimCache } from "./hif-leim.js";
import { StateManager } from "./state-manager.js";

export type CredentialsProvider = () => Promise<DeepSeekCredentials>;

export interface DeepSeekWebClientConfig {
  credentials: DeepSeekCredentials | CredentialsProvider;
  origin?: string;
  kv?: KVNamespace;
}

export class DeepSeekWebClient {
  private readonly credentialsProvider: CredentialsProvider;
  private readonly origin: string;
  private readonly stateManager: StateManager | null;
  private readonly hifLeimCache: HifLeimCache | null;

  constructor(config: DeepSeekWebClientConfig) {
    this.credentialsProvider = (async () => {
      if (typeof config.credentials === "function") {
        return config.credentials();
      }
      return config.credentials;
    }) as CredentialsProvider;
    this.origin = config.origin || DEEPSEEK.ORIGIN;
    
    // Initialize KV-based state management if KV namespace provided
    if (config.kv) {
      this.stateManager = new StateManager(config.kv);
      this.hifLeimCache = new HifLeimCache(this.stateManager);
    } else {
      this.stateManager = null;
      this.hifLeimCache = null;
    }
  }

  private async getCredentials(): Promise<DeepSeekCredentials> {
    // If using KV, fetch credentials from there
    if (this.stateManager) {
      const stored = await this.stateManager.getCredentials();
      if (stored.token && stored.cookies) {
        return {
          authorization: stored.token,
          cookie: stored.cookies.map(c => `${c.name}=${c.value}`).join('; '),
        };
      }
    }
    return this.credentialsProvider();
  }

  async createSession(): Promise<DeepSeekSession> {
    const credentials = await this.getCredentials();
    return createSession(credentials, this.origin);
  }

  async complete(input: DeepSeekCompletionInput): Promise<Response> {
    const { session, prompt, ...options } = input;

    // Build the DeepSeek completion request
    const request = buildCompletionRequest(session, prompt, options);

    // Fetch HIF-LEIM value (cached with automatic refresh)
    let hifLeim: string;
    if (this.hifLeimCache) {
      hifLeim = await this.hifLeimCache.getValue();
    } else {
      // Fallback to old in-memory/cache API based approach
      const { HifLeimCache: LegacyHifLeimCache } = await import("./hif-leim.js");
      // Create a temporary instance with a null state manager for backward compatibility
      // This should only be used during migration - prefer using KV
      throw new Error("KV namespace required for HIF-LEIM caching. Please provide 'kv' in client config.");
    }

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
    response: Response;
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

    const response = await this.complete({ session: state, ...input });

    // Note: caller must parse response to get response_message_id for next state
    const nextState: DeepSeekConversationState = {
      ...state,
      parent_message_id: null, // Will be updated by caller after parsing
      updated_at: Date.now(),
    };

    return { session, response, state: nextState };
  }

  // Convenience method for continuing a conversation
  async continueConversation(
    state: DeepSeekConversationState,
    prompt: string,
    options: Omit<DeepSeekCompletionInput, "session" | "prompt">
  ): Promise<{ response: Response; state: DeepSeekConversationState }> {
    const response = await this.complete({
      session: state,
      prompt,
      ...options,
    });

    const nextState: DeepSeekConversationState = {
      ...state,
      parent_message_id: null, // Will be updated by caller after parsing
      model_type: options.model_type ?? state.model_type,
      thinking_enabled: options.thinking_enabled ?? state.thinking_enabled,
      search_enabled: options.search_enabled ?? state.search_enabled,
      updated_at: Date.now(),
    };

    return { response, state: nextState };
  }
}

export function createConversationState(session: DeepSeekSession): DeepSeekConversationState {
  return {
    chat_session_id: session.id,
    parent_message_id: null,
    created_at: Date.now(),
  };
}