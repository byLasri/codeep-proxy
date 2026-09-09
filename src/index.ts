const AUTH_KEY = 'deepseek-auth'
const SESSION_PREFIX = 'deepseek-session:'

interface Env {
  DEEPSEEK_ORIGIN?: string
  DEEPSEEK_AUTHORIZATION?: string
  DEEPSEEK_COOKIE?: string
  AUTH_KV: KVNamespace
  CAPTURE_LOG?: string
  DEBUG_BUCKET?: R2Bucket
}

interface ChatRequest {
  model?: string
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
  stream?: boolean
}

interface AuthCookie {
  name: string
  value: string
}

interface AuthState {
  authorizationToken?: string
  cookies?: AuthCookie[]
}

interface ResponsesRequest {
  model?: string
  input?: string | Array<{
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
  }>
  instructions?: string
  previous_response_id?: string
  stream?: boolean
}

interface SessionState {
  deepSeekSessionId: string
  lastMessageId: string | null
  instructionsApplied: boolean
}

import { solvePow, type PowChallenge } from './pow'

async function loadAuthState(env: Env): Promise<AuthState | null> {
  return await env.AUTH_KV.get(AUTH_KEY, 'json') as AuthState | null
}

async function credentials(env: Env): Promise<{ authorization?: string; cookie?: string }> {
  const state = await loadAuthState(env)
  return {
    authorization: state?.authorizationToken || env.DEEPSEEK_AUTHORIZATION,
    cookie: state?.cookies?.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') || env.DEEPSEEK_COOKIE,
  }
}

const headers = async (env: Env): Promise<Headers> => {
  const auth = await credentials(env)
  const origin = env.DEEPSEEK_ORIGIN || 'https://chat.deepseek.com'
  const value = new Headers({
  Accept: '*/*',
  'Content-Type': 'application/json',
  Origin: origin,
  Referer: `${origin}/`,
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-platform': 'web',
  'x-client-version': '2.4.0',
  'x-client-locale': 'en_US',
  'x-client-timezone-offset': String(new Date().getTimezoneOffset()),
  })
  if (auth.authorization) value.set('Authorization', `Bearer ${auth.authorization.replace(/^Bearer\s+/i, '')}`)
  if (auth.cookie) value.set('Cookie', auth.cookie)
  return value
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function readJson(response: Response): Promise<any> {
  const value = await response.text()
  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

async function createSession(env: Env): Promise<string> {
  const origin = env.DEEPSEEK_ORIGIN || 'https://chat.deepseek.com'
  const response = await fetch(`${origin}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: await headers(env),
    body: '{}',
  })
  const value = await readJson(response)
  const id = value?.data?.biz_data?.chat_session?.id
  if (!response.ok || value?.code !== 0 || typeof id !== 'string') {
    throw new Error(`DeepSeek session creation failed (${response.status})`)
  }
  return id
}

async function createChallenge(env: Env): Promise<PowChallenge> {
  const origin = env.DEEPSEEK_ORIGIN || 'https://chat.deepseek.com'
  const response = await fetch(`${origin}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: await headers(env),
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  })
  const value = await readJson(response)
  const challenge = value?.data?.biz_data?.challenge
  if (!response.ok || value?.code !== 0 || !challenge) {
    throw new Error(`DeepSeek PoW challenge failed (${response.status})`)
  }
  return challenge as PowChallenge
}

function messageText(message: NonNullable<ChatRequest['messages']>[number]): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => part.text ?? '').join('')
}

function responseInputText(input: ResponsesRequest): string {
  if (typeof input.input === 'string') return input.input
  const items = (input.input || []).filter((item): item is Exclude<NonNullable<ResponsesRequest['input']>[number], string> => typeof item !== 'string')
  const userItem = [...items].reverse().find((item) => item.role === 'user') || items[items.length - 1]
  if (!userItem) return ''
  return typeof userItem.content === 'string'
    ? userItem.content
    : (userItem.content || []).map((part: { text?: string }) => part.text || '').join('')
}

function sessionKey(identifier: string): string {
  return `${SESSION_PREFIX}${identifier}`
}

