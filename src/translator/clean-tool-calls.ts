export interface CleanToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface CleanParseResult {
  toolCalls: CleanToolCall[]
  isMalformed?: boolean
  error?: { message: string; syntaxRules: string }
}

const CORRECTIVE_MESSAGE = `Invalid tool call form.

These tool-call delimiters are not accepted:

- "｜｜DSML｜｜"
- "｜DSML｜｜"
- "｜DSML｜"
- "||DSML||"

Here is a valid tool-call example:

Please try again.`

function malformed(message: string): CleanParseResult {
  return { toolCalls: [], isMalformed: true, error: { message, syntaxRules: CORRECTIVE_MESSAGE } }
}

function parseAttributes(source: string): { name?: string; stringMode?: 'true' | 'false'; malformed?: string } {
  let rest = source.trim()
  const attrs: Record<string, string> = {}
  while (rest.length > 0) {
    const match = rest.match(/^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"(?:(?:\s+)|$)/)
    if (!match) return { malformed: 'Malformed parameter attributes' }
    const [, key, value] = match
    if (key in attrs) return { malformed: `Duplicate attribute "${key}"` }
    attrs[key] = value
    rest = rest.slice(match[0].length).trim()
  }

  if (attrs.name === undefined && Object.keys(attrs).length > 0) {
    return { malformed: 'Parameter name attribute is required' }
  }
  if (attrs.name !== undefined && Object.keys(attrs).some(key => key !== 'name' && key !== 'string')) {
    return { malformed: 'Malformed parameter attributes' }
  }
  if (attrs.string !== undefined && attrs.string !== 'true' && attrs.string !== 'false') {
    return { malformed: 'string attribute must be "true" or "false"' }
  }
  return {
    name: attrs.name,
    stringMode: attrs.string as 'true' | 'false' | undefined,
  }
}

export function parseCleanToolCalls(input: string): CleanParseResult {
  const callsOpen = '<calls>'
  const callsClose = '</calls>'
  if (!input.includes(callsOpen) && !input.includes(callsClose)) return { toolCalls: [] }

  const firstOpen = input.indexOf(callsOpen)
  if (firstOpen < 0) return malformed('Unexpected </calls> without an opening <calls> tag')
  if (input.indexOf(callsOpen, firstOpen + callsOpen.length) !== -1) {
    return malformed('Nested <calls> blocks are not allowed')
  }

  const firstClose = input.indexOf(callsClose, firstOpen + callsOpen.length)
  if (firstClose < 0) return malformed('Missing closing </calls> tag')
  if (input.indexOf(callsClose, firstClose + callsClose.length) !== -1) {
    return malformed('Multiple <calls> blocks are not allowed')
  }
  if (input.slice(0, firstOpen).trim() !== '' || input.slice(firstClose + callsClose.length).trim() !== '') {
    return malformed('Unexpected content outside <calls> block')
  }

  const body = input.slice(firstOpen + callsOpen.length, firstClose)
  const toolCalls: CleanToolCall[] = []
  let pos = 0

  const skipWhitespace = () => {
    while (pos < body.length && /\s/.test(body[pos])) pos++
  }

  while (pos < body.length) {
    skipWhitespace()
    if (pos >= body.length) break
    if (!body.startsWith('<invoke', pos)) {
      if (body[pos] === '<') return malformed('Unexpected structural element inside <calls>')
      return malformed('Unexpected text inside <calls>; only <invoke> elements are allowed')
    }

    const invokeStart = body.indexOf('>', pos)
    if (invokeStart < 0) return malformed('Unclosed <invoke> tag')
    const openTag = body.slice(pos, invokeStart + 1)
    const nameMatch = openTag.match(/^<invoke\s+name="([^"]+)"\s*>$/)
    if (!nameMatch || !nameMatch[1].trim() || !/^[A-Za-z0-9_.-]+$/.test(nameMatch[1])) {
      return malformed('Invoke is missing a valid tool name')
    }

    const toolName = nameMatch[1]
    const contentStart = invokeStart + 1
    const closeInvoke = body.indexOf('</invoke>', contentStart)
    if (closeInvoke < 0) return malformed('Missing closing </invoke> tag')
    const invokeBody = body.slice(contentStart, closeInvoke)
    const trailingInvoke = invokeBody.match(/<\/invoke>/)
    if (trailingInvoke) return malformed('Invalid nested <invoke> structure')

    let innerPos = 0
    const params: Record<string, unknown> = {}
    while (innerPos < invokeBody.length) {
      while (innerPos < invokeBody.length && /\s/.test(invokeBody[innerPos])) innerPos++
      if (innerPos >= invokeBody.length) break
      if (!invokeBody.startsWith('<parameter', innerPos)) {
        if (invokeBody[innerPos] === '<') return malformed('Unexpected structural element inside <invoke>')
        return malformed('Unexpected text inside <invoke>; only <parameter> elements are allowed')
      }

      const parameterStart = invokeBody.indexOf('>', innerPos)
      if (parameterStart < 0) return malformed('Unclosed <parameter> tag')
      const parameterTag = invokeBody.slice(innerPos, parameterStart + 1)
      const parameterMatch = parameterTag.match(/^<parameter\s+([\s\\S]*?)\s*>$/)
      if (!parameterMatch) return malformed('Malformed parameter attributes')
      const attributes = parseAttributes(parameterMatch[1])
      if (attributes.malformed) return malformed(attributes.malformed)
      if (!attributes.name || attributes.name.trim() === '') return malformed('Parameter name is empty or missing')

      const parameterClose = invokeBody.indexOf('</parameter>', parameterStart + 1)
      if (parameterClose < 0) return malformed(`Missing closing </parameter> tag for parameter "${attributes.name}"`)
      const value = invokeBody.slice(parameterStart + 1, parameterClose)

      if (Object.prototype.hasOwnProperty.call(params, attributes.name)) {
        return malformed(`Duplicate parameter "${attributes.name}"`)
      }
      if (attributes.stringMode === 'false') {
        try {
          params[attributes.name] = JSON.parse(value.trim())
        } catch {
          return malformed(`Parameter "${attributes.name}" has string="false" but value is not valid JSON`)
        }
      } else {
        params[attributes.name] = value
      }
      innerPos = parameterClose + '</parameter>'.length
    }

    toolCalls.push({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(params) },
    })
    pos = closeInvoke + '</invoke>'.length
  }

  if (toolCalls.length === 0) return malformed('<calls> block must contain at least one <invoke> element')
  return { toolCalls }
}

export { CORRECTIVE_MESSAGE }
