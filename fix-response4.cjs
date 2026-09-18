const fs = require('fs');
let content = fs.readFileSync('src/translator/response.ts', 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Fix the wrapperless invoke detection to reject stray closing calls tags
const oldWrapperless = `if (!dialect) {
    // Fallback: check for wrapperless invoke blocks
    const invokeDialect = detectInvokeDialect(xml)
    if (invokeDialect) {
      const openCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.openInvoke), 'g')) || []).length
      const closeCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.closeInvoke), 'g')) || []).length
      if (openCount > 0 && openCount === closeCount) {
        // Complete invoke block(s) - wrap and parse normally
        const wrappedXml = wrapWithSyntheticCalls(xml, invokeDialect)
        dialect = invokeDialect
        normalizedXml = normalizeToCanonical(wrappedXml, dialect)
      } else if (openCount > 0) {`;

const newWrapperless = `if (!dialect) {
    // Fallback: check for wrapperless invoke blocks
    const invokeDialect = detectInvokeDialect(xml)
    if (invokeDialect) {
      const openCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.openInvoke), 'g')) || []).length
      const closeCount = (xml.match(new RegExp(escapeRegExp(invokeDialect.closeInvoke), 'g')) || []).length
      if (openCount > 0 && openCount === closeCount) {
        // Check for stray closing calls tags - these indicate malformed input
        // A valid wrapperless invoke must not contain stray closing calls tags
        const closeCallsPatterns = getAllCloseCallsPatterns()
        for (const pattern of closeCallsPatterns) {
          if (xml.includes(pattern)) {
            return {
              toolCalls: [],
              isMalformed: true,
              error: {
                message: 'Stray closing calls tag found in wrapperless invoke: ' + pattern,
                syntaxRules: buildCorrectiveMessage('Stray closing calls tag found in wrapperless invoke: ' + pattern)
              }
            }
          }
        }
        
        // Complete invoke block(s) - wrap and parse normally
        const wrappedXml = wrapWithSyntheticCalls(xml, invokeDialect)
        dialect = invokeDialect
        normalizedXml = normalizeToCanonical(wrappedXml, dialect)
      } else if (openCount > 0) {`;

if (!content.includes(oldWrapperless)) {
  console.error('Could not find old wrapperless pattern');
  process.exit(1);
}
content = content.replace(oldWrapperless, newWrapperless);

// 2. Fix the corrective message to the simplified version
const oldCorrective = 'function buildCorrectiveMessage(parserError: string): string {\n' +
  '  return `Your previous response contained a malformed tool call.\\n' +
  'The tool call was NOT executed.\\n' +
  '\\n' +
  'Parsing error:\\n' +
  '${parserError}\\n' +
  '\\n' +
  'Please correct the structural error and retry the tool call.\\n' +
  '\\n' +
  'A valid tool call has this structure:\\n' +
  '\\n' +
  '<calls>\\n' +
  '<invoke name="read">\\n' +
  '<parameter name="filePath" string="true">README.md\\n' +
  '