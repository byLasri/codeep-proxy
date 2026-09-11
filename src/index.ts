import { PROTOCOL_STATE_KEYS } from './deepseek/index.js'
import { CompletionSessionDO } from './completions-session-do.js'
import { DeepSeekWebClient } from './deepseek/client.js'
import type { DeepSeekCompletionInput } from './deepseek/types.js'

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

    // Route /v1/completions to Durable Object
    if (pathname === '/v1/completions' && request.method === 'POST') {
      const url = new URL(request.url)
      const conversationId = url.searchParams.get('conversation_id')
      
      if (!conversationId) {
        // Try to get from request body
        try {
          const body = await request.clone().json()
          if (body && typeof body === 'object' && 'conversation_id' in body && typeof body.conversation_id === 'string') {
            // Use the conversation_id from body - will be validated by DO
          } else {
            return json({ error: { message: 'conversation_id is required' } }, 400)
          }
        } catch {
          return json({ error: { message: 'conversation_id is required' } }, 400)
        }
      }
      
      // Get or create Durable Object for this conversation
      const id = env.COMPLETION_SESSIONS.idFromName(conversationId || 'default')
      const stub = env.COMPLETION_SESSIONS.get(id)
      return stub.fetch(request)
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

    // POST /v1/chat/completions - OpenAI-compatible chat completions
    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
      try {
        const body = await request.json() as { messages?: any[]; model?: string; stream?: boolean }
        const { messages, model = 'deepseek-chat', stream = true } = body

        if (!messages || !Array.isArray(messages)) {
          return json({ error: { message: 'messages array is required' } }, 400)
        }

        // Get credentials from state store
        const authJson = await env.AUTH_KV.get(PROTOCOL_STATE_KEYS.AUTH)
        if (!authJson) {
          return json({ error: { message: 'DeepSeek credentials not configured. Use POST /v1/auth to set them.' } }, 401)
        }

        // Initialize client with state store that uses AUTH_KV for both reading credentials and writing HIF-LEIM cache
        const stateStore = {
          get: async (key: string) => {
            return await env.AUTH_KV.get(key)
          },
          set: async (key: string, value: string, ttlSeconds?: number) => {
            await env.AUTH_KV.put(key, value, { expirationTtl: ttlSeconds })
          },
          delete: async (key: string) => {
            await env.AUTH_KV.delete(key)
          }
        }
        
        const client = new DeepSeekWebClient({ stateStore })

        // Convert OpenAI messages to DeepSeek prompt format
        const prompt = messages.map((m: any) => {
          const role = m.role || 'user'
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          return `${role}: ${content}`
        }).join('\n')

        // Create session
        const session = await client.createSession()

        // Build completion input
        const completionInput: DeepSeekCompletionInput = {
          session: {
            chat_session_id: session.id,
            parent_message_id: session.current_message_id || null,
            model_type: 'default',
            thinking_enabled: false,
            search_enabled: false,
          },
          prompt,
          model_type: 'default',
          thinking_enabled: false,
          search_enabled: false,
          ref_file_ids: [],
          action: null,
          preempt: false,
        }

        // Execute completion
        const response = await client.complete(completionInput)

        // Transform DeepSeek SSE to OpenAI-compatible SSE
        if (stream && response.body) {
          const transformStream = new TransformStream({
            async transform(chunk, controller) {
              const text = new TextDecoder().decode(chunk)
              const lines = text.split('\n').filter(line => line.trim())
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const dataStr = line.slice(6).trim()
                  try {
                    const data = JSON.parse(dataStr)
                    
                    // Skip ready events - they're internal to DeepSeek protocol
                    if (data.request_message_id !== undefined && data.response_message_id !== undefined) {
                      continue
                    }
                    
                    // Handle data events with response fragments
                    if (data.v?.response?.fragments) {
                      for (const frag of data.v.response.fragments) {
                        if (frag.o === 'APPEND' && typeof frag.v === 'string') {
                          const openaiChunk = {
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion.chunk' as const,
                            created: Math.floor(Date.now() / 1000),
                            model,
                            choices: [{
                              index: 0,
                              delta: { role: 'assistant', content: frag.v },
                              finish_reason: null,
                            }],
                          }
                          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                        }
                      }
                    }
                    
                    // Handle direct content field
                    if (data.v?.response?.content && typeof data.v.response.content === 'string') {
                      const openaiChunk = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk' as const,
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{
                          index: 0,
                          delta: { role: 'assistant', content: data.v.response.content },
                          finish_reason: null,
                        }],
                      }
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                    }
                    
                    // Handle finish event
                    if (data.p === 'response/status' && data.v === 'FINISHED') {
                      const finalChunk = {
                        id: `chatcmpl-${Date.now()}`,
                        object: 'chat.completion.chunk' as const,
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{
                          index: 0,
                          delta: {},
                          finish_reason: 'stop',
                        }],
                      }
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
                      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
                    }
                  } catch {
                    // Skip malformed JSON
                  }
                }
              }
            },
          })
          
          const transformedStream = response.body.pipeThrough(transformStream)
          
          return new Response(transformedStream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            },
          })
        } else {
          // Non-streaming: collect and return as JSON
          const text = await response.text()
          return json({ result: text })
        }
      } catch (error) {
        console.error('Error in /v1/chat/completions:', error)
        return json({ 
          error: { 
            message: error instanceof Error ? error.message : 'Internal server error' 
          } 
        }, 500)
      }
    }

    return json({ error: { message: 'Not found' } }, 404)
  },
}

export { CompletionSessionDO }