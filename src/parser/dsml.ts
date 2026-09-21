import type { ToolCall, ParserError } from './types.js'

type DSMLDelimiter = 'single' | 'double' | 'mixed' | 'ascii'
type DSMLWrapper = 'function_calls' | 'tool_calls' | 'calls' | 'toolcalls' | 'tool'

interface DSMLDialect {
  delimiter: DSMLDelimiter
  wrapper: DSMLWrapper
  openCalls: string
  closeCalls: string
  openInvoke: string
  closeInvoke: string
  openParameter: string
  closeParameter: string
}

const DELIMITER_PATTERNS: Record<DSMLDelimiter, { prefix: string }> = {
  single: { prefix: '<｜DSML｜' },
  double: { prefix: '<｜｜DSML｜｜' },
  mixed: { prefix: '<｜DSML｜｜' },
  ascii: { prefix: '<||DSML||' },
}

const WRAPPER_NAMES: DSMLWrapper[] = ['function_calls', 'tool_calls', 'calls', 'toolcalls', 'tool']

function generateAllDialects(): DSMLDialect[] {
  const dialects: DSMLDialect[] = []
  for (const [delimiterKey, { prefix }] of Object.entries(DELIMITER_PATTERNS) as [DSMLDelimiter, { prefix: string }][]) {
    for (const wrapper of WRAPPER_NAMES) {
      const openCallsWithSpace = `${prefix} ${wrapper}>`
      const openCallsNoSpace = `${prefix}${wrapper}>`
      const closeCallsWithSpace = `</${prefix.slice(1)} ${wrapper}>`
      const closeCallsNoSpace = `</${prefix.slice(1)}${wrapper}>`
      const openInvokeWithSpace = `${prefix} invoke`
      const openInvokeNoSpace = `${prefix}invoke`
      const closeInvokeWithSpace = `</${prefix.slice(1)} invoke>`
      const closeInvokeNoSpace = `</${prefix.slice(1)}invoke>`
      const openParameterWithSpace = `${prefix} parameter`
      const openParameterNoSpace = `${prefix}parameter`
      const closeParameterWithSpace = `</${prefix.slice(1)} parameter>`
      const closeParameterNoSpace = `</${prefix.slice(1)}parameter>`
      
      dialects.push({
        delimiter: delimiterKey,
        wrapper,
        openCalls: openCallsWithSpace,
        closeCalls: closeCallsWithSpace,
        openInvoke: openInvokeWithSpace,
        closeInvoke: closeInvokeWithSpace,
        openParameter: openParameterWithSpace,
        closeParameter: closeParameterWithSpace,
      })
      dialects.push({
        delimiter: delimiterKey,
        wrapper,
        openCalls: openCallsNoSpace,
        closeCalls: closeCallsNoSpace,
        openInvoke: openInvokeNoSpace,
        closeInvoke: closeInvokeNoSpace,
        openParameter: openParameterNoSpace,
        closeParameter: closeParameterNoSpace,
      })
    }
  }
  return dialects
}

const ALL_DIALECTS = generateAllDialects()

function getAllOpenCallsPatterns(): string[] {
  return ALL_DIALECTS.map(d => d.openCalls)
}

function getAllCloseCallsPatterns(): string[] {
  return ALL_DIALECTS.map(d => d.closeCalls)
}

function getAllCloseInvokePatterns(): string[] {
  return ALL_DIALECTS.map(d => d.closeInvoke)
}

function getAllCloseParameterPatterns(): string[] {
  return ALL_DIALECTS.map(d => d.closeParameter)
}

function getHoldbackPatterns(): string[] {
  return ALL_DIALECTS.map(d => d.openCalls)
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function detectDialect(xml: string): DSMLDialect | null {
  for (const dialect of ALL_DIALECTS) {
    if (xml.includes(dialect.openCalls)) {
      return dialect
    }
  }
  return null
}

function detectInvokeDialect(xml: string): DSMLDialect | null {
  for (const dialect of ALL_DIALECTS) {
    const invokePattern = new RegExp(escapeRegExp(dialect.openInvoke) + '\\s+name="[^"]+"')
    if (invokePattern.test(xml)) {
      return dialect
    }
  }
  return null
}

function wrapWithSyntheticCalls(xml: string, dialect: DSMLDialect): string {
  return `${dialect.openCalls}${xml}${dialect.closeCalls}`
}

function normalizeToCanonical(xml: string, dialect: DSMLDialect): string {
  let normalized = xml
  
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.openCalls), 'g'), '<｜｜DSML｜｜ calls>')
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.closeCalls), 'g'), '</｜｜DSML｜｜ calls>')
  
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.openInvoke), 'g'), '<｜｜DSML｜｜ invoke')
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.closeInvoke), 'g'), '</｜｜DSML｜｜ invoke>')
  
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.openParameter), 'g'), '<｜｜DSML｜｜ parameter')
  normalized = normalized.replace(new RegExp(escapeRegExp(dialect.closeParameter), 'g'), '</｜｜DSML｜｜ parameter>')
  
  return normalized
}

