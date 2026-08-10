const acorn = require('acorn');
const fs = require('fs');
try { acorn.parse(fs.readFileSync('temp_routes.js', 'utf8'), { ecmaVersion: 2022, allowReturnOutsideFunction: true }); console.log("OK"); } catch (e) { console.log(e.message); }