async function loadSession(env: Env, identifiers: Array<string | null | undefined>): Promise<SessionState | null> {
  for (const identifier of identifiers) {
    if (!identifier) continue
    const state = await env.AUTH_KV.get(sessionKey(identifier), 'json') as SessionState | null
    if (state) return state
  }
  return null
}

async function saveSession(env: Env, identifiers: string[], state: SessionState): Promise<void> {
  await Promise.all(identifiers.map((identifier) =>
    env.AUTH_KV.put(sessionKey(identifier), JSON.stringify(state), { expirationTtl: 259200 }),
  ))
}

async function requestDeepSeek(input: ChatRequest, env: Env, sessionId: string, parentMessageId: string | null = null): Promise<Response> {
  if (!input.messages?.length) return json({ error: { message: 'messages is required' } }, 400)

  const challenge = await createChallenge(env)
  const pow = btoa(JSON.stringify(solvePow(challenge as PowChallenge)))
  const prompt = messageText(input.messages[input.messages.length - 1])
  const reasoningEnabled = input.model === 'deepseek-reasoner'
  const origin = env.DEEPSEEK_ORIGIN || 'https://chat.deepseek.com'
  return fetch(`${origin}/api/v0/chat/completion`, {
    method: 'POST',
    headers: new Headers({ ...Object.fromEntries(await headers(env)), 'x-ds-pow-response': pow }),
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: parentMessageId,
      model_type: reasoningEnabled ? 'expert' : 'default',
      prompt,
      ref_file_ids: [],
      thinking_enabled: reasoningEnabled,
      search_enabled: false,
      action: null,
      preempt: false,
    }),
  })
}

function openAiChunk(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
}

function responsesChunk(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
}

interface DeepSeekDelta {
  p?: string
  o?: 'SET' | 'APPEND' | 'BATCH'
  v?: unknown
}

function createDeepSeekDeltaParser(onResponseText: (text: string) => void): (event: DeepSeekDelta) => void {
  let path = ''
  let operation: 'SET' | 'APPEND' = 'SET'
  let fragmentType: string | undefined
  const fragmentTypes = new Map<string, string>()

  const apply = (event: DeepSeekDelta, prefix = '', nested = false): void => {
    const eventPath = event.p ?? (nested ? '' : path)
    const eventOperation = event.o ?? (nested ? 'SET' : operation)
    if (!nested) {
      path = eventPath
      operation = eventOperation === 'APPEND' ? 'APPEND' : 'SET'
    }

    if (eventOperation === 'BATCH') {
      if (!Array.isArray(event.v)) return
      for (const item of event.v) {
        if (item && typeof item === 'object') {
          apply(item as DeepSeekDelta, eventPath ? `${prefix}${eventPath}/` : prefix, true)
        }
      }
      return
    }

    const fullPath = `${prefix}${eventPath}`.replace(/\/+/g, '/').replace(/^\/+/, '')
    if (Array.isArray(event.v)) {
      const lastFragment = event.v[event.v.length - 1]
      if (
        lastFragment &&
        typeof lastFragment === 'object' &&
        typeof (lastFragment as { type?: unknown }).type === 'string'
      ) {
        const type = (lastFragment as { type: string }).type
        fragmentType = type
        fragmentTypes.set('-1', type)
      }
      for (const fragment of event.v) {
        if (
          fragment &&
          typeof fragment === 'object' &&
          (fragment as { type?: string }).type === 'RESPONSE' &&
          typeof (fragment as { content?: unknown }).content === 'string'
        ) {
          onResponseText((fragment as { content: string }).content)
        }
      }
      return
    }
    if (fullPath === 'response/fragments' && eventOperation === 'APPEND' && Array.isArray(event.v)) {
      for (const fragment of event.v) {
        if (
          fragment &&
          typeof fragment === 'object' &&
          (fragment as { type?: string }).type === 'RESPONSE' &&
          typeof (fragment as { content?: unknown }).content === 'string'
        ) {
          onResponseText((fragment as { content: string }).content)
        }
      }
      return
    }
    const fragmentMatch = fullPath.match(/^response\/fragments\/([^/]+)\/(type|content)$/)
    if (fullPath.endsWith('/type') && typeof event.v === 'string') {
      fragmentType = event.v
      if (fragmentMatch) fragmentTypes.set(fragmentMatch[1], event.v)
      return
    }
    const contentFragmentType = fragmentMatch?.[2] === 'content'
      ? fragmentTypes.get(fragmentMatch[1])
      : undefined
    if (
      fullPath === 'response/content' ||
      (fullPath.endsWith('/content') && (
        contentFragmentType === 'RESPONSE' ||
        fragmentType === 'RESPONSE'
      ))
    ) {
      if (typeof event.v !== 'string') return
      onResponseText(event.v)
      return
    }
    if (event.v && typeof event.v === 'object') {
      const fragment = event.v as { type?: string; content?: unknown }
      if (fragment.type === 'RESPONSE' && typeof fragment.content === 'string') {
        onResponseText(fragment.content)
        return
      }
      const snapshot = event.v as {
        response?: { fragments?: Array<{ type?: string; content?: string | null }> }
        type?: string
        content?: string | null
      }
      const fragments = snapshot.response?.fragments
      const lastFragment = fragments?.[fragments.length - 1]
      if (lastFragment?.type) fragmentType = lastFragment.type
      if (fullPath.endsWith('/fragments/-1') && snapshot.type) {
        fragmentType = snapshot.type
        fragmentTypes.set('-1', snapshot.type)
        if (snapshot.type === 'RESPONSE' && typeof snapshot.content === 'string') {
          onResponseText(snapshot.content)
        }
      }
    }
  }

  return (event) => apply(event)
}

