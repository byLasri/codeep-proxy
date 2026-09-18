const fs = require('fs');
let content = fs.readFileSync('src/translator/response.ts', 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Fix the wrapperless invoke detection to reject stray closing calls tags
const oldWrapperless = 'if (!dialect) {\n' +
  '    // Fallback: check for wrapperless invoke blocks\n' +
  '    const invokeDialect = detectInvokeDialect(xml)\n' +
  '    if (invokeDialect) {\n' +
  '      const openCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.openInvoke), \'g\')) || []).length\n' +
  '      const closeCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.closeInvoke), \'g\')) || []).length\n' +
  '      if (openCount > 0 && openCount === closeCount) {\n' +
  '        // Complete invoke block(s) - wrap and parse normally\n' +
  '        const wrappedXml = wrapWithSyntheticCalls(xml, invokeDialect)\n' +
  '        dialect = invokeDialect\n' +
  '        normalizedXml = normalizeToCanonical(wrappedXml, dialect)\n' +
  '      } else if (openCount > 0) {';

const newWrapperless = 'if (!dialect) {\n' +
  '    // Fallback: check for wrapperless invoke blocks\n' +
  '    const invokeDialect = detectInvokeDialect(xml)\n' +
  '    if (invokeDialect) {\n' +
  '      const openCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.openInvoke), \'g\')) || []).length\n' +
  '      const closeCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.closeInvoke), \'g\')) || []).length\n' +
  '      if (openCount > 0 && openCount === closeCount) {\n' +
  '        // Check for stray closing calls tags - these indicate malformed input\n' +
  '        // A valid wrapperless invoke must not contain stray closing calls tags\n' +
  '        const closeCallsPatterns = getAllCloseCallsPatterns()\n' +
  '        for (const pattern of closeCallsPatterns) {\n' +
  '          if (xml.includes(pattern)) {\n' +
  '            return {\n' +
  '              toolCalls: [],\n' +
  '              isMalformed: true,\n' +
  '              error: {\n' +
  '                message: `Stray closing calls tag found in wrapperless invoke: ${pattern}`,\n' +
  '                syntaxRules: buildCorrectiveMessage(`Stray closing calls tag found in wrapperless invoke: ${pattern}`)\n' +
  '              }\n' +
  '            }\n' +
  '          }\n' +
  '        }\n' +
  '        \n' +
  '        // Complete invoke block(s) - wrap and parse normally\n' +
  '        const wrappedXml = wrapWithSyntheticCalls(xml, invokeDialect)\n' +
  '        dialect = invokeDialect\n' +
  '        normalizedXml = normalizeToCanonical(wrappedXml, dialect)\n' +
  '      } else if (openCount > 0) {';

if (!content.includes(oldWrapperless)) {
  console.error('Could not find old wrapperless pattern');
  process.exit(1);
}
content = content.replace(oldWrapperless, newWrapperless);

// 2. Fix the corrective message to the simplified version
const oldCorrective = 'function buildCorrectiveMessage(parserError: string): string {\n' +
  '  return `Your previous response contained a malformed tool call.\n' +
  'The tool call was NOT executed.\n' +
  '\n' +
  'Parsing error:\n' +
  '${parserError}\n' +
  '\n' +
  'Please correct the structural error and retry the tool call.\n' +
  '\n' +
  'A valid tool call has this structure:\n' +
  '\n' +
  '<calls>\n' +
  '<invoke name="read">\n' +
  '<parameter name="filePath" string="true">README.md\n' +
  '