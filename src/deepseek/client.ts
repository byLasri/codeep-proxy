import { DEEPSEEK } from "./constants.js";
import type {
  DeepSeekCredentials,
  DeepSeekSession,
  DeepSeekCompletionInput,
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

  async complete(input: DeepSeekCompletionInput): Promise<Response> {
    const { session, prompt, ...options } = input;

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