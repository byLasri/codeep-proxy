// DeepSeek credentials provider using existing AUTH_KV
// Add this to your index.ts or create a separate adapter

import { DeepSeekWebClient, type CredentialsProvider } from "./deepseek/index.js";

interface AuthCookie {
  name: string;
  value: string;
}

interface AuthState {
  authorizationToken?: string;
  cookies?: AuthCookie[];
}

const AUTH_KEY = "deepseek-auth";

interface Env {
  DEEPSEEK_ORIGIN?: string;
  DEEPSEEK_AUTHORIZATION?: string;
  DEEPSEEK_COOKIE?: string;
  AUTH_KV: KVNamespace;
}

function createCredentialsProvider(env: Env): CredentialsProvider {
  return async () => {
    const state = await env.AUTH_KV.get(AUTH_KEY, "json") as AuthState | null;
    return {
      authorization: state?.authorizationToken || env.DEEPSEEK_AUTHORIZATION,
      cookie: state?.cookies
        ?.map((c: AuthCookie) => `${c.name}=${c.value}`)
        .join("; ") || env.DEEPSEEK_COOKIE,
    };
  };
}

// Usage in your fetch handler:
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new DeepSeekWebClient({
      credentials: createCredentialsProvider(env),
      origin: env.DEEPSEEK_ORIGIN,
    });

    // Now use client.createSession(), client.complete(), etc.
    // ...
    return new Response("OK");
  },
};