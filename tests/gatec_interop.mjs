// Gate C — Web 1 state-machine interop.
//
// Drives the REAL archive/Report.html (mock Apps Script backend) through the
// states the QA gate cares about: preview-before-confirmation, success,
// unknown/reconciliation, BUSY, retryable FAILED, status lookup, direct access
// without a valid handoff, and confirming that a rendered failure cannot
// generate. Also proves the preview counts/context come from the payload rather
// than from any Web 1 cache (the handoff boundary takes context, not IDs).
//
// Usage: node tests/gatec_interop.mjs [chrome,msedge,chromium]
import { mkdir, writeFile } from 'node:fs/promises';
import { buildFlightDataset } from './gatec_fixtures.mjs';
import { startHarness, stopHarness } from './gatec_harness.mjs';
import { resolveEngines, launchEngine } from './gatec_browsers.mjs';

const OUT_DIR = new URL('../test-results/gate-c/', import.meta.url);
const CONFIRM_DEADLINE_MS = 4000; // shortened stand-in for the 6-minute browser deadline

// `pass` is finalised after the scenario has read every observation it needs.
const mk = (name, requirement) => ({
  name,
  requirement,
  checks: [],
  observed: {},
  pass: false,
  finalize() {
    this.pass = this.checks.length > 0 && this.checks.every((c) => c.ok);
    return this;
  }
});
const chk = (sc, name, ok, detail) => sc.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
const terminal = (page) => page.locator('#report-status').innerText().catch(() => '');
const body = (page) => page.locator('body').innerText().catch(() => '');

let harness = null;
const fixtureUrl = (view, extra = {}) => {
  const url = new URL('/?view=' + encodeURIComponent(view), harness.web2Url);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return url.toString();
};

/** Point the fixture at this scenario's data set and Web 1 behaviour; returns a data-set token. */
async function configure(dataset, web1 = {}) {
  harness.set({ dataset, web1 });
  harness.setNonce('');
  return harness.putDataset(dataset);
}

/**
 * Open the handoff, publish the live nonce (the URL fragment never reaches the
 * fixture server) and reload Web 1 so the shipped page announces readiness.
 */
async function handoff(browser, token) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixtureUrl('vs', { dst: token }));
  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await page.click('#btn-download-sheet');
  const popup = await popupPromise;
  if (!popup) throw new Error('Web 1 tab did not open');
  await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  let nonce = '';
  for (let i = 0; i < 30 && !nonce; i++) {
    nonce = await page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!nonce) await page.waitForTimeout(100);
  }
  harness.setNonce(nonce);
  await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 10000;
  let web2Term = '';
  while (Date.now() < deadline) {
    web2Term = await terminal(page);
    if (web2Term.includes('accepted the report context')) break;
    await page.waitForTimeout(200);
  }
  return { context, page, popup, web2Term };
}

const suite = { gate: 'C', suite: 'web1-interop', startedAt: new Date().toISOString(), engines: [], results: [] };

