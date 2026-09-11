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

    return json({ error: { message: 'Not found' } }, 404)
  },
}