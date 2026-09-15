import { PROTOCOL_STATE_KEYS } from './deepseek_api/index.js'
import { CloudflareKVStateStore } from './adapters/cloudflare-kv-state-store.js'
import { CloudflareD1SessionStore } from './adapters/cloudflare-d1-session-store.js'
import { DeepSeekWebClient } from './deepseek_api/index.js'
import { translateOpenAIRequest, translateDeepSeekStreamToSSE, translateDeepSeekStreamToJSON, getXSessionIdFromHeaders } from './translator/index.js'
import { generateTraceId, RequestLogger } from './observability/index.js'
import type { OpenAIChatCompletionRequest } from './translator/types.js'

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
    CREATE TABLE IF NOT EXISTS proxy_sessions (
      x_session_id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      parent_message_id INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
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
    // Observability: generate trace ID and logger
    const traceId = generateTraceId();
    const logger = new RequestLogger(traceId);
    
    // Clone and log incoming request
    const rawBody = await request.clone().text().catch(() => '');
    logger.logIncoming(request, rawBody);

    
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

        // GET /v1/debug/d1-sessions - Debug D1 proxy_sessions storage
        if (pathname === '/v1/debug/d1-sessions' && request.method === 'GET') {
          const proxySessions = await env.DB.prepare('SELECT * FROM proxy_sessions ORDER BY updated_at DESC').all()
          return json({
            ok: true,
            count: proxySessions.results?.length || 0,
            sessions: proxySessions.results || []
          })
        }

        // POST /v1/chat/completions - OpenAI-compatible endpoint
        if (pathname === '/v1/chat/completions' && request.method === 'POST') {
          await rateLimit()
          try {
            const body = await request.json().catch(() => null)
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return json({ error: { message: 'Invalid request: body must be an object', type: 'invalid_request_error' } }, 400)
            }
            const openaiReq = body as OpenAIChatCompletionRequest
            if (!Array.isArray(openaiReq.messages)) {
              return json({ error: { message: 'Invalid request: messages must be an array', type: 'invalid_request_error' } }, 400)
            }

            // Check turn_count to determine if we should send system prompt (turns 1 and 2 only)
            const xSessionId = getXSessionIdFromHeaders(request.headers)
            let sendSystemPrompt = true
            if (xSessionId) {
              const row = await env.DB.prepare(
                'SELECT turn_count FROM proxy_sessions WHERE x_session_id = ?'
              ).bind(xSessionId).first()
              if (row && typeof row.turn_count === 'number') {
                // Send system prompt on turn 1 and turn 2. Strip from turn 3 onward.
                sendSystemPrompt = row.turn_count < 2
              }
            }

            const input = translateOpenAIRequest(openaiReq, request.headers, sendSystemPrompt, logger)
            const client = createDeepSeekClient(env)
            const { response, sessionUpdatePromise } = await client.completeWithAutoSession(input, logger)

            // MUST run before returning, otherwise attachSessionPersistence may be cancelled
            ctx.waitUntil(sessionUpdatePromise)

            if (!response.ok) {
              return new Response(JSON.stringify({ error: { message: `DeepSeek API error: ${response.status} ${response.statusText}`, type: 'upstream_error', code: response.status } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
            }
            if (!response.body) {
              return new Response(JSON.stringify({ error: { message: 'DeepSeek API returned no body', type: 'upstream_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
            }

            const info = { model: openaiReq.model, id: 'chatcmpl', created: Math.floor(Date.now() / 1000) }

            if (openaiReq.stream === true) {
              const stream = translateDeepSeekStreamToSSE(response.body, info, logger)
              return new Response(stream, {
                headers: {
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache, no-transform',
                  'Connection': 'keep-alive',
                },
              })
            }

            const jsonResp = await translateDeepSeekStreamToJSON(response.body, info, logger)
            return new Response(JSON.stringify(jsonResp), { headers: { 'Content-Type': 'application/json' } })
          } catch (err) {
            // translateOpenAIRequest throws 'No user message found' on bad input -> 400
            const message = err instanceof Error ? err.message : 'Internal error'
            const status = message === 'No user message found' ? 400
              : err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
                ? (err as { status: number }).status : 500
            return new Response(JSON.stringify({ error: { message, type: status === 400 ? 'invalid_request_error' : 'internal_error' } }), { status, headers: { 'Content-Type': 'application/json' } })
          }
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
               // Note: xSessionId is not taken from body; it comes from header below
             }

             // Read X-Session-Id header (proxy-local, not forwarded upstream)
             const xSessionIdHeader = request.headers.get('X-Session-Id');
             let xSessionId: string | undefined;
             if (xSessionIdHeader !== null) {
               const trimmed = xSessionIdHeader.trim();
               if (trimmed.length > 0 && trimmed.length <= 128) {
                 xSessionId = trimmed;
               }
               // If empty, too long, or only whitespace, treat as absent
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
               xSessionId: xSessionId,
             }

            // Protocol handles session resolution and persistence
            const { response, sessionUpdatePromise } = await client.completeWithAutoSession(completionInput, logger)

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
            const status =
              err && typeof err === "object" && "status" in err &&
              typeof (err as { status?: unknown }).status === "number"
                ? (err as { status: number }).status
                : 500
            return new Response(
              JSON.stringify({ error: { message: err instanceof Error ? err.message : "Internal error" } }),
              { status, headers: { "Content-Type": "application/json" } },
            )
          }
        }

        return json({ error: { message: 'Not found' } }, 404)
  },
}