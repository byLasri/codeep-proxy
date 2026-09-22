import {
  DeepSeekAndroidClient,
  getAndroidIdentity,
  generateAndroidDeviceId,
  generateAndroidRangersId,
  ANDROID_DEVICE_MODEL,
  buildAndroidCompletionHeaders,
  buildAndroidCompletionRequest,
  PROTOCOL_STATE_KEYS,
} from '../src/deepseek_api/index.js'
import type { ProtocolStateStore } from '../src/deepseek_api/index.js'
import type { ProtocolSessionStore, ProxySessionState } from '../src/deepseek_api/index.js'
import { solvePow, encodePowResponse, computePowHash } from '../src/deepseek_api/pow.js'

class MemoryStateStore implements ProtocolStateStore {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> { return this.map.has(key) ? this.map.get(key)! : null }
  async set(key: string, value: string): Promise<void> { this.map.set(key, value) }
  async delete(key: string): Promise<void> { this.map.delete(key) }
}

class MemorySessionStore implements ProtocolSessionStore {
  private map = new Map<string, ProxySessionState>()
  async get(id: string): Promise<ProxySessionState | null> { return this.map.get(id) ?? null }
  async set(id: string, s: ProxySessionState): Promise<void> { this.map.set(id, s) }
  async delete(id: string): Promise<void> { this.map.delete(id) }
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`PASS: ${name}`) }
  else { fail++; console.log(`FAIL: ${name} ${detail}`) }
}

const IDENTITY = { deviceId: generateAndroidDeviceId(), deviceModel: ANDROID_DEVICE_MODEL, rangersId: generateAndroidRangersId() }
const CREDS = { authorization: 'Bearer test-token' }

