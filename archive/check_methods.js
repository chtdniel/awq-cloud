const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'src');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
const methods = new Set();
for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    // match run('methodName', ...)
    const regex1 = /\brun\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
    let m;
    while ((m = regex1.exec(content)) !== null) {
        methods.add(m[1]);
    }
    // match google.script.run...xxx(...)
    const regex2 = /google\.script\.run(?:\.[a-zA-Z0-9_]+)*\.([a-zA-Z0-9_]+)\s*\(/g;
    while ((m = regex2.exec(content)) !== null) {
        if (!['withSuccessHandler', 'withFailureHandler', 'withUserObject'].includes(m[1])) {
            methods.add(m[1]);
        }
    }
}
console.log('UI Called Methods:', Array.from(methods).sort());
