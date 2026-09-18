import { parseCleanToolCalls } from '../src/translator/clean-tool-calls.js'
import { translateDeepSeekStreamToJSON } from '../src/translator/response.js'

function makeSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  console.log(`PASS: ${name}`)
}

async function main(): Promise<void> {
  await run('single clean invoke', () => {
    const result = parseCleanToolCalls('<calls><invoke name="read"><parameter name="filePath">README.md</parameter></invoke></calls>')
    if (result.isMalformed || result.toolCalls.length !== 1) throw new Error('single invoke was not parsed')
    if (result.toolCalls[0].function.name !== 'read') throw new Error('tool name was not preserved')
    if (result.toolCalls[0].function.arguments !== JSON.stringify({ filePath: 'README.md' })) throw new Error('arguments were not preserved')
  })

  await run('multiple invokes preserve order', () => {
    const result = parseCleanToolCalls('<calls>\n<invoke name="list"></invoke>\n<invoke name="read"><parameter name="path">a.txt</parameter></invoke>\n</calls>')
    if (result.isMalformed || result.toolCalls.length !== 2) throw new Error('multiple invokes were not parsed')
    if (result.toolCalls[0].function.name !== 'list' || result.toolCalls[1].function.name !== 'read') throw new Error('invoke order changed')
  })

  await run('multiple parameters preserve values', () => {
    const value = 'line 1\nline 2\nC:\\Users\\Damas\\notes.txt\nconst x = 1;'
    const result = parseCleanToolCalls(`<calls><invoke name="write"><parameter name="path">C:\\Users\\Damas\\notes.txt</parameter><parameter name="content">${value}</parameter></invoke></calls>`)
    if (result.isMalformed) throw new Error(result.error?.message)
    const args = JSON.parse(result.toolCalls[0].function.arguments) as Record<string, unknown>
    if (args.path !== 'C:\\Users\\Damas\\notes.txt' || args.content !== value) throw new Error('parameter values were changed')
  })

  await run('zero parameters are valid', () => {
    const result = parseCleanToolCalls('<calls><invoke name="ping"></invoke></calls>')
    if (result.isMalformed || result.toolCalls.length !== 1) throw new Error('zero-parameter invoke was rejected')
    if (result.toolCalls[0].function.arguments !== '{}') throw new Error('zero-parameter arguments were not {}')
  })

  await run('string=true preserves raw content exactly', () => {
    const value = '  first line\n  second line  '
    const result = parseCleanToolCalls(`<calls><invoke name="write"><parameter name="content" string="true">${value}</parameter></invoke></calls>`)
    if (result.isMalformed) throw new Error(result.error?.message)
    const args = JSON.parse(result.toolCalls[0].function.arguments) as Record<string, unknown>
    if (args.content !== value) throw new Error('raw string whitespace was changed')
  })

  await run('string=false parses trimmed JSON', () => {
    const result = parseCleanToolCalls('<calls><invoke name="run"><parameter name="args" string="false">\n  ["a", 2, true]\n</parameter></invoke></calls>')
    if (result.isMalformed) throw new Error(result.error?.message)
    const args = JSON.parse(result.toolCalls[0].function.arguments) as Record<string, unknown>
    if (JSON.stringify(args.args) !== JSON.stringify(['a', 2, true])) throw new Error('JSON parameter was not parsed')
  })

  await run('missing string attribute is raw string', () => {
    const result = parseCleanToolCalls('<calls><invoke name="write"><parameter name="content">  keep me  </parameter></invoke></calls>')
    if (result.isMalformed) throw new Error(result.error?.message)
    const args = JSON.parse(result.toolCalls[0].function.arguments) as Record<string, unknown>
    if (args.content !== '  keep me  ') throw new Error('omitted string attribute was not treated as raw')
  })

  const malformedCases: Array<[string, string]> = [
    ['missing calls close', '<calls><invoke name="read"></invoke>'],
    ['missing invoke close', '<calls><invoke name="read">'],
    ['missing parameter close', '<calls><invoke name="read"><parameter name="x">value</invoke></calls>'],
    ['parameter outside invoke', '<calls><parameter name="x">value</parameter></calls>'],
    ['empty invoke name', '<calls><invoke name=""></invoke></calls>'],
    ['malformed parameter attributes', '<calls><invoke name="read"><parameter name="x" nope="true">v</parameter></invoke></calls>'],
    ['invalid false JSON', '<calls><invoke name="run"><parameter name="x" string="false">not-json</parameter></invoke></calls>'],
    ['invalid nesting', '<calls><invoke name="a"><invoke name="b"></invoke></invoke></calls>'],
    ['empty calls', '<calls></calls>'],
  ]

  for (const [name, input] of malformedCases) {
    await run(`malformed clean call: ${name}`, () => {
      const result = parseCleanToolCalls(input)
      if (!result.isMalformed || result.toolCalls.length !== 0 || !result.error) throw new Error('malformed call was accepted')
    })
  }

  const forbiddenMarkers = ['｜｜DSML｜｜', '｜DSML｜｜', '｜DSML｜', '||DSML||']
  for (const marker of forbiddenMarkers) {
    await run(`DSML marker rejected: ${marker}`, async () => {
      const content = `<${marker} calls><${marker} invoke name="read"></${marker} invoke></${marker} calls>`
      const stream = createSSEStream([
        makeSSEEvent('ready', { response_message_id: 123 }),
        makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content }] } } }),
        makeSSEEvent('close', {}),
      ])
      const result = await translateDeepSeekStreamToJSON(stream, { model: 'test', id: 'chatcmpl-1', created: 1 })
      if (!result._malformedError) throw new Error('DSML marker did not reach parse-error path')
      if ('tool_calls' in result.choices[0].message) throw new Error('DSML produced client-facing tool calls')
      if (result._malformedError.syntaxRules !== 'Invalid tool call form.\n\nThese tool-call delimiters are not accepted:\n\n- "｜｜DSML｜｜"\n- "｜DSML｜｜"\n- "｜DSML｜"\n- "||DSML||"\n\nHere is a valid tool-call example:\n\nPlease try again.') throw new Error('unexpected corrective message')
    })
  }

  await run('clean calls become OpenAI tool_calls', async () => {
    const content = '<calls><invoke name="read"><parameter name="filePath">README.md</parameter></invoke><invoke name="list"></invoke></calls>'
    const stream = createSSEStream([
      makeSSEEvent('ready', { response_message_id: 123 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content }] } } }),
      makeSSEEvent('close', {}),
    ])
    const result = await translateDeepSeekStreamToJSON(stream, { model: 'test', id: 'chatcmpl-1', created: 1 })
    const calls = result.choices[0].message.tool_calls
    if (result._malformedError || !calls || calls.length !== 2) throw new Error('clean calls were not translated')
    if (calls[0].function.name !== 'read' || calls[1].function.name !== 'list') throw new Error('tool call order was not preserved')
  })

  await run('streaming clean calls become OpenAI tool_calls', async () => {
    const stream = createSSEStream([
      makeSSEEvent('ready', { response_message_id: 123 }),
      makeSSEEvent('update_session', { v: { response: { fragments: [{ type: 'RESPONSE', content: '<calls><invoke name="read">' }] } } }),
      makeSSEEvent('p', { p: 'response/fragments/-1/content', o: 'APPEND', v: '<parameter name="filePath">README.md</parameter></invoke></calls>' }),
      makeSSEEvent('close', {}),
    ])
    const result = await import('../src/translator/response.js').then(({ translateDeepSeekStreamToSSE }) =>
      translateDeepSeekStreamToSSE(stream, { model: 'test', id: 'chatcmpl-1', created: 1 })
    )
    if (result.parseError) throw new Error(result.parseError.message)
    const reader = result.stream.getReader()
    const decoder = new TextDecoder()
    let output = ''
    while (true) {
      const item = await reader.read()
      if (item.done) break
      output += decoder.decode(item.value, { stream: true })
    }
    output += decoder.decode()
    if (!output.includes('"tool_calls"') || !output.includes('"read"')) throw new Error('streaming clean calls were not emitted')
  })

  console.log('All clean tool-call tests passed.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
