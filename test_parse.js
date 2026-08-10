const acorn = require('acorn');
const fs = require('fs');
try {
    acorn.parse(fs.readFileSync('test_temp.js', 'utf8'), { ecmaVersion: 2022 });
    console.log("OK");
} catch (e) {
    console.error(e.loc.line + ":" + e.loc.column);
    console.error(e.message);
}
