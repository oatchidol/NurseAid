const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
let openBraces = 0;
let openParens = 0;
let inString = false;
let stringChar = null;
let inComment = false;
let inMultiComment = false;
for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i+1];
    
    if (inMultiComment) {
        if (c === '*' && next === '/') { inMultiComment = false; i++; }
        continue;
    }
    if (inComment) {
        if (c === '\n') { inComment = false; }
        continue;
    }
    if (!inString) {
        if (c === '/' && next === '*') { inMultiComment = true; i++; continue; }
        if (c === '/' && next === '/') { inComment = true; i++; continue; }
        if (c === "'" || c === '"' || c === '`') { inString = true; stringChar = c; continue; }
        if (c === '{') openBraces++;
        if (c === '}') openBraces--;
        if (c === '(') openParens++;
        if (c === ')') openParens--;
    } else {
        if (c === '\\') { i++; continue; }
        if (c === stringChar) { inString = false; }
    }
}
console.log('Braces:', openBraces, 'Parens:', openParens);
