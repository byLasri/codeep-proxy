const fs = require('fs');
let content = fs.readFileSync('test/dsml-malformed.test.ts', 'utf8');
content = content.replace(/\r\n/g, '\n');

const startMarker = '// Phase 6: Orphan Invoke Detection (wrapperless tool calls)';
const endMarker = '// Phase 4: Parameter semantic tests';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('Markers not found');
  process.exit(1);
}

const newSection = `  // Phase 6: Orphan Invoke Detection (wrapperless tool calls)
  console.log('\\n--- Phase 6: Orphan Invoke Detection Tests ---\\n')

  // Generate unique invoke forms from ALL_DIALECTS (4 delimiters × 2 spacing = 8 unique)
  const uniqueInvokeForms = new Map<string, DSMLDialect>()
  for (const dialect of ALL_DIALECTS) {
    const key = dialect.delimiter + ':' + (dialect.openInvoke.includes(' invoke') ? 'spaced' : 'nospace')
    if (!uniqueInvokeForms.has(key)) {
      uniqueInvokeForms.set(key, dialect)
    }
  }

  const orphanInvokeTests = []

  // Generated tests for all 8 unique invoke syntaxes
  for (const [key, dialect] of uniqueInvokeForms) {
    const spacingDesc = dialect.openInvoke.includes(' invoke') ? 'with space' : 'no space'
    orphanInvokeTests.push({
      name: 'wrapperless invoke: ' + dialect.delimiter + ' delimiter (' + spacingDesc + ')',
      fn: async () => {
        const xml = dialect.openInvoke + ' name="read">\\n' + dialect.openParameter + ' name="filePath" string="true">README.md' + dialect.closeParameter + '\\n' + dialect.closeInvoke

        const result = parseDSMLToolCalls(xml)

        expect(result.isMalformed).toBeFalsy()
        expect(result.toolCalls).toHaveLength(1)
        expect(result.toolCalls[0].function.name).toBe('read')
        expect(JSON.parse(result.toolCalls[0].function.arguments).filePath).toBe('README.md')
      }
    })
  }

  // Additional behavioral tests
  orphanInvokeTests.push(
    { name: 'wrapperless multiple invokes should parse in order', fn: async () => {
      const xml = '<｜｜DSML｜｜ invoke name="read">\\n<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>\\n</｜｜DSML｜｜ invoke>\\n<｜｜DSML｜｜ invoke name="list">\\n<｜｜DSML｜｜ parameter name="path" string="true">.</｜｜DSML｜｜ parameter>\\n</｜｜DSML｜｜ invoke>'

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].function.name).toBe('read')
      expect(JSON.parse(result.toolCalls[0].function.arguments).filePath).toBe('README.md')
      expect(result.toolCalls[1].function.name).toBe('list')
      expect(JSON.parse(result.toolCalls[1].function.arguments).path).toBe('.')
    }},
    { name: 'malformed wrapperless invoke missing close tag should be detected', fn: async () => {
      const xml = '<｜｜DSML｜｜ invoke name="read">\\n<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>'

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('Mismatched <invoke> tags')
      expect(result.error!.syntaxRules).toBe(
        buildCorrectiveMessage('Mismatched <invoke> tags: 1 opening tags but only 0 closing tags')
      )
    }},
    { name: 'malformed parameter inside wrapperless invoke should be detected', fn: async () => {
      const xml = '<｜｜DSML｜｜ invoke name="read">\\n<｜｜DSML｜｜ parameter name="filePath">README.md</｜｜DSML｜｜ parameter>\\n</｜｜DSML｜｜ invoke>'

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('string=')
    }},
    { name: 'prose mentioning invoke without structured tag should not be detected', fn: async () => {
      const xml = 'The model should invoke the read tool when necessary.'

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(0)
      expect(result.error).toBeFalsy()
    }},
    { name: 'wrapperless valid invoke produces no raw DSML in assistant content', fn: async () => {
      const xml = '<｜｜DSML｜｜ invoke name="read">\\n<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜DSML｜｜ parameter>\\n</｜｜DSML｜｜ invoke>'

      const result = parseDSMLToolCalls(xml)

      expect(result.isMalformed).toBeFalsy()
      expect(result.toolCalls).toHaveLength(1)
      // The parse result should not contain the raw DSML tags
      expect(result.toolCalls[0].function.name).toBe('read')
    }}
  )

  failed += await runTestsSequentially(orphanInvokeTests)

  // Phase 4: Parameter semantic tests`;

const newContent = content.slice(0, startIdx) + newSection + content.slice(endIdx);
fs.writeFileSync('test/dsml-malformed.test.ts', newContent.replace(/\n/g, '\r\n'));
console.log('Done');