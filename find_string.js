const fs = require('fs');
const content = fs.readFileSync('temp_clean.js', 'utf8');
let inString = false;
let startLine = 0;
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 3605) { // Line 3606 is index 3605
        console.log('At line 3606, inString is:', inString, 'started at line:', startLine + 1);
        break;
    }
    // simple backtick counting (ignoring comments/escapes for a rough estimate)
    for (let j = 0; j < line.length; j++) {
        if (line[j] === '`' && (j === 0 || line[j-1] !== '\\')) {
            inString = !inString;
            if (inString) startLine = i;
        }
    }
}
