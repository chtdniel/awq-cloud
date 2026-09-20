import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';

// Gerbang artefak build. public/index.html yang di-commit adalah halaman yang
// benar-benar disajikan, dan build.js menyusunnya dari src/*.html tanpa
// memvalidasi apa pun. Tiga kegagalan senyap yang pernah/lazim terjadi:
//   1. src diubah tapi lupa `node build.js` -> halaman produksi ketinggalan;
//   2. satu file include hilang -> build.js hanya memperingatkan, lalu
//      meninggalkan placeholder <?!= include(...) ?> di HTML jadi;
//   3. tidak ada deklarasi charset -> halaman bergantung penuh pada header
//      server; kalau header itu hilang, semua em-dash/panah di UI jadi mojibake.

const artifactPath = 'public/index.html';
assert.ok(existsSync(artifactPath), `${artifactPath} belum ada — jalankan: node build.js`);
const artifact = readFileSync(artifactPath, 'utf8');
const source = readFileSync('src/Index.html', 'utf8');

// 3. <meta charset> harus ada di 1024 byte pertama; browser mengabaikannya
// setelah itu, jadi posisinya bagian dari kontrak, bukan sekadar keberadaannya.
for (const [label, html] of [['src/Index.html', source], [artifactPath, artifact]]) {
  const offset = html.search(/<meta[^>]*charset\s*=/i);
  assert.ok(offset >= 0, `${label}: tidak ada <meta charset>`);
  assert.ok(offset < 1024, `${label}: <meta charset> ada di byte ${offset}, browser hanya membacanya di 1024 byte pertama`);
}

// 2. Tidak boleh ada include yang belum diproses, dan setiap file yang
// di-include harus benar-benar ada (kalau tidak, build meninggalkan placeholder).
const included = [...source.matchAll(/include\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
assert.ok(included.length > 0, 'src/Index.html tidak meng-include satu file pun — regex include berubah?');
for (const name of included) {
  assert.ok(existsSync(`src/${name}.html`), `src/${name}.html tidak ada, tapi di-include oleh src/Index.html`);
}
const leftovers = artifact.match(/<\?!=?\s*include\(/g) || [];
assert.equal(leftovers.length, 0, `${artifactPath} masih menyimpan ${leftovers.length} placeholder include yang belum diproses`);

// Shim google.script.run disuntik build.js; tanpa itu halaman tidak bisa bicara
// ke RPC sama sekali.
assert.match(artifact, /<script src="\/cloudflare-shim\.js"><\/script>/, 'shim cloudflare-shim.js tidak tersuntik');

// 1. Artefak tidak boleh lebih tua dari file src yang ikut disusun.
const artifactTime = statSync(artifactPath).mtimeMs;
const stale = included
  .map(name => ({ name, mtime: statSync(`src/${name}.html`).mtimeMs }))
  .filter(entry => entry.mtime > artifactTime)
  .map(entry => entry.name);
assert.deepEqual(stale, [], `src lebih baru dari ${artifactPath} — jalankan: node build.js (${stale.join(', ')})`);

console.log(`Artefak build utuh: charset dini, ${included.length} include terproses, shim tersuntik, tidak ada src yang lebih baru.`);
