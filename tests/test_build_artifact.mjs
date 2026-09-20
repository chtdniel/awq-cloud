import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';

// Build artifact gate. The committed public/index.html is the page that is actually
// served, and build.js assembles it from src/*.html without validating anything.
// Three silent failures that have happened or are easy to hit:
//   1. src edited but `node build.js` forgotten -> the production page lags behind;
//   2. an include file missing -> build.js only warns, then leaves the
//      <?!= include(...) ?> placeholder inside the finished HTML;
//   3. no charset declaration -> the page depends entirely on the server header;
//      lose that header and every em-dash/arrow in the UI becomes mojibake.

const artifactPath = 'public/index.html';
assert.ok(existsSync(artifactPath), `${artifactPath} does not exist — run: node build.js`);
const artifact = readFileSync(artifactPath, 'utf8');
const source = readFileSync('src/Index.html', 'utf8');

// 3. <meta charset> must sit inside the first 1024 bytes; browsers ignore it after
// that, so its position is part of the contract, not just its presence.
for (const [label, html] of [['src/Index.html', source], [artifactPath, artifact]]) {
  const offset = html.search(/<meta[^>]*charset\s*=/i);
  assert.ok(offset >= 0, `${label}: no <meta charset> found`);
  assert.ok(offset < 1024, `${label}: <meta charset> sits at byte ${offset}, but browsers only read it within the first 1024 bytes`);
}

// 2. No include may be left unprocessed, and every included file has to exist
// (otherwise the build leaves the placeholder behind).
const included = [...source.matchAll(/include\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
assert.ok(included.length > 0, 'src/Index.html includes no file at all — did the include regex change?');
for (const name of included) {
  assert.ok(existsSync(`src/${name}.html`), `src/${name}.html is missing but is included by src/Index.html`);
}
const leftovers = artifact.match(/<\?!=?\s*include\(/g) || [];
assert.equal(leftovers.length, 0, `${artifactPath} still holds ${leftovers.length} unprocessed include placeholder(s)`);

// build.js injects the google.script.run shim; without it the page cannot talk to
// RPC at all.
assert.match(artifact, /<script src="\/cloudflare-shim\.js"><\/script>/, 'the cloudflare-shim.js script tag was not injected');

// 1. The artifact must not be older than any src file it was assembled from.
const artifactTime = statSync(artifactPath).mtimeMs;
const stale = included
  .map(name => ({ name, mtime: statSync(`src/${name}.html`).mtimeMs }))
  .filter(entry => entry.mtime > artifactTime)
  .map(entry => entry.name);
assert.deepEqual(stale, [], `src is newer than ${artifactPath} — run: node build.js (${stale.join(', ')})`);

console.log(`Build artifact intact: early charset, ${included.length} includes processed, shim injected, no src file newer than the artifact.`);
