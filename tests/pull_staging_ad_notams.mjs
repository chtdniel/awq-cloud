// Collect the staging aerodrome NOTAMs (kind='AD') into a gitignored QA fixture
// snapshot. Read-only against D1 staging.
//
// Usage:
//   node tests/pull_staging_ad_notams.mjs            # runs wrangler itself
//   node tests/pull_staging_ad_notams.mjs capture.json  # parse a captured --json output
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OUT = new URL('../test-results/gate-c/staging/notams-ad-staging.json', import.meta.url);
const REPO = new URL('..', import.meta.url);

// One row of output (a JSON array as text), so wrangler returns a single value.
const SQL = `SELECT json_group_array(json_object('id', id, 'location', location, 'qCode', COALESCE(q_code, ''), 'validFrom', valid_from, 'validTo', valid_to, 'message', REPLACE(message, char(10), ' '))) AS blob FROM (SELECT * FROM notams WHERE kind = 'AD' ORDER BY location, id);`;

/** Pull the `"blob": "..."` value out of wrangler output without parsing the whole file. */
function extractBlob(text) {
  const m = /"blob"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) throw new Error('no "blob" field found in wrangler output');
  return JSON.parse('"' + m[1] + '"');
}

let text;
const capturePath = process.argv[2];
if (capturePath) {
  text = await readFile(capturePath, 'utf8');
} else {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const res = await run(npx, ['wrangler', 'd1', 'execute', 'awq-db', '--remote', '--json', '--command', SQL], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32'
  }).catch((e) => ({ stdout: e.stdout || '' }));
  text = res.stdout || '';
  if (!text) throw new Error('wrangler returned no stdout; rerun and pass the captured output as an argument');
}

const rows = JSON.parse(extractBlob(text));
if (!Array.isArray(rows) || !rows.length) throw new Error('empty result');
const bad = rows.find((r) => !r.id || !r.location || !r.message);
if (bad) throw new Error('malformed row: ' + JSON.stringify(bad).slice(0, 200));

const byLocation = {};
for (const r of rows) byLocation[r.location] = (byLocation[r.location] || 0) + 1;
const snapshot = {
  source: "D1 awq-db (staging), table notams WHERE kind = 'AD'",
  provenance: 'read-only SELECT via wrangler d1 execute --remote --json',
  note: 'Aerodrome-scoped NOTAMs used as Gate C report fixtures. Gitignored: real operational text, public repo.',
  pulledAt: new Date().toISOString(),
  count: rows.length,
  maxMessageBytes: Math.max(...rows.map((r) => Buffer.byteLength(r.message, 'utf8'))),
  byLocation,
  rows
};
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot, null, 2), 'utf8');
console.log('rows:', snapshot.count, '| max message bytes:', snapshot.maxMessageBytes);
console.log('by location:', JSON.stringify(byLocation));
console.log('written:', new URL('.', OUT).pathname);
