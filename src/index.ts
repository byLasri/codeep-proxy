import { PROTOCOL_STATE_KEYS } from './deepseek/index.js'
import { CompletionSessionDO } from './completions-session-do.js'

interface Env {
  AUTH_KV: KVNamespace
  COMPLETION_SESSIONS: DurableObjectNamespace
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
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname

    // Route /v1/chat/completions to Durable Object for conversation management
    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
      // Get session ID from headers (OpenCode uses X-Session-Id or x-session-affinity)
      const sessionId = request.headers.get('X-Session-Id') ?? request.headers.get('x-session-affinity')
      
      if (!sessionId) {
        return json({ error: { message: 'OpenCode session ID is missing (expected X-Session-Id or x-session-affinity)' } }, 400)
      }
      
      // Get or create Durable Object for this session
      const id = env.COMPLETION_SESSIONS.idFromName(sessionId)
      const stub = env.COMPLETION_SESSIONS.get(id)
      
      // Normalize path to internal DO API (/completions) while preserving method, headers, and body
      const url = new URL(request.url)
      const internalUrl = `${url.origin}/completions${url.search}`
      const normalizedRequest = new Request(internalUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
      
      return stub.fetch(normalizedRequest)
    }

    // POST /v1/auth - Store credentials
    if (pathname === '/v1/auth' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      
      // Validate body is a non-null object (not array)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ error: { message: 'Invalid auth state: body must be a non-null object' } }, 400)
      }
      
      // Validate authorizationToken if present
      if ('authorizationToken' in body && body.authorizationToken !== undefined) {
        if (typeof body.authorizationToken !== 'string') {
          return json({ error: { message: 'Invalid auth state: authorizationToken must be a string' } }, 400)
        }
      }
      
      // Validate cookies if present
      if ('cookies' in body && body.cookies !== undefined) {
        if (!Array.isArray(body.cookies)) {
          return json({ error: { message: 'Invalid auth state: cookies must be an array' } }, 400)
        }
        
        for (let i = 0; i < body.cookies.length; i++) {
          const cookie = body.cookies[i]
          if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
            return json({ error: { message: `Invalid auth state: cookie at index ${i} must be an object` } }, 400)
          }
          if (typeof cookie.name !== 'string') {
            return json({ error: { message: `Invalid auth state: cookie at index ${i} has invalid name` } }, 400)
          }
          if (typeof cookie.value !== 'string') {
            return json({ error: { message: `Invalid auth state: cookie at index ${i} has invalid value` } }, 400)
          }
        }
      }
      
      const validatedBody: AuthState = {
        authorizationToken: (body as AuthState).authorizationToken,
        cookies: (body as AuthState).cookies,
      }
      
      // Store credentials in the canonical format
      await env.AUTH_KV.put(PROTOCOL_STATE_KEYS.AUTH, JSON.stringify(validatedBody))
      
      return json({ ok: true })
    }

    // GET /v1/auth - Return sanitized status
    if (pathname === '/v1/auth' && request.method === 'GET') {
      const authJson = await env.AUTH_KV.get(PROTOCOL_STATE_KEYS.AUTH)
      let state: AuthState | null = null
      
      if (authJson) {
        try {
          state = JSON.parse(authJson) as AuthState
        } catch {
          // Invalid JSON treated as no credentials
        }
      }
      
      const payload: any = { exists: !!state }
      if (state) {
        payload.state = {
          authorizationToken: state.authorizationToken ? '[present]' : null,
          cookies_count: state.cookies?.length || 0,
        }
      }
      return json(payload)
    }

    // DELETE /v1/auth - Clear credentials
    if (pathname === '/v1/auth' && request.method === 'DELETE') {
      await env.AUTH_KV.delete(PROTOCOL_STATE_KEYS.AUTH)
      return json({ ok: true })
    }

    // GET /health - Health check
    if (request.method === 'GET' && pathname === '/health') {
      const authJson = await env.AUTH_KV.get(PROTOCOL_STATE_KEYS.AUTH)
      const authenticated = !!authJson
      return json({ ok: true, authenticated })
    }

    return json({ error: { message: 'Not found' } }, 404)
  },
}

export { CompletionSessionDO }