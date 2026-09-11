const AUTH_KEY = 'deepseek-auth'

interface Env {
  AUTH_KV: KVNamespace
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

async function loadAuthState(env: Env): Promise<AuthState | null> {
  return await env.AUTH_KV.get(AUTH_KEY, 'json') as AuthState | null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname

    if (pathname === '/v1/auth') {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null) as AuthState | null
        if (!body || !Array.isArray(body.cookies)) {
          return json({ error: { message: 'Invalid auth state' } }, 400)
        }

        await env.AUTH_KV.put(AUTH_KEY, JSON.stringify(body))
        return json({ ok: true })
      }

      if (request.method === 'GET') {
        const state = await loadAuthState(env)
        return json({
          exists: !!state,
          ...(state
            ? {
                state: {
                  authorizationToken: state.authorizationToken ? '[present]' : null,
                  cookies_count: state.cookies?.length || 0,
                },
              }
            : {}),
        })
      }

      if (request.method === 'DELETE') {
        await env.AUTH_KV.delete(AUTH_KEY)
        return json({ ok: true })
      }
    }

    return json({ error: { message: 'Not found' } }, 404)
  },
}
