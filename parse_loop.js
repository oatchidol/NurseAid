const acorn = require('acorn');
const fs = require('fs');
try {
    acorn.parse(fs.readFileSync('server.js', 'utf8'), { ecmaVersion: 2022 });
    console.log("OK");
} catch (e) {
    console.log(e.loc.line + ":" + e.loc.column);
}
