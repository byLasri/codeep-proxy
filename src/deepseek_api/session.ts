// DeepSeek Web Protocol Session
// Session creation and management

import { DEEPSEEK } from "./constants.js";
import type { DeepSeekSession, DeepSeekCredentials, DeepSeekApiResponse } from "./types.js";
import { buildAuthenticationHeaders } from "./headers.js";
import { DeepSeekProtocolError } from "./errors.js";

export async function createSession(credentials: DeepSeekCredentials, origin?: string): Promise<DeepSeekSession> {
  const baseOrigin = origin || DEEPSEEK.ORIGIN;
  const headers = buildAuthenticationHeaders(credentials);

  const response = await fetch(`${baseOrigin}${DEEPSEEK.ENDPOINTS.CREATE_SESSION}`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new DeepSeekProtocolError(
      `DeepSeek session creation failed: HTTP ${response.status}`,
      { kind: "session", status: response.status }
    );
  }

  const data = (await response.json()) as DeepSeekApiResponse<{ chat_session: DeepSeekSession }>;

  // The DeepSeek API wraps session in data.biz_data.chat_session
  const session = data?.data?.biz_data?.chat_session;
  if (!session?.id) {
    throw new DeepSeekProtocolError(
      "DeepSeek session creation returned invalid response",
      { kind: "session", raw: data }
    );
  }

  return session as DeepSeekSession;
}