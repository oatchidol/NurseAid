const fs = require('fs');
const lines = fs.readFileSync('server.js', 'utf8').split('\n');
for (let i = 5070; i <= 5212; i++) {
    const line = lines[i];
    let inEscape = false;
    for (let j = 0; j < line.length; j++) {
        if (line[j] === '\\' && !inEscape) {
            inEscape = true;
        } else {
            if (line[j] === '`' && !inEscape) {
                console.log(`Unescaped backtick at ${i+1}:${j}`);
            }
            inEscape = false;
        }
    }
}
