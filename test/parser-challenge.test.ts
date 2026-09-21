import { parseDeepSeekSSE, type ParserEvent } from '../src/parser/index.js'

const S = 'CODEEP' + '_CALL'
const E = 'END_' + 'CODEEP_CALL'

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
function frag(v: string): string {
  return sse('p', { p: 'response/fragments/-1/content', o: 'APPEND', v })
}
const prefix = sse('ready', { response_message_id: 1 }) + sse('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })

async function parse(input: string, chunkSize = 100000): Promise<ParserEvent[]> {
  const enc = new TextEncoder()
  const bytes = enc.encode(input)
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < bytes.length) {
        const end = Math.min(i + chunkSize, bytes.length)
        c.enqueue(bytes.slice(i, end)); i = end
      } else c.close()
    },
  })
  const out: ParserEvent[] = []
  for await (const e of parseDeepSeekSSE(stream)) out.push(e)
  return out
}

const text = (ev: ParserEvent[]) => ev.filter(e => e.type === 'content').map(e => (e as any).content).join('')
const calls = (ev: ParserEvent[]) => ev.flatMap(e => e.type === 'tool_calls' ? (e as any).toolCalls : [])
const errors = (ev: ParserEvent[]) => ev.flatMap(e => e.type === 'error' ? [(e as any).error] : []).concat(ev.flatMap(e => e.type === 'done' && (e as any).state.parseError ? [(e as any).state.parseError] : []))

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`PASS: ${name}`) }
  else { fail++; console.log(`FAIL: ${name} ${detail}`) }
}

async function main() {
  const basic = prefix + frag(`Here you go.\n${S}\n{"name":"read","arguments":{"filePath":"a.txt"}}\n${E}`) + sse('close', {})
  let ev = await parse(basic)
  check('basic single call', calls(ev).length === 1 && calls(ev)[0].function.name === 'read')
  check('basic content before preserved', text(ev).includes('Here you go.'))

  ev = await parse(basic, 1)
  check('basic char-by-char streaming', calls(ev).length === 1 && calls(ev)[0].function.name === 'read', `calls=${calls(ev).length}`)

  const two = prefix + frag(`${S}\n{"name":"a","arguments":{}}\n${E}\n${S}\n{"name":"b","arguments":{}}\n${E}`) + sse('close', {})
  ev = await parse(two)
  check('two sequential calls', calls(ev).length === 2 && calls(ev)[0].function.name === 'a' && calls(ev)[1].function.name === 'b', `got ${calls(ev).length}`)
  ev = await parse(two, 1)
  check('two calls char-by-char', calls(ev).length === 2, `got ${calls(ev).length}`)

  const trail = prefix + frag(`${S}\n{"name":"read","arguments":{}}\n${E}\nThen some trailing prose.`) + sse('close', {})
  ev = await parse(trail)
  check('trailing prose after call preserved', text(ev).includes('trailing prose'), `text=${JSON.stringify(text(ev))}`)

  const crlf = prefix + frag(`${S}\r\n{"name":"read","arguments":{}}\r\n${E}`) + sse('close', {})
  ev = await parse(crlf)
  check('CRLF between marker and brace', calls(ev).length === 1)

  const atStart = prefix + frag(`${S}\n{"name":"read","arguments":{}}\n${E}`) + sse('close', {})
  ev = await parse(atStart)
  check('marker at absolute start', calls(ev).length === 1)

  const escaped = prefix + frag(`${S}\n{"name":"write","arguments":{"content":"say \\"hi\\" and ${E} text"}}\n${E}`) + sse('close', {})
  ev = await parse(escaped)
  check('escaped quotes + in-string END', calls(ev).length === 1 && JSON.parse(calls(ev)[0].function.arguments).content.includes(E + ' text'), `calls=${calls(ev).length}`)

  const nested = prefix + frag(`${S}\n{"name":"w","arguments":{"o":{"a":[1,2,{"b":"${E}"}]}}}\n${E}`) + sse('close', {})
  ev = await parse(nested)
  check('nested arrays/objects + in-string END', calls(ev).length === 1, `calls=${calls(ev).length}`)

  const missingName = prefix + frag(`${S}\n{"arguments":{}}\n${E}`) + sse('close', {})
  ev = await parse(missingName)
  check('missing name -> error surfaced', errors(ev).length >= 1, `errors=${errors(ev).length} calls=${calls(ev).length}`)

  const missingArgs = prefix + frag(`${S}\n{"name":"x"}\n${E}`) + sse('close', {})
  ev = await parse(missingArgs)
  check('missing arguments -> error surfaced', errors(ev).length >= 1, `errors=${errors(ev).length}`)

  const unclosed = prefix + frag(`${S}\n{"name":"read","arguments":{"filePath":"a"}}`) + sse('close', {})
  ev = await parse(unclosed)
  check('unclosed block -> error surfaced', errors(ev).length >= 1, `errors=${errors(ev).length}`)
  check('unclosed block -> no phantom call', calls(ev).length === 0, `calls=${calls(ev).length}`)

  const prose = prefix + frag(`Use the ${S} marker carefully.`) + sse('close', {})
  ev = await parse(prose)
  check('mid-line mention not a call', calls(ev).length === 0 && text(ev).includes('marker carefully'))

  const noBrace = prefix + frag(`example:\n${S}\nnot json`) + sse('close', {})
  ev = await parse(noBrace)
  check('line-start marker no brace -> text', calls(ev).length === 0 && text(ev).includes('not json'), `text=${JSON.stringify(text(ev))}`)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}
main()
