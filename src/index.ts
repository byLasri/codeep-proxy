interface Env {
  DEEPSEEK_ORIGIN: string
  DEEPSEEK_AUTHORIZATION: string
  DEEPSEEK_COOKIE: string
}

interface ChatRequest {
  model?: string
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
  stream?: boolean
}

import { solvePow, type PowChallenge } from './pow'

const headers = (env: Env): Headers => new Headers({
  Accept: '*/*',
  'Content-Type': 'application/json',
  Authorization: env.DEEPSEEK_AUTHORIZATION,
  Cookie: env.DEEPSEEK_COOKIE,
  Origin: env.DEEPSEEK_ORIGIN,
  Referer: `${env.DEEPSEEK_ORIGIN}/`,
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-platform': 'web',
  'x-client-version': '2.4.0',
  'x-client-locale': 'en_US',
  'x-client-timezone-offset': String(new Date().getTimezoneOffset()),
})

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
  const response = await fetch(`${env.DEEPSEEK_ORIGIN}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: headers(env),
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
  const response = await fetch(`${env.DEEPSEEK_ORIGIN}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: headers(env),
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

async function handleChat(request: Request, env: Env): Promise<Response> {
  const input = await request.json() as ChatRequest
  if (!input.messages?.length) return json({ error: { message: 'messages is required' } }, 400)

  const sessionId = await createSession(env)
  const challenge = await createChallenge(env)
  const pow = btoa(JSON.stringify(solvePow(challenge as PowChallenge)))
  const prompt = messageText(input.messages[input.messages.length - 1])
  const response = await fetch(`${env.DEEPSEEK_ORIGIN}/api/v0/chat/completion`, {
    method: 'POST',
    headers: new Headers({ ...Object.fromEntries(headers(env)), 'x-ds-pow-response': pow }),
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: input.model === 'instant' ? 'instant' : 'expert',
      prompt,
      ref_file_ids: [],
      thinking_enabled: true,
      search_enabled: false,
      action: null,
      preempt: false,
    }),
  })
  if (!response.ok) return json({ error: { message: `DeepSeek completion failed (${response.status})` } }, response.status)
  return response
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/v1/chat/completions') {
      try {
        return await handleChat(request, env)
      } catch (error) {
        return json({ error: { message: error instanceof Error ? error.message : 'Proxy request failed' } }, 502)
      }
    }
    return json({ error: { message: 'Not found' } }, 404)
  },
}
