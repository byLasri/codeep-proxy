import { PROTOCOL_STATE_KEYS } from './deepseek_api/index.js'
import { CloudflareKVStateStore } from './adapters/cloudflare-kv-state-store.js'
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

interface DBSession {
  chat_session_id: string
  parent_message_id: number
  created_at: number
  updated_at: number
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
  return new DeepSeekWebClient({ stateStore })
}

async function getSession(db: D1Database, chatSessionId: string): Promise<DBSession | null> {
  const result = await db.prepare('SELECT * FROM sessions WHERE chat_session_id = ?').bind(chatSessionId).first()
  return result as DBSession | null
}

async function upsertSession(db: D1Database, chatSessionId: string, parentMessageId: number): Promise<void> {
  const now = Date.now()
  await db.prepare(`
    INSERT INTO sessions (chat_session_id, parent_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_session_id) DO UPDATE SET
      parent_message_id = excluded.parent_message_id,
      updated_at = excluded.updated_at
  `).bind(chatSessionId, parentMessageId, now, now).run()
}

async function createSessionRecord(db: D1Database, chatSessionId: string): Promise<void> {
  const now = Date.now()
  await db.prepare(`
    INSERT INTO sessions (chat_session_id, parent_message_id, created_at, updated_at)
    VALUES (?, 0, ?, ?)
  `).bind(chatSessionId, now, now).run()
}

function createStreamingResponse(
  deepSeekBody: ReadableStream<Uint8Array>,
  model: string
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  
  let modelTypeFromReady: string | null = null
  let hasSentRole = false
  let isCompleted = false
  
  const encoder = new TextEncoder()
  
  const openaiStream = deepSeekBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        const decoder = new TextDecoder()
        const text = decoder.decode(chunk)
        const lines = text.split('\n').filter(line => line.trim())
        
        for (const line of lines) {
          if (line.startsWith('event: ready')) {
            continue
          } else if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim()
            try {
              const data = JSON.parse(dataStr)
              
              // Handle ready event
              if (data.request_message_id !== undefined) {
                modelTypeFromReady = data.model_type ?? null
                continue
              }
              
              // Handle content from fragments
              if (data.v?.response?.fragments) {
                for (const frag of data.v.response.fragments) {
                  if (frag.o === 'APPEND' && frag.p?.includes('/content') && frag.v) {
                    // First chunk: send role
                    if (!hasSentRole) {
                      const roleChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk' as const,
                        created,
                        model: modelTypeFromReady ?? model,
                        choices: [{
                          index: 0,
                          delta: { role: 'assistant' },
                          finish_reason: null,
                        }],
                      }
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`))
                      hasSentRole = true
                    }
                    
                    const contentChunk = {
                      id: completionId,
                      object: 'chat.completion.chunk' as const,
                      created,
                      model: modelTypeFromReady ?? model,
                      choices: [{
                        index: 0,
                        delta: { content: frag.v },
                        finish_reason: null,
                      }],
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
                  }
                }
              } else if (data.p === 'response/fragments/-1/content' && data.o === 'APPEND' && data.v) {
                // Streaming content - direct patch
                if (!hasSentRole) {
                  const roleChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk' as const,
                    created,
                    model: modelTypeFromReady ?? model,
                    choices: [{
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null,
                    }],
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`))
                  hasSentRole = true
                }
                
                const contentChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk' as const,
                  created,
                  model: modelTypeFromReady ?? model,
                  choices: [{
                    index: 0,
                    delta: { content: data.v },
                    finish_reason: null,
                  }],
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
              } else if (data.p === 'response/status' && data.v === 'FINISHED') {
                // Handle finish via patch
                if (!isCompleted) {
                  isCompleted = true
                  const finalChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk' as const,
                    created,
                    model: modelTypeFromReady ?? model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop',
                    }],
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                }
              } else if (data.p === 'response/status' && data.o === 'SET' && data.v === 'FINISHED') {
                // Handle SET operation for status
                if (!isCompleted) {
                  isCompleted = true
                  const finalChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk' as const,
                    created,
                    model: modelTypeFromReady ?? model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop',
                    }],
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                }
              }
            } catch {
              // Non-JSON data, ignore
            }
          } else if (line.startsWith('event: close')) {
            if (!isCompleted) {
              isCompleted = true
              const finalChunk = {
                id: completionId,
                object: 'chat.completion.chunk' as const,
                created,
                model: modelTypeFromReady ?? model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            }
          }
        }
      },
    })
  )

  return new Response(openaiStream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  })
}

