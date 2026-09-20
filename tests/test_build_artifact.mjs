import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';

// Build artifact gate. Two committed files are served directly:
//   public/index.html     — the hand-written public landing page served at /
//   public/app/index.html — the application, assembled by build.js from src/*.html
// build.js validates nothing, so the silent failures below are caught here:
//   1. src edited but `node build.js` forgotten -> the app page lags behind;
//   2. an include file missing -> build.js only warns, then leaves the
//      <?!= include(...) ?> placeholder inside the finished HTML;
//   3. no charset declaration -> the page depends entirely on the server header;
//      lose that header and every em-dash/arrow in the UI becomes mojibake;
//   4. the landing page at / missing or clobbered by a build -> the site root
//      stops identifying the app and stops linking the privacy policy, which is
//      exactly what the Google OAuth consent screen requires of a home page.

const artifactPath = 'public/app/index.html';
const landingPath = 'public/index.html';
// The host that actually serves the site. The apex christiandaniel.my.id does not
// resolve, so the home page, the legal pages and the URLs registered in the OAuth
// consent screen must all name this host (see docs/google-sheets-report.md).
const CANONICAL_HOST = 'awq.christiandaniel.my.id';
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

// 4. The landing page at / must exist, declare its charset early, and carry the
// public contract the Google OAuth consent screen depends on: identify the app,
// link the app itself at /app, and link the same legal URLs registered there.
assert.ok(existsSync(landingPath), `${landingPath} (the landing page served at /) is missing`);
const landing = readFileSync(landingPath, 'utf8');
const landingCharset = landing.search(/<meta[^>]*charset\s*=/i);
assert.ok(landingCharset >= 0 && landingCharset < 1024, `${landingPath}: <meta charset> must sit within the first 1024 bytes`);
assert.match(landing, /AWQ Cloud Briefing/, `${landingPath}: does not name the application`);
assert.match(landing, /href="\/app"/, `${landingPath}: does not link the application at /app`);
assert.match(landing, /href="\/privacy"/, `${landingPath}: does not link /privacy`);
assert.match(landing, /href="\/terms"/, `${landingPath}: does not link /terms`);
assert.match(landing, new RegExp(CANONICAL_HOST.replace(/\./g, '\\.')), `${landingPath}: does not name the canonical host ${CANONICAL_HOST} — the apex does not resolve`);
assert.doesNotMatch(landing, /<\?!=?\s*include\(/, `${landingPath}: holds a build include placeholder — the landing page must stay hand-written`);

// The legal pages are the URLs registered in the OAuth consent screen, so a
// missing or unlinked one breaks the published app configuration.
for (const [file, other] of [['public/privacy.html', '/terms'], ['public/terms.html', '/privacy']]) {
  assert.ok(existsSync(file), `${file} is missing — the consent screen links to it`);
  const page = readFileSync(file, 'utf8');
  const offset = page.search(/<meta[^>]*charset\s*=/i);
  assert.ok(offset >= 0 && offset < 1024, `${file}: <meta charset> must sit within the first 1024 bytes`);
  assert.match(page, new RegExp(`href="${other}"`), `${file}: does not link ${other}`);
  assert.match(page, /href="\/app"/, `${file}: does not link back to the application at /app`);
  assert.match(page, new RegExp(CANONICAL_HOST.replace(/\./g, '\\.')), `${file}: does not name the canonical host ${CANONICAL_HOST}`);
  assert.doesNotMatch(page, /chtdniel@gmail\.com/, `${file}: still carries the retired contact address`);
}

console.log(`Build artifact intact: early charset, ${included.length} includes processed, shim injected, no src file newer than the artifact; landing page at / and both legal pages verified.`);
