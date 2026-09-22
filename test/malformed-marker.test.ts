// Regression tests for malformed CODEEP_CALL marker detection and correction.
//
// Case under test: the model emits a marker variant such as
//   CODEEP_CODEEP_CALL
//   {"name":"read","arguments":{...}}
//   END_CODEEP_CALL
// The exact valid marker is not at line start, so the parser must NOT treat it
// as a tool call, but it MUST flag it as a malformed tool attempt so the
// inbound layer emits the correction tool call instead of silently rendering
// the malformed block as text.

import { parseDeepSeekSSE, type ParserEvent } from '../src/parser/index.js'
import { translateParserEventsToSSE } from '../src/translator/inbound.js'

const S = 'CODEEP' + '_CALL'
const E = 'END_' + 'CODEEP_CALL'

function ev(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
function frag(v: string): string {
  return ev('p', { p: 'response/fragments/-1/content', o: 'APPEND', v })
}
function makeStream(text: string): ReadableStream<Uint8Array> {
  const b = new TextEncoder().encode(text)
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < b.length) { c.enqueue(b.slice(i, i + 13)); i += 13 }
      else c.close()
    },
  })
}
async function decode(s: ReadableStream<Uint8Array>): Promise<string> {
  const r = s.getReader(); const d = new TextDecoder(); let o = ''
  while (true) { const { done, value } = await r.read(); if (done) break; o += d.decode(value, { stream: true }) }
  return o + d.decode()
}

const prefix = ev('ready', { response_message_id: 1 }) + ev('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })
const finish = ev('p', { p: 'response/status', o: 'SET', v: 'FINISHED' }) + ev('close', {})

async function parserSnapshot(body: string): Promise<{ types: string[]; malformed: boolean; content: string; toolCalls: number }> {
  const evs: ParserEvent[] = []
  for await (const e of parseDeepSeekSSE(makeStream(prefix + frag(body) + finish))) evs.push(e)
  const done = evs.find(e => e.type === 'done') as any
  return {
    types: evs.map(e => e.type),
    malformed: done?.state?.hasMalformedToolSyntax === true,
    content: done?.state?.accumulatedContent ?? '',
    toolCalls: evs.filter(e => e.type === 'tool_calls').length,
  }
}

interface WireChunk { kind: string; finish: string | null; error: unknown; name?: string; args?: string }
function wireChunks(sse: string): WireChunk[] {
  const out: WireChunk[] = []
  for (const b of sse.split('\n\n')) {
    if (!b.startsWith('data: ')) continue
    const p = b.slice(6)
    if (p === '[DONE]') { out.push({ kind: '[DONE]', finish: null, error: null }); continue }
    const j = JSON.parse(p); const d = j.choices?.[0]?.delta ?? {}; const tc = d.tool_calls?.[0]
    out.push({
      kind: tc ? 'tool_calls' : d.content !== undefined ? 'content' : d.reasoning_content !== undefined ? 'reasoning' : 'empty',
      finish: j.choices?.[0]?.finish_reason ?? null,
      error: j.error ?? null,
      name: tc?.function?.name,
      args: tc?.function?.arguments,
    })
  }
  return out
}
async function inbound(body: string): Promise<WireChunk[]> {
  const stream = await translateParserEventsToSSE(
    parseDeepSeekSSE(makeStream(prefix + frag(body) + finish)),
    { model: 'm', id: 'x', created: 1 }
  )
  return wireChunks(await decode(stream))
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`PASS: ${name}`) }
  else { fail++; console.log(`FAIL: ${name} ${detail}`) }
}

async function main() {
  console.log('Running malformed marker tests...\n')

  // 1. Valid call still works.
  const validBody = `${S}\n{"name":"read","arguments":{"filePath":"a.txt"}}\n${E}`
  const valid = await parserSnapshot(validBody)
  check('valid call emits tool_calls', valid.toolCalls === 1)
  check('valid call NOT flagged malformed', valid.malformed === false)

  // 2. The exact reported failure: CODEEP_ prefix doubling.
  const malformedBody = `CODEEP_${S}\n{"name":"read","arguments":{"filePath":"a.txt"}}\n${E}`
  const malformed = await parserSnapshot(malformedBody)
  check('CODEEP_CODEEP_CALL does not emit tool_calls', malformed.toolCalls === 0, JSON.stringify(malformed.types))
  check('CODEEP_CODEEP_CALL flagged malformed', malformed.malformed === true)
  check('CODEEP_CODEEP_CALL preserved as content', malformed.content.includes('CODEEP_CODEEP_CALL'))

  // 3. Inbound correction fires for the malformed case.
  const mw = await inbound(malformedBody)
  check('malformed: no error field', mw.every(c => c.error === null))
  check('malformed: correction bash emitted', mw.some(c => c.kind === 'tool_calls' && c.name === 'bash'))
  check('malformed: finish_reason tool_calls', mw.find(c => c.finish !== null)?.finish === 'tool_calls')
  check('malformed: correction args are valid JSON', (() => {
    const c = mw.find(x => x.name === 'bash')
    if (!c?.args) return false
    try { JSON.parse(c.args); return true } catch { return false }
  })())

  // 4. Prose mid-line mention must NOT be flagged.
  const prose = await parserSnapshot('You should use the CODEEP_CALL marker in your reply.')
  check('mid-line prose mention not flagged', prose.malformed === false)
  check('mid-line prose emits no tool_calls', prose.toolCalls === 0)

  // 5. Line-start marker without a following JSON object must NOT be flagged.
  const noBrace = await parserSnapshot(`Example:\n${S}\nnot json at all`)
  check('line-start marker without brace not flagged', noBrace.malformed === false, `content=${JSON.stringify(noBrace.content)}`)
  check('line-start marker without brace emits no tool_calls', noBrace.toolCalls === 0)

  // 6. Valid call must NOT produce a bash correction.
  const vw = await inbound(validBody)
  check('valid: read tool call emitted', vw.some(c => c.kind === 'tool_calls' && c.name === 'read'))
  check('valid: no bash correction', !vw.some(c => c.name === 'bash'))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