async function main() {
  console.log('Running Android protocol tests...\n')

  console.log('--- Identity ---')
  check('device id is base64-shaped', /^[A-Za-z0-9+/]+=*$/.test(IDENTITY.deviceId) && IDENTITY.deviceId.length > 20, IDENTITY.deviceId)
  check('device id decodes to 32 bytes', (() => { try { return atob(IDENTITY.deviceId).length === 32 } catch { return false } })())
  check('device model is NX809J', IDENTITY.deviceModel === 'NX809J')
  check('rangers id is numeric', /^\d+$/.test(IDENTITY.rangersId), IDENTITY.rangersId)
  check('rangers id is large (>=15 digits)', IDENTITY.rangersId.length >= 15, IDENTITY.rangersId)

  const storeA = new MemoryStateStore()
  const id1 = await getAndroidIdentity(storeA)
  const id2 = await getAndroidIdentity(storeA)
  check('identity is persistent through state store', id1.deviceId === id2.deviceId && id1.rangersId === id2.rangersId)
  check('identity persisted under ANDROID_IDENTITY key', (await storeA.get(PROTOCOL_STATE_KEYS.ANDROID_IDENTITY)) !== null)
  check('persisted identity survives a fresh reader on same store', (await getAndroidIdentity(storeA)).deviceId === id1.deviceId)
  const storeB = new MemoryStateStore()
  const idB = await getAndroidIdentity(storeB)
  check('distinct stores get distinct identities', idB.deviceId !== id1.deviceId)

  console.log('\n--- Completion headers ---')
  const headers = buildAndroidCompletionHeaders(CREDS, IDENTITY, 'POW_VALUE')
  const h: Record<string, string> = {}
  headers.forEach((v, k) => { h[k.toLowerCase()] = v })

  check('x-client-platform: android', h['x-client-platform'] === 'android')
  check('x-client-version: 2.5.3', h['x-client-version'] === '2.5.3')
  check('x-client-locale: en_US', h['x-client-locale'] === 'en_US')
  check('x-client-bundle-id: com.deepseek.chat', h['x-client-bundle-id'] === 'com.deepseek.chat')
  check('x-client-timezone-offset: 28800', h['x-client-timezone-offset'] === '28800')
  check('x-device-id present', !!h['x-device-id'])
  check('x-device-model: NX809J', h['x-device-model'] === 'NX809J')
  check('x-rangers-id present', !!h['x-rangers-id'])
  check('user-agent android', h['user-agent'] === 'DeepSeek/2.5.3 Android/28')
  check('authorization present', h['authorization'] === 'Bearer test-token')
  check('accept: application/json', h['accept'] === 'application/json')
  check('accept-charset: UTF-8', h['accept-charset'] === 'UTF-8')
  check('accept-encoding: gzip', h['accept-encoding'] === 'gzip')
  check('content-type: application/json', h['content-type'] === 'application/json')
  check('x-ds-pow-response present', h['x-ds-pow-response'] === 'POW_VALUE')

  check('NO origin', !('origin' in h))
  check('NO referer', !('referer' in h))
  check('NO x-hif-leim', !('x-hif-leim' in h))
  check('NO cookie', !('cookie' in h))

  console.log('\n--- Completion body ---')
  const body = buildAndroidCompletionRequest(
    { chat_session_id: 'sess-1', parent_message_id: null },
    'hello',
    { model_type: 'default', thinking_enabled: true, search_enabled: true }
  )
  const order = Object.keys(body)
  const expectedOrder = ['chat_session_id','parent_message_id','prompt','ref_file_ids','thinking_enabled','search_enabled','audio_id','preempt','model_type','action']
  check('field order matches capture', JSON.stringify(order) === JSON.stringify(expectedOrder), JSON.stringify(order))
  check('audio_id === null', body.audio_id === null)
  check('ref_file_ids === []', Array.isArray(body.ref_file_ids) && body.ref_file_ids.length === 0)
  check('preempt === false', body.preempt === false)
  check('action === null', body.action === null)
  check('serialized has audio_id:null', JSON.stringify(body).includes('"audio_id":null'))
  check('parent_message_id passes through', buildAndroidCompletionRequest({ chat_session_id: 's', parent_message_id: 42 }, 'x', { model_type: 'default', thinking_enabled: false, search_enabled: false }).parent_message_id === 42)

  console.log('\n--- PoW / HIF ---')
  check('shared solvePow exported', typeof solvePow === 'function')
  check('shared encodePowResponse exported', typeof encodePowResponse === 'function')

  // Build a genuinely solvable challenge using the shared hash so the client's
  // PoW path runs end-to-end without duplicating the algorithm.
  const powSalt = 'fixturesalt'
  const powExpireAt = 1
  const powChallenge = computePowHash(`${powSalt}_${powExpireAt}_0`)

  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push(url)
    if (url.includes('create_pow_challenge')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: powChallenge, salt: powSalt, signature: 'sig', difficulty: 1, expire_at: powExpireAt, target_path: '/api/v0/chat/completion' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/chat/completion')) {
      const s = 'event: ready\ndata: {"request_message_id":1,"response_message_id":9,"model_type":"default"}\n\n'
      return new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any

  try {
    const stateStore = new MemoryStateStore()
    await stateStore.set(PROTOCOL_STATE_KEYS.AUTH, JSON.stringify({ authorizationToken: 'Bearer test-token' }))
    const sessionStore = new MemorySessionStore()
    await sessionStore.set('xsess', { x_session_id: 'xsess', chat_session_id: 'chat-1', parent_message_id: 5, turn_count: 4, created_at: 1, updated_at: 1 })
    const client = new DeepSeekAndroidClient({ stateStore, sessionStore })
    const result = await client.completeWithAutoSession({ prompt: 'hi', model_type: 'default', thinking_enabled: false, search_enabled: false, xSessionId: 'xsess' })
    // Drain the response stream; session persistence runs as the body is read.
    await result.response.text()
    await result.sessionUpdatePromise
    check('android flow requested pow challenge', calls.some(u => u.includes('create_pow_challenge')))
    check('android flow requested completion', calls.some(u => u.includes('/chat/completion')))
    check('android flow NEVER requested hif-leim', !calls.some(u => u.includes('hif-leim')), calls.join(','))
    check('used existing session (chat session create not called)', !calls.some(u => u.includes('chat_session/create')))
    const persisted = await sessionStore.get('xsess')
    check('session turn_count incremented', persisted?.turn_count === 5, String(persisted?.turn_count))
    check('session parent_message_id persisted from ready event', persisted?.parent_message_id === 9, String(persisted?.parent_message_id))
  } finally {
    globalThis.fetch = realFetch
  }

  // --- Android edit_message ---
  console.log('\n--- Android edit_message ---')
  const editCalls: { url: string; headers: Record<string, string>; body: string }[] = []
  const realFetchEdit = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const hdrs: Record<string, string> = {}
    if (init?.headers) {
      const hh = init.headers as any
      if (typeof hh.forEach === 'function') hh.forEach((v: string, k: string) => { hdrs[k.toLowerCase()] = v })
      else Object.entries(hh).forEach(([k, v]) => { hdrs[k.toLowerCase()] = String(v) })
    }
    editCalls.push({ url, headers: hdrs, body: typeof init?.body === 'string' ? init.body : '' })
    if (url.includes('create_pow_challenge')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: powChallenge, salt: powSalt, signature: 'sig', difficulty: 1, expire_at: powExpireAt, target_path: '/api/v0/chat/completion' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('edit_message')) {
      const s = 'event: ready\ndata: {"request_message_id":20,"response_message_id":21,"model_type":"default"}\n\n'
      return new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any

  try {
    const stateStore = new MemoryStateStore()
    await stateStore.set(PROTOCOL_STATE_KEYS.AUTH, JSON.stringify({ authorizationToken: 'Bearer test-token' }))
    const sessionStore = new MemorySessionStore()
    await sessionStore.set('xsess', { x_session_id: 'xsess', chat_session_id: 'chat-9', parent_message_id: 7, turn_count: 3, created_at: 1, updated_at: 1 })
    const client = new DeepSeekAndroidClient({ stateStore, sessionStore })
    const result = await client.editMessage('xsess', 7, 'edited prompt', { thinking_enabled: true, search_enabled: false })
    await result.response.text()
    await result.sessionUpdatePromise

    const editReq = editCalls.find(c => c.url.includes('edit_message'))!
    check('edit_message requested', !!editReq)
    check('edit_message uses android platform', editReq.headers['x-client-platform'] === 'android')
    check('edit_message has x-ds-pow-response', !!editReq.headers['x-ds-pow-response'])
    check('edit_message NO x-hif-leim', !('x-hif-leim' in editReq.headers))
    check('edit_message NO origin', !('origin' in editReq.headers))
    check('edit_message NO referer', !('referer' in editReq.headers))
    check('edit_message NO cookie', !('cookie' in editReq.headers))
    check('edit_message body has message_id', JSON.parse(editReq.body).message_id === 7)
    check('edit_message body has chat_session_id', JSON.parse(editReq.body).chat_session_id === 'chat-9')
    check('edit_message never called hif-leim', !editCalls.some(c => c.url.includes('hif-leim')))
    const persisted = await sessionStore.get('xsess')
    check('edit_message persisted response_message_id', persisted?.parent_message_id === 21, String(persisted?.parent_message_id))

    // Captured Android edit body shape and field order.
    const eb = JSON.parse(editReq.body)
    check('edit_message field order matches capture',
      JSON.stringify(Object.keys(eb)) === JSON.stringify(['chat_session_id','message_id','prompt','ref_file_ids','thinking_enabled','search_enabled','client_stream_id','action']),
      JSON.stringify(Object.keys(eb)))
    check('edit_message has client_stream_id', typeof eb.client_stream_id === 'string' && /^\d{8}-[0-9a-f]{16}$/.test(eb.client_stream_id), String(eb.client_stream_id))
    check('edit_message action === null', eb.action === null)
  } finally {
    globalThis.fetch = realFetchEdit
  }

  // --- Android create_session (empty body) ---
  console.log('\n--- Android create_session ---')
  const createCalls: { url: string; body: string; headers: Record<string, string> }[] = []
  const realFetchCreate = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const hdrs: Record<string, string> = {}
    if (init?.headers) {
      const hh = init.headers as any
      if (typeof hh.forEach === 'function') hh.forEach((v: string, k: string) => { hdrs[k.toLowerCase()] = v })
      else Object.entries(hh).forEach(([k, v]) => { hdrs[k.toLowerCase()] = String(v) })
    }
    createCalls.push({ url, body: typeof init?.body === 'string' ? init.body : (init?.body == null ? '<none>' : String(init.body)), headers: hdrs })
    if (url.includes('chat_session/create')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'new-sess-1' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
  try {
    const stateStore = new MemoryStateStore()
    await stateStore.set(PROTOCOL_STATE_KEYS.AUTH, JSON.stringify({ authorizationToken: 'Bearer test-token' }))
    const sessionStore = new MemorySessionStore()
    const client = new DeepSeekAndroidClient({ stateStore, sessionStore })
    const session = await client.createSession()
    const cc = createCalls.find(c => c.url.includes('chat_session/create'))!
    check('create_session requested', !!cc)
    check('create_session body is empty', cc.body === '' , JSON.stringify(cc.body))
    check('create_session content-type json', cc.headers['content-type'] === 'application/json')
    check('create_session android platform', cc.headers['x-client-platform'] === 'android')
    check('create_session no x-ds-pow-response', !('x-ds-pow-response' in cc.headers))
    check('create_session returned id', session.id === 'new-sess-1')
  } finally {
    globalThis.fetch = realFetchCreate
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