async function translateStream(response: Response, format: 'chat' | 'responses', responseId = `resp_${crypto.randomUUID()}`): Promise<Response> {
  if (!response.ok) return json({ error: { message: `DeepSeek completion failed (${response.status})` } }, response.status)
  if (!response.body) return json({ error: { message: 'DeepSeek returned no response stream' } }, 502)

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const itemId = `msg_${crypto.randomUUID()}`
  const responseObject = {
    id: responseId,
    object: 'response',
    status: 'completed',
    output: [{
      id: itemId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    }],
  }
  let outputText = ''
  let completed = false
  const completeResponse = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (completed) return
    completed = true
    responseObject.output[0].content[0].text = outputText
    if (format === 'chat') {
      controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
      return
    }
    controller.enqueue(encoder.encode(responsesChunk('response.output_text.done', {
      type: 'response.output_text.done',
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: outputText,
    })))
    controller.enqueue(encoder.encode(responsesChunk('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: responseObject.output[0],
    })))
    controller.enqueue(encoder.encode(responsesChunk('response.completed', {
      type: 'response.completed',
      response: responseObject,
    })))
  }
  let pending = ''
  const onResponseText = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    outputText += text
    controller.enqueue(encoder.encode(format === 'chat'
      ? openAiChunk(text)
      : responsesChunk('response.output_text.delta', {
        type: 'response.output_text.delta',
        response_id: responseId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      })))
  }
  let parseDelta: ((event: DeepSeekDelta) => void) | undefined
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      parseDelta = createDeepSeekDeltaParser((text) => onResponseText(text, controller))
      if (format === 'responses') {
        controller.enqueue(encoder.encode(responsesChunk('response.created', {
          type: 'response.created',
          response: { ...responseObject, status: 'in_progress' },
        })))
        controller.enqueue(encoder.encode(responsesChunk('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: itemId, type: 'message', role: 'assistant', content: [] },
        })))
        controller.enqueue(encoder.encode(responsesChunk('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        })))
      }
    },
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line === 'event: close') {
          completeResponse(controller)
          continue
        }
        if (!line.startsWith('data:')) continue
        try {
          const event = JSON.parse(line.slice(5).trim()) as DeepSeekDelta
          parseDelta?.(event)
        } catch {
          // Ignore DeepSeek metadata events that do not contain text.
        }
      }
    },
    flush(controller) {
      if (pending.startsWith('event: close')) {
        completeResponse(controller)
      }
    },
  })
  response.body.pipeTo(transform.writable)
  return new Response(transform.readable, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const input = await request.json() as ChatRequest
  return translateStream(await requestDeepSeek(input, env, await createSession(env)), 'chat')
}

