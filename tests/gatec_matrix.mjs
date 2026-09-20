// Gate C — cross-browser selection matrix.
//
// PRD §11 Gate C / implementation plan §7 "Browser matrix":
//   current Chrome, current Edge and current Mozilla Firefox
//   × 1/2/3/4-flight selections
//   → correct CBR template, exact selection order, exact transfer fidelity.
//
// Each case drives the REAL Web 2 handoff script (src/Report_Ui.html) against the
// REAL Web 1 page (archive/Report.html) with only the Apps Script RPC stubbed,
// then produces a machine-checkable evidence record.
//
// Usage:
//   node tests/gatec_matrix.mjs                        # primary browsers × 1..4
//   node tests/gatec_matrix.mjs chromium               # one engine × 1..4
//   node tests/gatec_matrix.mjs "chrome,msedge" 2      # selection sizes subset
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildFlightDataset } from './gatec_fixtures.mjs';
import { startHarness, stopHarness, WEB1_ORIGIN } from './gatec_harness.mjs';
import { ALL_ENGINES, resolveEngines, launchEngine } from './gatec_browsers.mjs';

const OUT_DIR = new URL('../test-results/gate-c/', import.meta.url);
const EXPECTED_TEMPLATE = { 1: 'CBR1', 2: 'CBR2', 3: 'CBR4', 4: 'CBR4' };
const TERMINAL_OK = 'accepted the report context';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// One long-lived fixture server: scenarios select their data set per request.
let harness = null;

async function readWeb1(popup) {
  for (const frame of popup.frames()) {
    const el = frame.locator('#status');
    if (await el.count().catch(() => 0)) {
      const status = await el.innerText().catch(() => '(unreadable)');
      const preview = await frame.locator('#preview-body').innerText().catch(() => '');
      return { status, preview };
    }
  }
  return { status: '(no #status frame)', preview: '' };
}

async function waitForReceipt(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const term = await page.locator('#report-status').innerText().catch(() => '');
    if (term.includes('accepted the report context') || term.includes('rejected the report context')) return term;
    await page.waitForTimeout(250);
  }
  return page.locator('#report-status').innerText().catch(() => '');
}