async function scPreviewThenConfirm(browser, results) {
  const sc = mk('Preview before confirmation → confirm → SUCCEEDED link', 'PRD §5 steps 8–11 / §8 Story 3');
  try {
    const dataset = buildFlightDataset(3);
    const token = await configure(dataset, { outcome: 'ok' });
    const { context, page, popup, web2Term } = await handoff(browser, token);
    sc.observed.web2Terminal = web2Term.trim();
    const preview = await popup.locator('#preview-body').innerText();
    sc.observed.preview = preview;
    chk(sc, 'Web 2 received ACCEPTED', web2Term.includes('accepted the report context'), web2Term.trim());
    chk(sc, 'preview is visible before any generation', await popup.locator('#preview').isVisible(), 'preview visibility');
    chk(sc, 'template shown matches 3 flights → CBR4', preview.includes('CBR4'), preview.slice(0, 240));
    chk(sc, 'preview lists all three selected flights', dataset.flightNumbers.every((f) => preview.includes(f)), dataset.flightNumbers.join(','));
    chk(sc, 'preview shows TAF station count from the payload', new RegExp(`TAF stations\\s+${Object.keys(dataset.tafByStation).length}`).test(preview), `expected ${Object.keys(dataset.tafByStation).length}`);
    const expectedNotams = Object.values(dataset.notamsByFlight).flat().length;
    chk(sc, 'preview shows selected NOTAM count from the payload', new RegExp(`Selected NOTAMs\\s+${expectedNotams}`).test(preview), `expected ${expectedNotams}`);
    chk(sc, 'preview shows NO SIG stations', /NO SIG stations/.test(preview), preview.slice(0, 240));
    const requestId = await popup.evaluate(() => { try { return JSON.parse(window.__received.payloadJson).reportRequestId; } catch (e) { return ''; } });
    chk(sc, 'preview shows the request ID', /Request ID/.test(preview) && !!requestId && preview.includes(requestId), `requestId=${requestId}`);
    chk(sc, 'no generation happened before confirmation', (await popup.evaluate(() => window.__confirmCalls || 0)) === 0, 'confirm calls');

    await popup.click('#btn-confirm');
    const deadline = Date.now() + 8000;
    let result = '';
    while (Date.now() < deadline) {
      result = await popup.locator('#result').innerText().catch(() => '');
      if (/SUCCEEDED|ERROR|FAILED|UNKNOWN|BUSY/.test(result)) break;
      await page.waitForTimeout(200);
    }
    sc.observed.result = result;
    sc.observed.rpc = await popup.evaluate(() => window.__calls);
    chk(sc, 'confirmReport called exactly once', sc.observed.rpc.filter((c) => c === 'confirmReport').length === 1, JSON.stringify(sc.observed.rpc));
    chk(sc, 'shows SUCCEEDED with an OPEN GOOGLE SHEET link', /SUCCEEDED/.test(result) && /OPEN GOOGLE SHEET/.test(result), result.trim());
    const href = await popup.locator('#result a').getAttribute('href').catch(() => '');
    chk(sc, 'link points at the generated spreadsheet', /^https:\/\/docs\.google\.com\/spreadsheets\//.test(href || ''), href || '(none)');
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scUnknownResult(browser, results) {
  const sc = mk('Unknown generation result → CHECK REPORT STATUS, no automatic retry', 'PRD §8 Story 3 / §12.7, plan §4 UNKNOWN_RESULT');
  try {
    const dataset = buildFlightDataset(2);
    const token = await configure(dataset, { outcome: 'unknown' });
    const { context, page, popup } = await handoff(browser, token);
    await popup.click('#btn-confirm');
    await page.waitForTimeout(1500);
    const result = await popup.locator('#result').innerText();
    sc.observed.result = result;
    sc.observed.rpc = await popup.evaluate(() => window.__calls);
    chk(sc, 'shows UNKNOWN and instructs status recovery', /UNKNOWN/.test(result) && /CHECK REPORT STATUS/.test(result), result.trim());
    chk(sc, 'generation was attempted exactly once (no auto-retry)', sc.observed.rpc.filter((c) => c === 'confirmReport').length === 1, JSON.stringify(sc.observed.rpc));
    await popup.click('#btn-check');
    await page.waitForTimeout(800);
    const after = await popup.locator('#result').innerText();
    sc.observed.statusResult = after;
    const calls = await popup.evaluate(() => window.__calls);
    chk(sc, 'CHECK REPORT STATUS calls getReportStatus once', calls.filter((c) => c === 'getReportStatus').length === 1, JSON.stringify(calls));
    chk(sc, 'status lookup reports the reconciled SUCCEEDED state', /SUCCEEDED/.test(after), after.trim());
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scReconciliationRequired(browser, results) {
  const sc = mk('Reconciliation required → no blind retry', 'plan §5 rules 4–8, §7 reconciliation scenarios');
  try {
    const dataset = buildFlightDataset(2);
    const token = await configure(dataset, { outcome: 'reconciliation-required' });
    const { context, page, popup } = await handoff(browser, token);
    await popup.click('#btn-confirm');
    await page.waitForTimeout(1200);
    const result = await popup.locator('#result').innerText();
    sc.observed.result = result;
    chk(sc, 'shows RECONCILIATION_REQUIRED with the no-retry instruction', /RECONCILIATION_REQUIRED/.test(result) && /do not retry blindly/i.test(result), result.trim());
    chk(sc, 'only one generation attempt was made', (await popup.evaluate(() => window.__confirmCalls)) === 1, 'confirm count');
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scBusy(browser, results) {
  const sc = mk('Lock BUSY → visible state, no state reset', 'plan §5 rule 3 / time limits: tryLock(5000) → BUSY');
  try {
    const dataset = buildFlightDataset(1);
    const token = await configure(dataset, { outcome: 'busy' });
    const { context, page, popup } = await handoff(browser, token);
    await popup.click('#btn-confirm');
    await page.waitForTimeout(1200);
    const result = await popup.locator('#result').innerText();
    sc.observed.result = result;
    chk(sc, 'shows BUSY and points at status recovery', /BUSY/.test(result) && /CHECK REPORT STATUS/.test(result), result.trim());
    chk(sc, 'preview is retained (no state reset)', await popup.locator('#preview').isVisible(), 'preview visibility');
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scRetryableFailed(browser, results) {
  const sc = mk('Proven pre-create FAILED → visible failure, no silent retry', 'plan §4 FAILED / §5 rule 5');
  try {
    const dataset = buildFlightDataset(1);
    const token = await configure(dataset, { outcome: 'failed' });
    const { context, page, popup } = await handoff(browser, token);
    await popup.click('#btn-confirm');
    await page.waitForTimeout(1200);
    const first = await popup.locator('#result').innerText();
    sc.observed.firstResult = first;
    chk(sc, 'pre-create FAILED is rendered as an explicit failure', /FAILED/.test(first), first.trim());
    chk(sc, 'failure did not silently retry', (await popup.evaluate(() => window.__confirmCalls)) === 1, 'confirm count');
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scConfirmDeadline(browser, results) {
  const sc = mk('Confirm response deadline → generating state, never regeneration', 'plan §5 time limits: 6-minute browser deadline');
  try {
    const dataset = buildFlightDataset(2);
    const token = await configure(dataset, { outcome: 'confirm-timeout' });
    const { context, page, popup } = await handoff(browser, token);
    await popup.click('#btn-confirm');
    await page.waitForTimeout(CONFIRM_DEADLINE_MS);
    const result = await popup.locator('#result').innerText();
    const btnDisabled = await popup.locator('#btn-confirm').isDisabled();
    sc.observed = { result: result.trim(), btnDisabled, confirmCalls: await popup.evaluate(() => window.__confirmCalls) };
    chk(sc, 'UI stays in the generating state without declaring failure', /Generating/i.test(result), result.trim());
    chk(sc, 'confirm button is not re-armed for a new generation', btnDisabled, String(btnDisabled));
    chk(sc, 'only one generation attempt exists', sc.observed.confirmCalls === 1, String(sc.observed.confirmCalls));
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scDirectAccess(browser, results) {
  const sc = mk('Direct access without a valid handoff → safe waiting, cannot generate', 'PRD §8 Story 2: direct open cannot generate');
  try {
    const dataset = buildFlightDataset(1);
    await configure(dataset, { outcome: 'ok' });
    const context = await browser.newContext();
    const page = await context.newPage();
    // No nonce is published, so the shipped page halts even for an opener-free load.
    await page.goto(`${harness.web1Url}?page=report`);
    await page.waitForTimeout(1200);
    const status = await page.locator('#status').innerText().catch(() => '');
    const text = await body(page);
    sc.observed.status = status;
    chk(sc, 'halts in a safe waiting state', /HALT/.test(status), status.trim().slice(0, 240));
    chk(sc, 'no READY was sent (no nonce in the fragment)', !/SENT AWQ_REPORT_READY/.test(status), status.trim().slice(0, 240));
    chk(sc, 'preview is not shown', !(await page.locator('#preview').isVisible()), 'preview visibility');
    chk(sc, 'no confirmation control is reachable', !/GENERATE GOOGLE SHEET/.test(text) || !(await page.locator('#preview').isVisible()), 'confirm control');
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

async function scPayloadIsTheOnlyDataSource(browser, results) {
  const sc = mk('Handoff generation uses only payload context (no Web 1 cache)', 'PRD §8 Story 1: Web 1 must not query its own flight list');
  try {
    const dataset = buildFlightDataset(4);
    const token = await configure(dataset, { outcome: 'ok' });
    const { context, popup } = await handoff(browser, token);
    const received = await popup.evaluate(() => window.__received);
    const payload = JSON.parse(received.payloadJson);
    sc.observed = {
      flightFields: Object.keys(payload.flights[0]),
      tafStations: payload.tafContext.map((t) => t.station),
      notamIdsSentByWeb2: payload.notamContext.map((n) => n.id),
      savedNotamAnalysis: payload.savedNotamAnalysis,
      diagCalls: await popup.evaluate(() => window.__calls)
    };
    chk(sc, 'Web 1 received the full flight objects, not identifiers', payload.flights.every((f) => f.FLIGHT && f.DEP && f.ARR && f.STD && f.REG), JSON.stringify(sc.observed.flightFields));
    chk(sc, 'the receipt path called no flight/TAF/NOTAM lookup RPC', !sc.observed.diagCalls.some((c) => !['reportHandoffDiagnostic', 'recordReportReceived'].includes(c)), JSON.stringify(sc.observed.diagCalls));
    chk(sc, 'TAF text arrived from Web 2 for every station', payload.tafContext.every((t) => t.text && t.text.length > 0), `${payload.tafContext.length} stations`);
    chk(sc, 'NOTAM text arrived from Web 2 for every selected NOTAM', payload.notamContext.every((n) => n.text && n.text.length > 0), `${payload.notamContext.length} notams`);
    chk(
      sc,
      'every saved NOTAM ID is either carried in the payload or reported as dropped by the scope rule',
      Object.entries(payload.savedNotamAnalysis).every(([flt, ids]) => ids.every((id) =>
        payload.notamContext.some((n) => n.id === id && n.flights.includes(flt))
        || (payload.notamScope.dropped || []).some((d) => d.id === id))),
      JSON.stringify({ dropped: (payload.notamScope.dropped || []).map((d) => d.id) })
    );
    chk(
      sc,
      'nothing in savedNotamAnalysis was lost without being reported',
      Object.values(payload.savedNotamAnalysis).flat().length
        === payload.notamContext.length + Number(payload.notamScope.droppedFirWide || 0),
      `saved=${Object.values(payload.savedNotamAnalysis).flat().length} kept=${payload.notamContext.length} dropped=${payload.notamScope.droppedFirWide}`
    );
    await context.close();
  } catch (e) {
    chk(sc, 'scenario executed', false, e.message);
  }
  results.push(sc.finalize());
}

// ------------------------------------------------------------------- runner
const engines = resolveEngines(process.argv[2] || 'chromium');
await mkdir(OUT_DIR, { recursive: true });
harness = await startHarness();

for (const engine of engines) {
  let launched;
  try {
    launched = await launchEngine(engine);
  } catch (e) {
    console.log(`[SKIP] ${engine.id}: launch failed — ${e.message}`);
    continue;
  }
  suite.engines.push(launched.info);
  const results = [];
  for (const scenario of [scPreviewThenConfirm, scUnknownResult, scReconciliationRequired, scBusy, scRetryableFailed, scConfirmDeadline, scDirectAccess, scPayloadIsTheOnlyDataSource]) {
    try {
      await scenario(launched.browser, results);
    } catch (e) {
      const sc = mk(`${scenario.name} (suite error)`, 'suite error');
      chk(sc, 'scenario executed', false, e.message);
      results.push(sc.finalize());
    }
    const last = results[results.length - 1];
    console.log(`[${last.pass ? 'PASS' : 'FAIL'}] ${launched.info.engine} :: ${last.name}${last.pass ? '' : `\n        ${last.checks.filter((c) => !c.ok).map((c) => c.name + ' — ' + c.detail).join('\n        ')}`}`);
  }
  suite.results.push({ browser: launched.info, scenarios: results });
  await launched.browser.close().catch(() => {});
}

const flat = suite.results.flatMap((r) => r.scenarios);
suite.finishedAt = new Date().toISOString();
suite.total = flat.length;
suite.passed = flat.filter((r) => r.pass).length;
suite.failed = flat.filter((r) => !r.pass).length;
await stopHarness();
await writeFile(new URL('interop-results.json', OUT_DIR), JSON.stringify(suite, null, 2), 'utf8');
console.log(`\nGate C Web 1 interop: ${suite.passed}/${suite.total} scenarios passed → test-results/gate-c/interop-results.json`);
process.exit(suite.failed === 0 ? 0 : 1);
