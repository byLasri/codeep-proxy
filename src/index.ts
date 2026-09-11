import { DeepSeekWebClient } from './deepseek/client.js'
import type { DeepSeekCredentials } from './deepseek/types.js'

const AUTH_KEY = 'deepseek-auth'

interface Env {
  DEEPSEEK_ORIGIN?: string
  DEEPSEEK_AUTHORIZATION?: string
  DEEPSEEK_COOKIE?: string
  AUTH_KV: KVNamespace
  CAPTURE_LOG?: string
  DEBUG_BUCKET?: R2Bucket
}

interface AuthCookie {
  name: string
  value: string
}

interface AuthState {
  authorizationToken?: string
  cookies?: AuthCookie[]
}

async function loadAuthState(env: Env): Promise<AuthState | null> {
  return await env.AUTH_KV.get(AUTH_KEY, 'json') as AuthState | null
}

function buildCookieString(cookies: AuthCookie[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function authStateToCredentials(state: AuthState): DeepSeekCredentials {
  const credentials: DeepSeekCredentials = {}
  if (state.authorizationToken) {
    credentials.authorization = state.authorizationToken
  }
  if (state.cookies && state.cookies.length > 0) {
    credentials.cookie = buildCookieString(state.cookies)
  }
  return credentials
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname

    if (pathname === '/v1/auth') {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null) as AuthState | null
        if (!body || !Array.isArray(body.cookies)) return json({ error: { message: 'Invalid auth state' } }, 400)
        await env.AUTH_KV.put(AUTH_KEY, JSON.stringify(body))
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (request.method === 'GET') {
        const state = await loadAuthState(env)
        const payload: any = { exists: !!state }
        if (state) {
          payload.state = {
            authorizationToken: state.authorizationToken ? '[present]' : null,
            cookies_count: state.cookies?.length || 0,
          }
        }
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (request.method === 'DELETE') {
        await env.AUTH_KV.delete(AUTH_KEY)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }

    if (request.method === 'GET' && pathname === '/health') {
      return json({ ok: true, authenticated: !!(await loadAuthState(env)) })
    }

    if (pathname === '/completions' && request.method === 'POST') {
      try {
        const authState = await loadAuthState(env)
        if (!authState) {
          return json({ error: { message: 'Not authenticated. Please set credentials via /v1/auth first.' } }, 401)
        }

        const body = await request.json().catch(() => null) as {
          prompt: string
          model_type?: string
          thinking_enabled?: boolean
          search_enabled?: boolean
        } | null

        if (!body?.prompt) {
          return json({ error: { message: 'Missing required field: prompt' } }, 400)
        }

        const credentials = authStateToCredentials(authState)
        const origin = env.DEEPSEEK_ORIGIN || 'https://chat.deepseek.com'

        const client = new DeepSeekWebClient({
          credentials,
          origin,
        })

        const session = await client.createSession()

        const response = await client.complete({
          session: {
            chat_session_id: session.id,
            parent_message_id: null,
            model_type: body.model_type ?? 'default',
            thinking_enabled: body.thinking_enabled ?? false,
            search_enabled: body.search_enabled ?? false,
          },
          prompt: body.prompt,
          model_type: body.model_type ?? 'default',
          thinking_enabled: body.thinking_enabled ?? false,
          search_enabled: body.search_enabled ?? false,
        })

        // Return SSE stream directly
        return new Response(response.body, {
          status: response.status,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          },
        })
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        return json({ error: { message: errorMessage } }, 500)
      }
    }

    return json({ error: { message: 'Not found' } }, 404)
  },
}