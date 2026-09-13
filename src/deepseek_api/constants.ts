// DeepSeek Web Protocol Constants
// Protocol-level constants only — no application logic

export const DEEPSEEK = {
  ORIGIN: "https://chat.deepseek.com",

  ENDPOINTS: {
    CREATE_SESSION: "/api/v0/chat_session/create",
    CREATE_POW: "/api/v0/chat/create_pow_challenge",
    COMPLETION: "/api/v0/chat/completion",
  },

  CLIENT: {
    BUNDLE_ID: "com.deepseek.chat",
    PLATFORM: "web",
    VERSION: "2.4.0",
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

export const DEFAULT_TIMEZONE_OFFSET = "3600";