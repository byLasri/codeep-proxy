// DeepSeek Web Protocol Constants
// Protocol-level constants only — no application logic

export const DEEPSEEK = {
  ORIGIN: "https://chat.deepseek.com",

  ENDPOINTS: {
    CREATE_SESSION: "/api/v0/chat_session/create",
    CREATE_POW: "/api/v0/chat/create_pow_challenge",
    COMPLETION: "/api/v0/chat/completion",
    EDIT_MESSAGE: "/api/v0/chat/edit_message",
  },

  CLIENT: {
    BUNDLE_ID: "com.deepseek.chat",
    PLATFORM: "web",
    VERSION: "2.5.0",
    LOCALE: "en_US",
  },

  POW: {
    ALGORITHM: "DeepSeekHashV1",
  },

  HIF: {
    LEIM_ORIGIN: "https://hif-leim.deepseek.com",
    LEIM_ENDPOINT: "/query",
    TTL_SECONDS: 600,
  },
} as const;

/**
 * Get timezone offset in seconds (matching browser behavior).
 * Returns the offset from UTC in seconds, positive for timezones west of UTC.
 * This matches the browser's x-client-timezone-offset header format.
 */
export function getClientTimezoneOffset(): string {
  // new Date().getTimezoneOffset() returns minutes, negative for timezones west of UTC
  // We need to convert to seconds and invert sign to match browser convention
  return (new Date().getTimezoneOffset() * -60).toString();
}