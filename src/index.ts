import { CloudflareD1ProtocolSessionStore } from './adapters/cloudflare-d1-protocol-session-store.js'
import { CloudflareKVStateStore } from './adapters/cloudflare-kv-state-store.js'
import {
  DeepSeekProtocolError,
  DeepSeekWebClient,
  PROTOCOL_STATE_KEYS,
} from './deepseek_api/index.js'
import type { DeepSeekCompletionInput } from './deepseek_api/index.js'

const RATE_LIMIT_MS = 5000
let lastRequestTime = 0

async function rateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime

  if (lastRequestTime === 0) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS))
  } else if (elapsed < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed))
  }

  lastRequestTime = Date.now()
}

interface Env {
  AUTH_KV: KVNamespace
  DB: D1Database
}

interface AuthCookie {
  name: string
  value: string
}

interface AuthState {
  authorizationToken?: string
  cookies?: AuthCookie[]
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function createDeepSeekClient(env: Env): DeepSeekWebClient {
  const stateStore = new CloudflareKVStateStore(env.AUTH_KV)
  const sessionStore = new CloudflareD1ProtocolSessionStore(env.DB)
  return new DeepSeekWebClient({ stateStore, sessionStore })
}

function errorResponse(error: unknown): Response {
  const protocolError = error instanceof DeepSeekProtocolError
    ? error
    : new DeepSeekProtocolError(
        error instanceof Error ? error.message : 'Internal error',
        { kind: 'unknown' }
      )

  return json(
    { error: { message: protocolError.message, kind: protocolError.kind } },
    protocolError.status ?? 500,
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname

    if (pathname === '/auth') {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null)

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json({ error: { message: 'Invalid auth state: body must be an object' } }, 400)
        }

        const input = body as Record<string, unknown>

        if (input.authorizationToken !== undefined && typeof input.authorizationToken !== 'string') {
          return json({ error: { message: 'authorizationToken must be a string' } }, 400)
        }

        if (input.cookies !== undefined) {
          if (!Array.isArray(input.cookies)) {
            return json({ error: { message: 'cookies must be an array' } }, 400)
          }

          for (let i = 0; i < input.cookies.length; i++) {
            const cookie = input.cookies[i]
            if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
              return json({ error: { message: `cookie at index ${i} must be an object` } }, 400)
            }

            const value = cookie as Record<string, unknown>
            if (typeof value.name !== 'string' || typeof value.value !== 'string') {
              return json({ error: { message: `cookie at index ${i} must contain string name and value` } }, 400)
            }
          }
        }

        const auth: AuthState = {
          authorizationToken: input.authorizationToken as string | undefined,
          cookies: input.cookies as AuthCookie[] | undefined,
        }

        await env.AUTH_KV.put(PROTOCOL_STATE_KEYS.AUTH, JSON.stringify(auth))
        return json({ ok: true })
      }

      if (request.method === 'GET') {
        const authJson = await env.AUTH_KV.get(PROTOCOL_STATE_KEYS.AUTH)
        let state: AuthState | null = null

        if (authJson) {
          try {
            state = JSON.parse(authJson) as AuthState
          } catch {
            state = null
          }
        }

        return json({
          exists: !!state,
          state: state
            ? {
                authorizationToken: state.authorizationToken ? '[present]' : null,
                cookies_count: state.cookies?.length ?? 0,
              }
            : undefined,
        })
      }

      if (request.method === 'DELETE') {
        await env.AUTH_KV.delete(PROTOCOL_STATE_KEYS.AUTH)
        return json({ ok: true })
      }

      return json({ error: { message: 'Method not allowed' } }, 405)
    }

    if (pathname === '/health' && request.method === 'GET') {
      const authenticated = !!await env.AUTH_KV.get(PROTOCOL_STATE_KEYS.AUTH)
      return json({ ok: true, authenticated })
    }

    if (pathname === '/deepseekprotocol' && request.method === 'POST') {
      await rateLimit()

      try {
        const body = await request.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json({ error: { message: 'Invalid request: body must be an object' } }, 400)
        }

        const input = body as Record<string, unknown>
        const sessionValue = input.session
        let session: { chat_session_id: string } | undefined

        if (sessionValue !== undefined) {
          if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) {
            return json({ error: { message: 'Invalid request: session must be an object' } }, 400)
          }

          const chatSessionId = (sessionValue as Record<string, unknown>).chat_session_id
          if (typeof chatSessionId !== 'string' || !chatSessionId) {
            return json({ error: { message: 'Invalid request: session.chat_session_id is required' } }, 400)
          }

          session = { chat_session_id: chatSessionId }
        }

        const prompt = input.prompt
        if (typeof prompt !== 'string' || !prompt) {
          return json({ error: { message: 'Invalid request: prompt is required' } }, 400)
        }

        if (!('model_type' in input)) {
          return json({ error: { message: 'Invalid request: model_type is required' } }, 400)
        }

        const thinkingEnabled = input.thinking_enabled
        const searchEnabled = input.search_enabled

        if (typeof thinkingEnabled !== 'boolean' || typeof searchEnabled !== 'boolean') {
          return json({
            error: {
              message: 'Invalid request: thinking_enabled and search_enabled must be booleans',
            },
          }, 400)
        }

        const client = createDeepSeekClient(env)
        await client.initialize()

        return await client.completeProtocol({
          session,
          prompt,
          model_type: input.model_type as DeepSeekCompletionInput['model_type'],
          thinking_enabled: thinkingEnabled,
          search_enabled: searchEnabled,
        })
      } catch (error) {
        return errorResponse(error)
      }
    }

    return json({ error: { message: 'Not found' } }, 404)
  },
}
