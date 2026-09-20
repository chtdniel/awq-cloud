import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// build.js hanya meng-inline src/*.html ke public/app/index.html tanpa mem-parse
// JS, jadi syntax error di blok <script> tidak akan ketahuan saat build. Skrip ini
// mengompilasi tiap blok inline (tanpa menjalankannya) sebagai gerbang cepat.
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scratch/check-client-syntax.mjs <file.html> [...]');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || '';
    const code = match[2];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*["']?(?!text\/javascript|module)/i.test(attrs)) continue;
    if (!code.trim()) continue;
    index += 1;
    const line = html.slice(0, match.index).split('\n').length;
    try {
      new vm.Script(code, { filename: `${file}#script${index}` });
      console.log(`OK   ${file} block ${index} (starts line ${line})`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${file} block ${index} (starts line ${line}): ${error.message}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} script block(s) gagal dikompilasi.`);
  process.exit(1);
}
console.log('\nSemua blok <script> inline terkompilasi.');
