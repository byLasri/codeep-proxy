// DeepSeek Web Protocol Session
// Session creation and management
// CRITICAL: DeepSeek uses TWO distinct session identifiers:
// 1. Conversation ID: Client-generated UUID used in /api/v0/chat/completion requests
//    and URL routing (/a/chat/s/<id>). Created BEFORE /chat_session/create call.
// 2. Server Session ID: Returned by POST /api/v0/chat_session/create endpoint.
//    Used for server-side session management, NOT sent in completion requests.
// HAR evidence proves these are DIFFERENT IDs with different lifecycles.

import { DEEPSEEK } from "./constants.js";
import type { DeepSeekCredentials, DeepSeekApiResponse } from "./types.js";
import { buildAuthenticationHeaders } from "./headers.js";
import { DeepSeekProtocolError } from "./errors.js";

export interface DeepSeekSessionCreationResult {
  /** Conversation ID - client-generated, used in completion requests */
  conversationId: string;
  /** Server session ID - returned from API, may be null if create fails */
  serverSessionId: string | null;
  /** Full server session object if available */
  serverSession: unknown | null;
}

/**
 * Creates a new DeepSeek session following the two-ID protocol.
 * 
 * Protocol flow:
 * 1. Generate conversation ID client-side (UUID v4)
 * 2. Call /api/v0/chat_session/create to create server session
 * 3. Server returns different serverSessionId
 * 4. Use conversationId (NOT serverSessionId) in completion requests
 * 
 * @returns DeepSeekSessionCreationResult with both IDs
 */
export async function createSession(credentials: DeepSeekCredentials, origin?: string): Promise<DeepSeekSessionCreationResult> {
  // Step 1: Generate conversation ID client-side BEFORE any API call
  // This matches DeepSeek frontend's preCreateSession mechanism
  const conversationId = crypto.randomUUID();
  
  const baseOrigin = origin || DEEPSEEK.ORIGIN;
  const headers = buildAuthenticationHeaders(credentials);

  // Step 2: Create server session (separate from conversation ID)
  let serverSessionId: string | null = null;
  let serverSession: unknown | null = null;
  
  try {
    const response = await fetch(`${baseOrigin}${DEEPSEEK.ENDPOINTS.CREATE_SESSION}`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (response.ok) {
      const data = (await response.json()) as DeepSeekApiResponse<{ chat_session: { id: string; [key: string]: unknown } }>;
      
      // Extract server session ID from nested response structure
      const session = data?.data?.biz_data?.chat_session;
      if (session?.id) {
        serverSessionId = session.id;
        serverSession = session;
      }
    }
    // If session creation fails, we still return the conversationId
    // The completion can proceed with just the conversation ID
  } catch (error) {
    // Log but don't throw - conversation ID is still valid
    console.warn("[createSession] Server session creation failed, proceeding with conversation ID only:", error);
  }

  return {
    conversationId,
    serverSessionId,
    serverSession,
  };
}