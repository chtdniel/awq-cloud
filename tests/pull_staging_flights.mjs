// Pull the REAL flights (including enr1/enr2/enr3) from staging D1 so the Gate C
// fixtures stop inventing enroute stations. Read-only.
//
// Why: buildFlightDataset used to fill ENR1/ENR2 from a general TAF station pool, which
// put stations like VTSP (Phuket) and VVDN (Da Nang) on a WADD→WATO flight whose real
// record has enr1/enr2/enr3 = NULL. The harness preview then showed TAF/NOTAM for
// stations the flight does not have — an artifact, not product behaviour.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OUT = new URL('../test-results/gate-c/staging/flights-staging.json', import.meta.url);
const REPO = new URL('..', import.meta.url);

const SQL = `SELECT json_group_array(json_object(
  'callsign', callsign, 'dep', dep, 'dest', dest, 'alt', COALESCE(alt, ''),
  'enr1', COALESCE(enr1, ''), 'enr2', COALESCE(enr2, ''), 'enr3', COALESCE(enr3, ''),
  'acType', COALESCE(ac_type, ''), 'dof', COALESCE(dof, ''),
  'etd', COALESCE(etd, ''), 'eta', COALESCE(eta, '')
)) AS blob FROM (SELECT * FROM flights ORDER BY callsign);`;

function extractBlob(text) {
  const m = /"blob"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) throw new Error('no "blob" field in wrangler output');
  return JSON.parse('"' + m[1] + '"');
}

/**
 * Accept either the raw wrangler stdout or an already-saved JSON envelope.
 * Wrangler's `--json` output is an array of envelopes: [{ results: [{ blob }] }].
 */
function extractRows(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (Array.isArray(parsed)) {
    for (const env of parsed) {
      for (const r of env.results || []) {
        if (typeof r.blob === 'string') return JSON.parse(r.blob);
      }
    }
  }
  return JSON.parse(extractBlob(text));
}

let text;
const capturePath = process.argv[2];
if (capturePath) {
  text = await readFile(capturePath, 'utf8');
} else {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const res = await run(npx, ['wrangler', 'd1', 'execute', 'awq-db', '--remote', '--json', '--command', SQL], {
    cwd: REPO, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32'
  }).catch((e) => ({ stdout: e.stdout || '' }));
  text = res.stdout || '';
  if (!/"blob"/.test(text)) {
    throw new Error('wrangler returned no "blob" (shell escaping of SQL is unreliable on Windows); run the query in a terminal and pass the captured output as an argument');
  }
}

const rows = extractRows(text);
if (!Array.isArray(rows) || !rows.length) throw new Error('empty flights result');

const withEnr = rows.filter((r) => r.enr1 || r.enr2 || r.enr3);
const snapshot = {
  source: 'D1 awq-db (staging), table flights',
  provenance: 'read-only SELECT via wrangler d1 execute --remote --json',
  note: 'Real flight records incl. enroute stations, so Gate C fixtures do not invent them. Gitignored: real operational data, public repo.',
  pulledAt: new Date().toISOString(),
  count: rows.length,
  withEnroute: withEnr.length,
  withoutEnroute: rows.length - withEnr.length,
  rows
};
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot, null, 2), 'utf8');

console.log(`rows: ${snapshot.count} | with enroute: ${snapshot.withEnroute} | without: ${snapshot.withoutEnroute}`);
console.log('sample with enroute:', JSON.stringify(withEnr.slice(0, 4).map((r) => [r.callsign, r.dep, r.dest, r.alt, r.enr1, r.enr2, r.enr3])));
console.log('sample without    :', JSON.stringify(rows.filter((r) => !r.enr1 && !r.enr2 && !r.enr3).slice(0, 4).map((r) => [r.callsign, r.dep, r.dest, r.alt])));
console.log('written:', new URL('.', OUT).pathname);
