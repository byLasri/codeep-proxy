// DeepSeek credentials provider using existing AUTH_KV
// Add this to your index.ts or create a separate adapter

import { DeepSeekWebClient, type CredentialsProvider } from "./deepseek/index.js";

export interface DeepSeekAuthCookie {
  name: string;
  value: string;
}

export interface DeepSeekAuthState {
  authorizationToken?: string;
  cookies?: DeepSeekAuthCookie[];
}

const AUTH_KEY = "deepseek-auth";

export interface DeepSeekAdapterEnv {
  DEEPSEEK_ORIGIN?: string;
  DEEPSEEK_AUTHORIZATION?: string;
  DEEPSEEK_COOKIE?: string;
  AUTH_KV: KVNamespace;
}

export function createCredentialsProvider(env: DeepSeekAdapterEnv): CredentialsProvider {
  return async () => {
    const state = await env.AUTH_KV.get(AUTH_KEY, "json") as DeepSeekAuthState | null;
    return {
      authorization: state?.authorizationToken || env.DEEPSEEK_AUTHORIZATION,
      cookie: state?.cookies
        ?.map((c: DeepSeekAuthCookie) => `${c.name}=${c.value}`)
        .join("; ") || env.DEEPSEEK_COOKIE,
    };
  };
}

// Usage in your fetch handler:
export default {
  async fetch(request: Request, env: DeepSeekAdapterEnv): Promise<Response> {
    const client = new DeepSeekWebClient({
      credentials: createCredentialsProvider(env),
      origin: env.DEEPSEEK_ORIGIN,
    });

    // Now use client.createSession(), client.complete(), etc.
    // ...
    return new Response("OK");
  },
};