async function createNonStreamingResponse(
  deepSeekBody: ReadableStream<Uint8Array>,
  model: string
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let modelTypeFromReady: string | null = null
  let fullContent = ''
  
  const reader = deepSeekBody.getReader()
  const decoder = new TextDecoder()
  
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const text = decoder.decode(value, { stream: true })
      const lines = text.split('\n').filter(line => line.trim())
      
      for (const line of lines) {
        if (line.startsWith('event: ready')) {
          continue
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim()
          try {
            const data = JSON.parse(dataStr)
            
            if (data.request_message_id !== undefined) {
              modelTypeFromReady = data.model_type ?? null
            } else if (data.v?.response?.fragments) {
              for (const frag of data.v.response.fragments) {
                if (frag.o === 'APPEND' && frag.p?.includes('/content') && frag.v) {
                  fullContent += frag.v
                }
              }
            } else if (data.p === 'response/fragments/-1/content' && data.o === 'APPEND' && data.v) {
              fullContent += data.v
            }
          } catch {
            // Non-JSON data, ignore
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  
  const responseBody = {
    id: completionId,
    object: 'chat.completion' as const,
    created,
    model: modelTypeFromReady ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: fullContent,
      },
      finish_reason: 'stop',
    }],
  }
  
  return new Response(JSON.stringify(responseBody), {
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize D1 sessions table
    await initSessionsTable(env.DB)
    
    const pathname = new URL(request.url).pathname

    // POST /v1/chat/completions - Stateless completion handler
        if (pathname === '/v1/chat/completions' && request.method === 'POST') {
          try {
            const body = await request.json()
        
            // Validate OpenAI completion request
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return json({ error: { message: 'Invalid request: body must be an object' } }, 400)
            }
        
            const openAIRequest = body as {
              model?: string
              messages?: Array<{ role: string; content: string }>
              stream?: boolean
              temperature?: number
              max_tokens?: number
            }
        
            if (!openAIRequest.model || typeof openAIRequest.model !== 'string') {
              return json({ error: { message: 'Invalid request: model is required' } }, 400)
            }
        
            if (!openAIRequest.messages || !Array.isArray(openAIRequest.messages) || openAIRequest.messages.length === 0) {
              return json({ error: { message: 'Invalid request: messages array is required and must not be empty' } }, 400)
            }
        
            // Find the latest user message
            const userMessages = openAIRequest.messages.filter(m => m.role === 'user')
            if (userMessages.length === 0) {
              return json({ error: { message: 'Invalid request: at least one user message is required' } }, 400)
            }
        
            const latestUserMessage = userMessages[userMessages.length - 1]
            const prompt = latestUserMessage.content
        
            const isStreaming = openAIRequest.stream ?? true
        
            const client = createDeepSeekClient(env)
        
            // Create fresh DeepSeek session for this request
            const newSession = await client.createSession()
                    const chat_session_id = newSession.id
                    const parent_message_id = null
        
                    // Map OpenAI model to DeepSeek model_type
                    const modelType = openAIRequest.model === 'deepseek-reasoner' || openAIRequest.model === 'expert' ? 'expert' : null
        
                    // Build DeepSeek completion input
                    const completionInput = {
                      session: { chat_session_id, parent_message_id },
                      prompt,
                      model_type: modelType,
                      thinking_enabled: false,
                      search_enabled: false,
                      ref_file_ids: [],
                      action: null,
                      preempt: false,
                    }
        
                    // Call DeepSeek completion
                    const response = await client.complete(completionInput)
        
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
        
            if (isStreaming) {
              return createStreamingResponse(response.body, openAIRequest.model)
            } else {
              return createNonStreamingResponse(response.body, openAIRequest.model)
            }
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
        // Takes DeepSeekCompletionInput (session optional - auto-created if missing), returns raw DeepSeek SSE stream
        if (pathname === '/deepseekprotocol' && request.method === 'POST') {
          await rateLimit()
          try {
            const body = await request.json()

            // Validate DeepSeek completion input
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return json({ error: { message: 'Invalid request: body must be an object' } }, 400)
            }

            const input = body as {
              session?: { chat_session_id: string; parent_message_id: number | null }
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

            // Validate session: if provided, BOTH chat_session_id AND parent_message_id are required
            if (input.session) {
              if (!input.session.chat_session_id || typeof input.session.chat_session_id !== 'string') {
                return json({ error: { message: 'Invalid request: session.chat_session_id is required' } }, 400)
              }
              if (input.session.parent_message_id === undefined || input.session.parent_message_id === null) {
                return json({ error: { message: 'Invalid request: session.parent_message_id is required when session is provided' } }, 400)
              }
            }

            // action and preempt are FIXED values - must not be overridden
            // They are protocol constants: action=null, preempt=false
            // ref_file_ids is also FIXED: [] (empty array)
            // deepseek_api enforces all three as protocol constants
            const fixedAction = null;
            const fixedPreempt = false;

            const client = createDeepSeekClient(env)

            // If no session provided, create one first so we have the session ID for storage
            let sessionChatId = input.session?.chat_session_id;
            let sessionParentId = input.session?.parent_message_id ?? null;
            let sessionWasAutoCreated = false;

            if (!sessionChatId) {
              const newSession = await client.createSession();
              sessionChatId = newSession.id;
              sessionParentId = null; // First turn MUST use null (enforced by deepseek_api)
              sessionWasAutoCreated = true;
              // Create session record in D1
              await createSessionRecord(env.DB, sessionChatId)
            } else {
              // Validate provided session exists in D1
              const storedSession = await getSession(env.DB, sessionChatId)
              if (!storedSession) {
                return json({ error: { message: 'Invalid request: session not found in store' } }, 404)
              }
              // Use stored parent_message_id for continuation (ignore provided value)
              sessionParentId = storedSession.parent_message_id
            }

            // Build completion input with the session (either provided or newly created)
            // ref_file_ids, action, preempt are FIXED in deepseek_api - not passed from input
            const completionInput = {
              session: {
                chat_session_id: sessionChatId,
                parent_message_id: sessionParentId,
              },
              prompt: input.prompt,
              model_type: input.model_type,
              thinking_enabled: input.thinking_enabled ?? false,
              search_enabled: input.search_enabled ?? false,
              // ref_file_ids: [] (FIXED in deepseek_api)
              // action: null (FIXED in deepseek_api)
              // preempt: false (FIXED in deepseek_api)
            }

            // Use the session we created/validated
            const response = await client.complete(completionInput)

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

            // Parse stream to extract response_message_id and store session
            // We need to consume the stream to find the ready event
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let responseMessageId: number | null = null;
            let currentEvent: string | null = null;
            let buffer = '';

            // We'll collect chunks to rebuild the stream for the client
            const chunks: Uint8Array[] = [];

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                
                const text = decoder.decode(value, { stream: true });
                buffer += text;
                
                const lines = buffer.split('\n');
                // Keep the last incomplete line in buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                  if (line.startsWith('event:')) {
                    currentEvent = line.slice(6).trim();
                  } else if (line.startsWith('data:')) {
                    const dataStr = line.slice(5).trim();
                    try {
                      const data = JSON.parse(dataStr);
                      
                      // Look for ready event with response_message_id
                      if (currentEvent === 'ready' && data.response_message_id !== undefined && data.request_message_id !== undefined) {
                        responseMessageId = data.response_message_id;
                        break;
                      }
                    } catch {
                      // Non-JSON data, ignore
                    }
                  }
                }
                
                if (responseMessageId !== null) break;
              }
            } finally {
              reader.releaseLock();
            }

            // Rebuild the stream from collected chunks + remaining stream
            const remainingStream = new ReadableStream({
              async start(controller) {
                // First, send collected chunks
                for (const chunk of chunks) {
                  controller.enqueue(chunk);
                }
                // Then pipe the rest of the original stream
                const remainingReader = response.body!.getReader();
                try {
                  while (true) {
                    const { done, value } = await remainingReader.read();
                    if (done) break;
                    controller.enqueue(value);
                  }
                } finally {
                  remainingReader.releaseLock();
                  controller.close();
                }
              }
            });

            // Store session in background using ctx.waitUntil
            if (sessionChatId) {
              const finalParentMessageId = responseMessageId !== null ? responseMessageId : (sessionWasAutoCreated ? 0 : null);
              
              if (finalParentMessageId !== null) {
                ctx.waitUntil(upsertSession(env.DB, sessionChatId, finalParentMessageId));
              }
            }

            // Return rebuilt stream
            return new Response(remainingStream, {
              headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
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