import { PROTOCOL_STATE_KEYS } from './deepseek_api/index.js'
import { CloudflareKVStateStore } from './adapters/cloudflare-kv-state-store.js'
import { CloudflareD1SessionStore } from './adapters/cloudflare-d1-session-store.js'
import { DeepSeekWebClient } from './deepseek_api/index.js'

// Simple rate limiter - 5 second delay for EVERY request (including first)
const RATE_LIMIT_MS = 5000
let lastRequestTime = 0

async function rateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (lastRequestTime === 0) {
    console.log(`[RateLimit] First request - waiting ${RATE_LIMIT_MS}ms`)
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS))
  } else if (elapsed < RATE_LIMIT_MS) {
    const waitTime = RATE_LIMIT_MS - elapsed
    console.log(`[RateLimit] Waiting ${waitTime}ms (elapsed: ${elapsed}ms)`)
    await new Promise(resolve => setTimeout(resolve, waitTime))
  } else {
    console.log(`[RateLimit] Proceed immediately (elapsed: ${elapsed}ms)`)
  }
  lastRequestTime = Date.now()
  console.log(`[RateLimit] Request processed at ${new Date().toISOString()}`)
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
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function initSessionsTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_session_id TEXT PRIMARY KEY,
      parent_message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run()
}

function createDeepSeekClient(env: Env): DeepSeekWebClient {
  const stateStore = new CloudflareKVStateStore(env.AUTH_KV)
  const sessionStore = new CloudflareD1SessionStore(env.DB)
  return new DeepSeekWebClient({ stateStore, sessionStore })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize D1 sessions table
    await initSessionsTable(env.DB)
    
    const pathname = new URL(request.url).pathname

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

        // GET /v1/debug/hif-cache - Debug HIF cache state
        if (pathname === '/v1/debug/hif-cache' && request.method === 'GET') {
          const stateStore = new CloudflareKVStateStore(env.AUTH_KV)
          const leimValue = await stateStore.get(PROTOCOL_STATE_KEYS.HIF_LEIM)
          return json({
            ok: true,
            cached: !!leimValue,
            value_preview: leimValue ? leimValue.slice(0, 30) + '...' : null,
            value_length: leimValue?.length || 0,
          })
        }

        // GET /v1/debug/d1-sessions - Debug D1 session storage
        if (pathname === '/v1/debug/d1-sessions' && request.method === 'GET') {
          const sessions = await env.DB.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all()
          return json({
            ok: true,
            count: sessions.results?.length || 0,
            sessions: sessions.results || []
          })
        }

        // POST /deepseekprotocol - Raw DeepSeek protocol endpoint
        // Takes DeepSeekCompletionInput (chat_session_id optional - auto-created if missing), returns raw DeepSeek SSE stream
        if (pathname === '/deepseekprotocol' && request.method === 'POST') {
          await rateLimit()
          try {
            const body = await request.json()

            // Validate DeepSeek completion input
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return json({ error: { message: 'Invalid request: body must be an object' } }, 400)
            }

            const input = body as {
              chat_session_id?: string
              prompt?: string
              model_type?: string | null
              thinking_enabled?: boolean
              search_enabled?: boolean
              ref_file_ids?: string[]
              action?: unknown | null
              preempt?: boolean
            }

            if (!input.prompt || typeof input.prompt !== 'string') {
              return json({ error: { message: 'Invalid request: prompt is required' } }, 400)
            }
            if (input.model_type === undefined) {
              return json({ error: { message: 'Invalid request: model_type is required' } }, 400)
            }

            // Validate chat_session_id if provided
            if (input.chat_session_id !== undefined) {
              if (typeof input.chat_session_id !== 'string') {
                return json({ error: { message: 'Invalid request: chat_session_id must be a string' } }, 400)
              }
            }

            const client = createDeepSeekClient(env)

            // Build completion input - protocol handles session creation/persistence via sessionStore
            const completionInput = {
              chat_session_id: input.chat_session_id,
              prompt: input.prompt,
              model_type: input.model_type,
              thinking_enabled: input.thinking_enabled ?? false,
              search_enabled: input.search_enabled ?? false,
            }

            // Protocol handles session resolution and persistence
            const { response, sessionUpdatePromise } = await client.completeWithAutoSession(completionInput)

            if (!response.ok) {
              return new Response(JSON.stringify({
                error: { message: `DeepSeek API error: ${response.status} ${response.statusText}` }
              }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' }
              })
            }

            if (!response.body) {
              return new Response(JSON.stringify({
                error: { message: 'DeepSeek API returned no body' }
              }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' }
              })
            }

            // Ensure session update completes in background (Cloudflare Workers requires ctx.waitUntil)
            ctx.waitUntil(sessionUpdatePromise)

            // Return raw DeepSeek SSE stream - session persistence handled by protocol
            const chatSessionId = response.headers.get('X-Chat-Session-Id')
            return new Response(response.body, {
              headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                ...(chatSessionId ? { 'X-Chat-Session-Id': chatSessionId } : {}),
              },
            })
          } catch (err) {
            return new Response(JSON.stringify({
              error: {
                message: err instanceof Error ? err.message : 'Invalid request',
              },
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }
        }

        return json({ error: { message: 'Not found' } }, 404)
  },
}