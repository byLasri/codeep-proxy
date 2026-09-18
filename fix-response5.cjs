const fs = require('fs');
let content = fs.readFileSync('src/translator/response.ts', 'utf8');
content = content.replace(/\r\n/g, '\n');

// Find the buildCorrectiveMessage function and replace it
const lines = content.split('\n');
let inFunction = false;
let braceCount = 0;
let startLine = -1;
let endLine = -1;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (line.trim().startsWith('function buildCorrectiveMessage(parserError: string): string {')) {
    startLine = i;
    inFunction = true;
    braceCount = 1;
    continue;
  }
  
  if (inFunction) {
    for (const ch of line) {
      if (ch === '{') braceCount++;
      if (ch === '}') {
        braceCount--;
        if (braceCount === 0) {
          // Found the end of the function
          endLine = i;
          break;
        }
      }
    }
    if (endLine !== -1) break;
  }
}

if (startLine === -1 || endLine === -1) {
  console.error('Could not find buildCorrectiveMessage function');
  process.exit(1);
}

console.log('Function found from line', startLine, 'to', endLine);

// Replace the function
const newFuncLines = [
  'function buildCorrectiveMessage(parserError: string): string {',
  '  return `Your previous response contained a malformed tool call.\\n' +
  'The tool call was NOT executed.\\n' +
  '\\n' +
  'Parsing error:\\n' +
  '${parserError}\\n' +
  '\\n' +
  'Please correct the structural error and retry the tool call.`',
  '}'
];

const newLines = lines.slice(0, startLine).concat(newFuncLines).concat(lines.slice(endLine + 1));
fs.writeFileSync('src/translator/response.ts', newLines.join('\n').replace(/\n/g, '\r\n'));
console.log('Fixed corrective message');