const DSML_CORRECTIVE_MESSAGE_TEMPLATE = `Your previous response contained a malformed tool call.
The tool call was NOT executed.

Parsing error:
{{PARSER_ERROR}}

Please correct the structural error and retry the tool call.`

function buildCorrectiveMessage(parserError: string): string {
  return DSML_CORRECTIVE_MESSAGE_TEMPLATE.replace('{{PARSER_ERROR}}', parserError)
}

export interface DSMLParseResult {
  toolCalls: ToolCall[]
  isMalformed?: boolean
  error?: ParserError
}

export { ALL_DIALECTS, buildCorrectiveMessage, getHoldbackPatterns, type DSMLDialect, type DSMLDelimiter, type DSMLWrapper, DSML_CORRECTIVE_MESSAGE_TEMPLATE }

export function parseDSMLToolCalls(xml: string): DSMLParseResult {
  const toolCalls: ToolCall[] = []
  
  let dialect = detectDialect(xml)
  let normalizedXml: string

  if (!dialect) {
    const invokeDialect = detectInvokeDialect(xml)
    if (invokeDialect) {
      const openCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.openInvoke), 'g')) || []).length
      const closeCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.closeInvoke), 'g')) || []).length
      
      const hasStrayCallsOpen = getAllOpenCallsPatterns().some(pattern => xml.includes(pattern))
      const hasStrayCallsClose = getAllCloseCallsPatterns().some(pattern => xml.includes(pattern))
      if (hasStrayCallsOpen || hasStrayCallsClose) {
        return {
          toolCalls: [],
          isMalformed: true,
          error: {
            message: hasStrayCallsOpen ? 'Stray opening <calls> tag found in wrapperless invoke' : 'Stray closing </calls> tag found in wrapperless invoke',
            syntaxRules: buildCorrectiveMessage(hasStrayCallsOpen ? 'Stray opening <calls> tag found in wrapperless invoke' : 'Stray closing </calls> tag found in wrapperless invoke')
          }
        }
      }
      
      if (openCount > 0 && openCount === closeCount) {
        const wrappedXml = wrapWithSyntheticCalls(xml, invokeDialect)
        dialect = invokeDialect
        normalizedXml = normalizeToCanonical(wrappedXml, dialect)
      } else if (openCount > 0) {
        return {
          toolCalls: [],
          isMalformed: true,
          error: {
            message: `Mismatched <invoke> tags: ${openCount} opening tags but only ${closeCount} closing tags`,
            syntaxRules: buildCorrectiveMessage(`Mismatched <invoke> tags: ${openCount} opening tags but only ${closeCount} closing tags`)
          }
        }
      } else {
        return { toolCalls: [] }
      }
    } else {
      return { toolCalls: [] }
    }
  } else {
    normalizedXml = normalizeToCanonical(xml, dialect)
  }
  
  const hasCallsStart = normalizedXml.includes('<｜｜DSML｜｜ calls>')
  const hasCallsEnd = normalizedXml.includes('</｜｜DSML｜｜ calls>')
  
  if (!hasCallsStart && !hasCallsEnd) {
    return { toolCalls: [] }
  }
  
  if (hasCallsStart && !hasCallsEnd) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: 'Missing closing </｜｜DSML｜｜ calls> tag',
        syntaxRules: buildCorrectiveMessage('Missing closing </｜｜DSML｜｜ calls> tag')
      }
    }
  }
  
  const callsMatch = normalizedXml.match(/<｜｜DSML｜｜\s+calls>([\s\S]*?)<\/｜｜DSML｜｜\s+calls>/)
  if (!callsMatch) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: 'Invalid DSML calls structure',
        syntaxRules: buildCorrectiveMessage('Invalid DSML calls structure')
      }
    }
  }
  
  const callsContent = callsMatch[1]
  
  const openInvokeCount = (callsContent.match(/<｜｜DSML｜｜\s+invoke\s/g) || []).length
  const closedInvokeCount = (callsContent.match(/<\/｜｜DSML｜｜\s+invoke>/g) || []).length
  if (openInvokeCount !== closedInvokeCount) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: `Mismatched <invoke> tags: ${openInvokeCount} opening tags but only ${closedInvokeCount} closing tags`,
        syntaxRules: buildCorrectiveMessage(`Mismatched <invoke> tags: ${openInvokeCount} opening tags but only ${closedInvokeCount} closing tags`)
      }
    }
  }
  
  const withoutInvokes = callsContent.replace(/<｜｜DSML｜｜\s+invoke[\s\S]*?<\/｜｜DSML｜｜\s+invoke>/g, '')
  const orphanParamMatch = withoutInvokes.match(/<｜｜DSML｜｜\s+parameter\s/)
  if (orphanParamMatch) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: 'Parameter found outside of <invoke> block. Parameters MUST be inside an <invoke> block.',
        syntaxRules: buildCorrectiveMessage('Parameter found outside of <invoke> block. Parameters MUST be inside an <invoke> block.')
      }
    }
  }
  
  const directChildrenRegex = /<｜｜DSML｜｜\s+(?!invoke\b|parameter\b)[a-zA-Z]+/g
  const invalidElementMatch = callsContent.match(directChildrenRegex)
  if (invalidElementMatch) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: `Invalid DSML element found: ${invalidElementMatch[0]}. Only <invoke> elements are allowed inside <calls>.`,
        syntaxRules: buildCorrectiveMessage(`Invalid DSML element found: ${invalidElementMatch[0]}. Only <invoke> elements are allowed inside <calls>.`)
      }
    }
  }
  
  const invokeRegex = /<｜｜DSML｜｜\s+invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s+invoke>/g
  let invokeMatch
  
  while ((invokeMatch = invokeRegex.exec(callsContent)) !== null) {
    const toolName = invokeMatch[1]
    const invokeContent = invokeMatch[2]
    
    if (!toolName || toolName.trim() === '') {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: 'Tool name is empty or missing in <invoke> tag',
          syntaxRules: buildCorrectiveMessage('Tool name is empty or missing in <invoke> tag')
        }
      }
    }
    
    const params: Record<string, unknown> = {}
    const paramRegex = /<｜｜DSML｜｜\s+parameter\s+name="([^"]*)"\s+string="(true|false)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s+parameter>/g
    let paramMatch
    
    while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
      const paramName = paramMatch[1]
      const stringAttr = paramMatch[2]
      const rawValue = paramMatch[3] || ''
      
      if (!paramName || paramName.trim() === '') {
        return {
          toolCalls: [],
          isMalformed: true,
          error: {
            message: 'Parameter name is empty or missing',
            syntaxRules: buildCorrectiveMessage('Parameter name is empty or missing')
          }
        }
      }
      
      if (stringAttr === 'true') {
        params[paramName] = rawValue
      } else {
        try {
          params[paramName] = JSON.parse(rawValue.trim())
        } catch {
          return {
            toolCalls: [],
            isMalformed: true,
            error: {
              message: `Parameter "${paramName}" has string="false" but value is not valid JSON`,
              syntaxRules: buildCorrectiveMessage(`Parameter "${paramName}" has string="false" but value is not valid JSON`)
            }
          }
        }
      }
    }
    
    const malformedParamRegex = /<｜｜DSML｜｜\s+parameter\s+name="[^"]*"[^>]*>(?![\s\S]*?<\/｜｜DSML｜｜\s+parameter>)/g
    const hasMalformedParam = invokeContent.match(malformedParamRegex)
    if (hasMalformedParam) {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: 'Malformed parameter tag detected - missing closing </｜｜DSML｜｜ parameter> tag',
          syntaxRules: buildCorrectiveMessage('Malformed parameter tag detected - missing closing </｜｜DSML｜｜ parameter> tag')
        }
      }
    }

    const paramWithoutStringRegex = /<｜｜DSML｜｜\s+parameter\s+name="[^"]*"(?![^>]*\s+string="(true|false)")[^>]*>/g
    const hasParamWithoutString = invokeContent.match(paramWithoutStringRegex)
    if (hasParamWithoutString) {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: 'Parameter tag missing required string="true|false" attribute',
          syntaxRules: buildCorrectiveMessage('Parameter tag missing required string="true|false" attribute')
        }
      }
    }
    
    const validInvokeChildrenRegex = /<｜｜DSML｜｜\s+(?!parameter\b)[a-zA-Z]+/g
    const invalidInvokeChildMatch = invokeContent.match(validInvokeChildrenRegex)
    if (invalidInvokeChildMatch) {
      return {
        toolCalls: [],
        isMalformed: true,
        error: {
          message: `Invalid DSML element found inside invoke: ${invalidInvokeChildMatch[0]}. Only <parameter> elements are allowed inside <invoke>.`,
          syntaxRules: buildCorrectiveMessage(`Invalid DSML element found inside invoke: ${invalidInvokeChildMatch[0]}. Only <parameter> elements are allowed inside <invoke>.`)
        }
      }
    }
    
    toolCalls.push({
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(params)
      }
    })
  }
  
  if (toolCalls.length === 0 && hasCallsStart) {
    return {
      toolCalls: [],
      isMalformed: true,
      error: {
        message: '<calls> block must contain at least one <invoke> element',
        syntaxRules: buildCorrectiveMessage('<calls> block must contain at least one <invoke> element')
      }
    }
  }
  
  return { toolCalls }
}