async function runCase(browser, engineInfo, count) {
  const dataset = buildFlightDataset(count, { phase: '01' });
  harness.set({ web1: { outcome: 'ok', ready: 'real', ack: 'ok' } });
  harness.setNonce('');
  const token = await harness.putDataset(dataset);
  const t0 = Date.now();
  const record = {
    browser: engineInfo,
    selectionCount: count,
    startedAt: new Date().toISOString(),
    expected: {
      template: EXPECTED_TEMPLATE[count],
      flights: dataset.flightNumbers,
      selectionOrder: dataset.flightNumbers,
      notamCount: dataset.notamsByFlight[dataset.flightNumbers[0]].length * count
    },
    observed: {},
    checks: [],
    pass: false,
    errors: []
  };
  const addCheck = (name, ok, detail) => {
    record.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    if (!ok) record.errors.push(`${name}: ${detail}`);
  };

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${harness.web2Url}?view=vs&dst=${encodeURIComponent(token)}`);
    const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await page.click('#btn-download-sheet');
    const popup = await popupPromise;
    addCheck('Web 1 tab opened from DOWNLOAD SHEET', !!popup, popup ? '' : 'window.open returned no page');
    if (!popup) return record;

    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    // The URL fragment never reaches the fixture server, so publish the live nonce
    // and reload Web 1 to let the shipped page announce readiness.
    let nonce = '';
    for (let i = 0; i < 30 && !nonce; i++) {
      nonce = await page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
      if (!nonce) await page.waitForTimeout(100);
    }
    harness.setNonce(nonce);
    await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const term = await waitForReceipt(page, 12000);
    record.observed.nonce = nonce;
    record.observed.web2Terminal = term;
    record.observed.openCalls = await page.evaluate(() => window.__openCalls);
    record.observed.handoffUrl = record.observed.openCalls?.[0]?.url || '';
    record.observed.diag = await page.evaluate(() => window.__diag);
    record.observed.transferState = await page.evaluate(() => window.__gatecTransferState || null);
    record.observed.contextSent = await page.evaluate(() => window.__gatecContextSent || null);

    addCheck('Web 2 received AWQ_REPORT_ACCEPTED', term.includes(TERMINAL_OK), term.trim().slice(0, 200));
    addCheck(
      'nonce delivered in URL fragment, never in the query string',
      /#nonce=/.test(record.observed.handoffUrl) && !/[?&]nonce=/.test(record.observed.handoffUrl.split('#')[0]),
      record.observed.handoffUrl
    );

    const readyDiag = (record.observed.diag || []).find((d) => d.type === 'AWQ_REPORT_READY');
    addCheck('READY came from an allowlisted Web 1 origin', !!readyDiag && readyDiag.origin === WEB1_ORIGIN, readyDiag ? readyDiag.origin : 'no READY observed');
    addCheck('READY source is the iframe inside the opened tab (source.top === popup)', readyDiag?.sourceTopMatchesPopup === true, JSON.stringify(readyDiag?.sourceTopMatchesPopup));

    const w1 = await readWeb1(popup);
    record.observed.web1Status = w1.status;
    record.observed.web1Preview = w1.preview;
    record.observed.web1Received = await popup.evaluate(() => window.__received).catch(() => null);

    const received = record.observed.web1Received || {};
    addCheck('Web 1 recorded exactly one receipt', received.count === 1, `count=${received.count}`);
    addCheck(
      `CBR template mapping for ${count} flight(s)`,
      received.template === EXPECTED_TEMPLATE[count],
      `expected ${EXPECTED_TEMPLATE[count]}, got ${received.template}`
    );
    addCheck(
      'flight identifiers reached Web 1 in selection order',
      JSON.stringify(received.flights) === JSON.stringify(record.expected.selectionOrder),
      `expected ${record.expected.selectionOrder.join(',')} got ${(received.flights || []).join(',')}`
    );

    // Transfer fidelity: the payload Web 1 received hashes to the payload Web 2 built.
    const canonicalJson = (value) => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
      return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
    };
    const receivedJson = received.payloadJson || '';
    const rehash = receivedJson ? sha256(canonicalJson(JSON.parse(receivedJson))) : '';
    record.observed.web1RecomputedHash = rehash;
    record.observed.web1ReportedHash = received.payloadHash || '';
    addCheck('payload hash recomputed from the payload Web 1 received matches the Web 1 receipt hash', !!rehash && rehash === received.payloadHash, `recomputed=${rehash} receipt=${received.payloadHash}`);
    addCheck('transfer was a single CONTEXT message', (await popup.evaluate(() => window.__contextCount || 0).catch(() => -1)) === 1, 'context count');

    // Payload identity and content fidelity.
    let payload = null;
    try { payload = JSON.parse(receivedJson); } catch (e) { /* recorded as a failed check below */ }
    addCheck('payload parsed at Web 1', !!payload, receivedJson.slice(0, 80));
    if (payload) {
      record.observed.payloadBytes = Buffer.byteLength(receivedJson, 'utf8');
      record.observed.payloadHash = sha256(canonicalJson(payload));
      record.observed.tafStations = (payload.tafContext || []).map((t) => t.station);
      record.observed.notamCount = (payload.notamContext || []).length;
      record.observed.payloadVersion = payload.version;
      record.observed.savedNotamAnalysisKeys = Object.keys(payload.savedNotamAnalysis || {});
      record.observed.noSigStationMap = payload.noSigStationMap;

      addCheck('payload version is 1', payload.version === 1, String(payload.version));
      addCheck('flight count in payload matches selection', (payload.flights || []).length === count, String((payload.flights || []).length));
      addCheck('payload preserves full flight field set', (payload.flights || []).every((f) => f.FLIGHT && f.DOF && f.DEP && f.ARR && f.STD && f.STA && f.REG && f.ALT && ('ENR1' in f) && ('TAF_DEP' in f)), JSON.stringify(Object.keys((payload.flights || [])[0] || {})));
      addCheck('TAF context is non-empty with full text', (payload.tafContext || []).length > 0 && (payload.tafContext || []).every((t) => typeof t.text === 'string' && t.text.length > 0), `${(payload.tafContext || []).length} stations`);
      addCheck('NOTAM context carries full raw text', (payload.notamContext || []).length > 0 && (payload.notamContext || []).every((n) => n.id && n.station && typeof n.text === 'string' && n.text.length > 0), `${(payload.notamContext || []).length} notams`);
      addCheck('savedNotamAnalysis covers every selected flight', record.expected.selectionOrder.every((fn) => Array.isArray(payload.savedNotamAnalysis?.[fn])), JSON.stringify(record.observed.savedNotamAnalysisKeys));
      addCheck('noSigStationMap preserved', Object.keys(payload.noSigStationMap || {}).length > 0, JSON.stringify(payload.noSigStationMap));

      // Byte-for-byte text identity against the fixture corpus.
      const fixtureTafSample = Object.values(dataset.tafByStation)[0];
      addCheck('TAF text is byte-identical to the Web 2 source text', (payload.tafContext || []).some((t) => t.text === fixtureTafSample.text), 'no exact TAF text match');
      const fixtureNotamSample = dataset.notamsByFlight[dataset.flightNumbers[0]][0];
      addCheck('NOTAM text is byte-identical to the Web 2 source text', (payload.notamContext || []).some((n) => n.text === fixtureNotamSample.text), 'no exact NOTAM text match');
      addCheck('reported payload bytes within the locked 64 KiB budget', record.observed.payloadBytes <= 64 * 1024, `${record.observed.payloadBytes} bytes`);

      // ---- aerodrome-only scope rule -------------------------------------
      // The fixture attaches one FIR/UIR-scoped NOTAM to each flight. The payload
      // must carry only aerodrome NOTAMs, and must report what it dropped.
      const expectedAerodrome = Object.values(dataset.notamsByFlight).flat().length;
      const expectedFirDropped = count; // one per flight by construction
      const scope = payload.notamScope || {};
      record.observed.notamScope = scope;
      record.observed.expectedAerodromeNotams = expectedAerodrome;
      record.observed.expectedFirDropped = expectedFirDropped;
      const firIds = Object.values(dataset.firStationMap);
      // FIR/UIR scope is identified by the fixture's station→FIR-NOTAM-id map, not by a
      // code suffix: Bangkok/Brisbane/Melbourne FIRs (VTBB, YBBB, YMMM) end in B/M, and
      // a suffix rule would silently pass a payload that carried them.
      const firStations = Object.keys(dataset.firStationMap).filter((s) => dataset.notamResponseByStation.data.some((x) => x.station === s && x.notams.some((n) => n.notamNum === dataset.firStationMap[s])));
      const firRowIds = new Set(Object.values(dataset.firStationMap));
      addCheck('payload carries no FIR/UIR NOTAM of the selection',
        (payload.notamContext || []).every((n) => !firRowIds.has(String(n.id))),
        JSON.stringify({ stations: [...new Set((payload.notamContext || []).map((n) => n.station))], firStations }));
      addCheck('no FIR-scoped NOTAM ID from the fixture reached the payload', !(payload.notamContext || []).some((n) => firIds.some((fid) => String(n.id).startsWith(fid))), JSON.stringify(firIds));
      addCheck('all aerodrome NOTAMs of the selection are present', (payload.notamContext || []).length === expectedAerodrome, `expected ${expectedAerodrome}, got ${(payload.notamContext || []).length}`);
      addCheck('payload reports the dropped FIR-wide count', scope.rule === 'AERODROME_ONLY' && Number(scope.droppedFirWide) === expectedFirDropped, JSON.stringify(scope));
    }

    // Web 1 preview fidelity.
    addCheck('Web 1 preview names the expected CBR template', w1.preview.includes(EXPECTED_TEMPLATE[count]), EXPECTED_TEMPLATE[count]);
    addCheck('Web 1 preview lists every selected flight', record.expected.selectionOrder.every((fn) => w1.preview.includes(fn)), record.expected.selectionOrder.join(','));
    addCheck('Web 1 preview shows the request ID', /Request ID/.test(w1.preview) && w1.preview.includes((record.observed.contextSent?.reportRequestId || 'XXNONEXX')), 'request ID row');
    addCheck('Web 1 preview reports NO SIG stations', /NO SIG stations/.test(w1.preview), 'NO SIG row');
    addCheck('Web 1 preview states the AERODROME ONLY scope rule', /AERODROME ONLY/.test(w1.preview), w1.preview.slice(0, 300));
    addCheck('Web 1 preview warns that FIR-wide NOTAMs were excluded', /FIR-wide excluded/.test(w1.preview) && /bukan aerodrome/.test(w1.preview), w1.preview.slice(0, 300));
    addCheck('Web 1 does not generate before confirmation', (await popup.evaluate(() => window.__confirmCalls || 0).catch(() => -1)) === 0, 'confirm call count before operator action');

    record.pass = record.checks.every((c) => c.ok);
  } catch (e) {
    record.errors.push(`exception: ${e.message}`);
  } finally {
    record.durationMs = Date.now() - t0;
    await context.close().catch(() => {});
  }
  return record;
}

const engineSpec = process.argv[2] || 'primary';
const sizesArg = process.argv[3];
const sizes = sizesArg ? String(sizesArg).split(',').map(Number) : [1, 2, 3, 4];
let engines;
if (engineSpec === 'primary') engines = ALL_ENGINES.filter((e) => e.primary);
else if (engineSpec === 'all') engines = ALL_ENGINES;
else engines = resolveEngines(engineSpec);

await mkdir(OUT_DIR, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];

// One fixture server for the whole run; each case selects its data set per request.
harness = await startHarness();

for (const engine of engines) {
  let launched = null;
  try {
    launched = await launchEngine(engine);
  } catch (e) {
    results.push({
      browser: { engine: engine.id, label: engine.label, channel: engine.channel || null, primary: !!engine.primary },
      selectionCount: null,
      pass: false,
      checks: [],
      errors: [`launch failed: ${e.message}`],
      observed: {}
    });
    continue;
  }
  for (const count of sizes) {
    const record = await runCase(launched.browser, launched.info, count);
    results.push(record);
    const tag = record.pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${launched.info.engine} (${launched.info.version}) × ${count} flight(s)` + (record.pass ? '' : `\n        ${record.errors.join('\n        ')}`));
  }
  await launched.browser.close().catch(() => {});
}

const summary = {
  gate: 'C',
  suite: 'browser-selection-matrix',
  startedAt,
  finishedAt: new Date().toISOString(),
  engines: [...new Map(results.filter((r) => r.browser?.engine).map((r) => [r.browser.engine, r.browser])).values()],
  selectionSizes: sizes,
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results
};
await stopHarness();
await writeFile(new URL('matrix-results.json', OUT_DIR), JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nGate C matrix: ${summary.passed}/${summary.total} cases passed → test-results/gate-c/matrix-results.json`);
process.exit(summary.failed === 0 ? 0 : 1);
