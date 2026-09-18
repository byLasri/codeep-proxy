const fs = require('fs');
let content = fs.readFileSync('src/translator/response.ts', 'utf8');
content = content.replace(/\r\n/g, '\n');

const startMarker = 'function buildCorrectiveMessage(parserError: string): string {';
const startIdx = content.indexOf(startMarker);
if (startIdx === -1) {
  console.error('Start marker not found');
  process.exit(1);
}

let braceCount = 0;
let inString = false;
let stringChar = '';
let endIdx = -1;
for (let i = startIdx; i < content.length; i++) {
  const ch = content[i];
  const prevCh = content[i-1];
  
  if ((ch === '"' || ch === "'" || ch === '`') && prevCh !== '\\') {
    if (!inString) {
      inString = true;
      stringChar = ch;
    } else if (ch === stringChar) {
      inString = false;
    }
  }
  
  if (!inString) {
    if (ch === '{') braceCount++;
    if (ch === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }
}

if (endIdx === -1) {
  console.error('End of function not found');
  process.exit(1);
}

console.log('Found function from', startIdx, 'to', endIdx);
console.log('Function length:', endIdx - startIdx);
console.log('Last 50 chars:', content.slice(endIdx - 50, endIdx));

const newFunc = 'function buildCorrectiveMessage(parserError: string): string {\n' +
  '  return `Your previous response contained a malformed tool call.\\n' +
  'The tool call was NOT executed.\\n' +
  '\\n' +
  'Parsing error:\\n' +
  '${parserError}\\n' +
  '\\n' +
  'Please correct the structural error and retry the tool call.`\n' +
  '}';

const newContent = content.slice(0, startIdx) + newFunc + content.slice(endIdx);
fs.writeFileSync('src/translator/response.ts', newContent.replace(/\n/g, '\r\n'));
console.log('Fixed');