async function handleResponses(request: Request, env: Env): Promise<Response> {
  const input = await request.json() as ResponsesRequest
  const prompt = responseInputText(input)
  if (!prompt) return json({ error: { message: 'A user input is required' } }, 400)
  const threadId = request.headers.get('thread-id')
  const sessionHeader = request.headers.get('session-id')
  const previousResponseId = input.previous_response_id

  // Primary lookup: thread-id is the canonical conversation key
  // Fallback to session-id header and previous_response_id for continuity
  const existing = await loadSession(env, [threadId, sessionHeader, previousResponseId])
  const sessionId = existing?.deepSeekSessionId || await createSession(env)
  const fullPrompt = existing || !input.instructions
    ? prompt
    : `System: ${input.instructions}\n\n${prompt}`

  // Generate responseId AFTER checking for existing session
  const responseId = `resp_${crypto.randomUUID()}`

  // Save session under ALL identifiers so any of them can retrieve it next turn
  // Most importantly: save under thread-id (primary) AND previous_response_id (what Codex will send back)
  const sessionIdentifiers = [threadId, sessionHeader].filter((value): value is string => Boolean(value))
  if (previousResponseId) sessionIdentifiers.push(previousResponseId)
  sessionIdentifiers.push(responseId)
  await saveSession(env, sessionIdentifiers, {
    deepSeekSessionId: sessionId,
    instructionsApplied: Boolean(existing?.instructionsApplied || input.instructions),
  })
  const deepSeekResponse = await requestDeepSeek({
    model: input.model,
    stream: true,
    messages: [{ role: 'user', content: fullPrompt }],
  }, env, sessionId)
  if (input.stream === false) {
    const reader = deepSeekResponse.body?.getReader()
    if (!reader) return json({ error: { message: 'DeepSeek returned no response stream' } }, 502)
    const decoder = new TextDecoder()
    let text = ''
    const parseDelta = createDeepSeekDeltaParser((value) => { text += value })
    let pending = ''
    const parseLines = (chunk: string) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        try {
          parseDelta(JSON.parse(line.slice(5).trim()) as DeepSeekDelta)
        } catch {}
      }
    }
    while (true) {
      const result = await reader.read()
      if (result.done) break
      parseLines(decoder.decode(result.value, { stream: true }))
    }
    parseLines(decoder.decode())
    if (pending.startsWith('data:')) {
      try { parseDelta(JSON.parse(pending.slice(5).trim()) as DeepSeekDelta) } catch {}
    }
    return json({ id: responseId, object: 'response', status: 'completed', output_text: text, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
  }
  return translateStream(deepSeekResponse, 'responses', responseId)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Capture request to R2 if enabled
    const captureLog = env.CAPTURE_LOG === 'true'
    if (captureLog && env.DEBUG_BUCKET) {
      try {
        // Clone request to read body without consuming original
        const requestForLog = request.clone()
        let body = ''
        try {
          const contentType = requestForLog.headers.get('content-type') ?? ''
          if (contentType.includes('application/json')) {
            body = await requestForLog.text()
          } else {
            body = await requestForLog.text()
          }
        } catch (e) {
          body = `[Error reading body: ${e}]`
        }
        const logEntry = {
          timestamp: new Date().toISOString(),
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers.entries()),
          body: body,
        }
        const key = `temp-debug/${Date.now()}-${crypto.randomUUID()}.json`
        await env.DEBUG_BUCKET.put(key, JSON.stringify(logEntry, null, 2))
      } catch (e) {
        // Fail silently to not disrupt normal operation
        console.warn('Failed to capture log to R2:', e)
      }
    }

    const pathname = new URL(request.url).pathname;
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
    if (request.method === 'POST' && pathname === '/v1/chat/completions') {
      try {
        return await handleChat(request, env)
      } catch (error) {
        return json({ error: { message: error instanceof Error ? error.message : 'Proxy request failed' } }, 502)
      }
    }
    if (request.method === 'POST' && pathname === '/v1/responses') {
      try {
        return await handleResponses(request, env)
      } catch (error) {
        return json({ error: { message: error instanceof Error ? error.message : 'Proxy request failed' } }, 502)
      }
    }
    if (request.method === 'GET' && pathname === '/v1/models') {
      const models = [
        {
          slug: 'deepseek-chat',
          prefer_websockets: false,
          display_name: 'DeepSeek Chat',
          description: 'DeepSeek chat model served through the local DeepFree proxy.',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'medium', description: 'Balances speed and reasoning depth' },
            { effort: 'high', description: 'Greater reasoning depth for complex problems' },
          ],
          shell_type: 'unified_exec',
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
          additional_speed_tiers: [],
          service_tiers: [],
          default_service_tier: null,
          availability_nux: null,
          upgrade: null,
          model_messages: {
            instructions_template: 'You are DeepSeek, an AI coding assistant. Follow the user request and return concise, accurate results.',
          },
          include_skills_usage_instructions: false,
          include_plugin_usage_instructions: false,
          include_apps_usage_instructions: false,
          supports_reasoning_summary_parameter: false,
          default_reasoning_summary: 'none',
          support_verbosity: false,
          supports_parallel_tool_calls: true,
          reasoning_summary_format: 'none',
          minimal_client_version: '0.144.0',
          default_verbosity: null,
          apply_patch_tool_type: null,
          web_search_tool_type: 'text',
          truncation_policy: { mode: 'tokens', limit: 10000 },
          supports_image_detail_original: false,
          context_window: 128000,
          max_context_window: 128000,
          auto_compact_token_limit: null,
          comp_hash: null,
          effective_context_window_percent: 95,
          experimental_supported_tools: [],
          input_modalities: ['text'],
          used_fallback_model_metadata: false,
          supports_search_tool: false,
          supports_experimental_context: false,
          use_responses_lite: false,
          guardian: null,
          node_repl_auto_review_required: false,
          node_repl_disabled: false,
          auto_review_model_override: null,
          model_specialty: null,
          tool_mode: 'code_mode_only',
          multi_agent_version: null,
          multi_agent_reasoning_effort: null,
        },
        {
          slug: 'deepseek-reasoner',
          prefer_websockets: false,
          display_name: 'DeepSeek Reasoner',
          description: 'DeepSeek reasoning model served through the local DeepFree proxy.',
          default_reasoning_level: 'high',
          supported_reasoning_levels: [
            { effort: 'medium', description: 'Balances speed and reasoning depth' },
            { effort: 'high', description: 'Greater reasoning depth for complex problems' },
          ],
          shell_type: 'unified_exec',
          visibility: 'list',
          supported_in_api: true,
          priority: 2,
          additional_speed_tiers: [],
          service_tiers: [],
          default_service_tier: null,
          availability_nux: null,
          upgrade: null,
          model_messages: {
            instructions_template: 'You are DeepSeek, an AI coding assistant. Follow the user request and return concise, accurate results.',
          },
          include_skills_usage_instructions: false,
          include_plugin_usage_instructions: false,
          include_apps_usage_instructions: false,
          supports_reasoning_summary_parameter: false,
          default_reasoning_summary: 'none',
          support_verbosity: false,
          supports_parallel_tool_calls: true,
          reasoning_summary_format: 'none',
          minimal_client_version: '0.144.0',
          default_verbosity: null,
          apply_patch_tool_type: null,
          web_search_tool_type: 'text',
          truncation_policy: { mode: 'tokens', limit: 10000 },
          supports_image_detail_original: false,
          context_window: 128000,
          max_context_window: 128000,
          auto_compact_token_limit: null,
          comp_hash: null,
          effective_context_window_percent: 95,
          experimental_supported_tools: [],
          input_modalities: ['text'],
          used_fallback_model_metadata: false,
          supports_search_tool: false,
          supports_experimental_context: false,
          use_responses_lite: false,
          guardian: null,
          node_repl_auto_review_required: false,
          node_repl_disabled: false,
          auto_review_model_override: null,
          model_specialty: null,
          tool_mode: 'code_mode_only',
          multi_agent_version: null,
          multi_agent_reasoning_effort: null,
        },
      ]
      return json({
        object: 'list',
        models,
        data: models.map(({ slug, display_name, description }) => ({
          id: slug,
          slug,
          object: 'model',
          owned_by: 'deepfree',
          name: display_name,
          description,
        })),
      })
    }
    if (request.method === 'GET' && pathname === '/health') {
      return json({ ok: true, authenticated: !!(await loadAuthState(env)) })
    }
    return json({ error: { message: 'Not found' } }, 404)
  },
}
