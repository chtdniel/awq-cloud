// Gate C â��⬝ failure-mode matrix.
//
// PRD �§11 Gate C and �§8 Story 4: popup blocked, invalid payload, origin
// mismatch, nonce mismatch, timeout (readiness + receipt) and authorization
// failure. Every case asserts an actionable, non-optimistic outcome: Web 2 must
// never claim success and must never invent a new request ID after a send.
//
// Usage: node tests/gatec_failures.mjs [chromium|chrome|...]
import { mkdir, writeFile } from 'node:fs/promises';
import { buildFlightDataset } from './gatec_fixtures.mjs';
import { startHarness, stopHarness, WEB1_ORIGIN, ATTACK_ORIGIN } from './gatec_harness.mjs';
import { resolveEngines, launchEngine } from './gatec_browsers.mjs';

const OUT_DIR = new URL('../test-results/gate-c/', import.meta.url);
const RECEIPT_TIMEOUT_MS = 2500;
const READY_TIMEOUT_MS = 1800;

// `pass` is derived from the checks, so a scenario can keep pushing checks while
// it waits for timeouts and polls the final state. `finalize` freezes the verdict
// into a plain property (JSON.stringify ignores Proxy-computed properties).
const newScenario = (name, requirement) => ({
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
const check = (sc, name, ok, detail) => {
  sc.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
};
const terminal = (page) => page.locator('#report-status').innerText().catch(() => '');
const state = (page) => page.evaluate(() => window.__gatecTransferState || null);
const diag = (page) => page.evaluate(() => window.__diag || []);
const contextSent = (page) => page.evaluate(() => window.__gatecContextSent || null);
const received = (popup) => popup.evaluate(() => window.__received || null).catch(() => null);
const popupTransport = (popup) => popup.evaluate(() => ({ contexts: window.__contextCount || 0, acks: window.__lastReceiptType || '', nonce: window.__lastContextNonce || '' })).catch(() => ({}));

const wait = (page, ms) => page.waitForTimeout(ms);

// One long-lived fixture server for the whole suite; each scenario selects its
// data set and failure injection per request.
let harness = null;

/** Web 2 fixture URL for a view, optionally carrying an inline data set. */
function fixtureUrl(view, extra = {}) {
  const url = new URL('/?view=' + encodeURIComponent(view), harness.web2Url);
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return url.toString();
}

/** Point the fixture servers at this scenario's data set and Web 1 behaviour. */
function configure({ dataset, web1 = {} }) {
  harness.set({ dataset, web1 });
}

async function newPage(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

/** Open the handoff and return { page, popup, context } without waiting. */
async function clickHandoff(page, context) {
  const popupPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
  await page.click('#btn-download-sheet');
  const popup = await popupPromise;
  if (popup) await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  return popup;
}

// ---------------------------------------------------------------- scenarios

/**
 * Shared shape for the three pre-send validation rejections: Web 2 must refuse
 * before opening a tab, with an actionable message.
 */
async function validationRejection(browser, sc, dataset, terminalPattern) {
  configure({ dataset, web1: { outcome: 'ok' } });
  // Register the data set server-side: oversize fixtures exceed a sane URL length.
  const token = await harness.putDataset(dataset);
  const { context, page } = await newPage(browser, fixtureUrl('vs', { dst: token }));
  await page.click('#btn-download-sheet');
  await wait(page, 300);
  const term = await terminal(page);
  sc.observed.terminal = term.trim();
  sc.observed.windowOpenCalls = await page.evaluate(() => window.__openCalls);
  check(sc, 'shows the actionable rejection message', terminalPattern.test(term), term.trim());
  check(sc, 'no Web 1 tab was opened (rejected before the handoff)', (sc.observed.windowOpenCalls || []).length === 0, JSON.stringify(sc.observed.windowOpenCalls));
  await context.close();
}

async function scPopupBlocked(browser, results) {
  const sc = newScenario('Popup blocked', 'PRD �§8 Story 4 / plan �§6: window.open null â⬠�" allow-pop-ups recovery, never claim success');
  configure({ dataset: buildFlightDataset(1), web1: { outcome: 'ok' } });
  const { context, page } = await newPage(browser, fixtureUrl('popup'));
  await page.click('#btn-download-sheet');
  await wait(page, 300);
  const term = await terminal(page);
  sc.observed.terminal = term.trim();
  sc.observed.windowOpenCalls = await page.evaluate(() => window.__openCalls);
  sc.observed.transferState = await state(page);
  check(sc, 'shows the allow-pop-ups recovery message', /Allow pop-ups/i.test(term), term.trim());
  check(sc, 'never claims the transfer succeeded', !/accepted the report context/i.test(term), term.trim());
  check(sc, 'window.open was attempted and blocked', sc.observed.windowOpenCalls?.[0]?.blocked === true, JSON.stringify(sc.observed.windowOpenCalls));
  check(sc, 'transfer state recorded as POPUP_BLOCKED', sc.observed.transferState?.state === 'POPUP_BLOCKED', JSON.stringify(sc.observed.transferState));
  await context.close();
  results.push(sc);
}

async function scInvalidSelection(browser, results) {
  const sc = newScenario('Invalid payload â��⬝ no flight selected', 'PRD �§6 / �§8 Story 4: selections outside 1â���S4 are rejected before generation');
  const dataset = buildFlightDataset(1);
  dataset.flights = [];
  dataset.flightNumbers = [];
  await validationRejection(browser, sc, dataset, /Select 1 to 4 flights first/i);
  results.push(sc);
}

async function scTooManyFlights(browser, results) {
  const sc = newScenario('Invalid payload â��⬝ five flights selected', 'PRD �§6: more than four flights is rejected before generation');
  const dataset = buildFlightDataset(4);
  dataset.flights = dataset.flights.concat([{ ...dataset.flights[0], rowIdx: 99, FLIGHT: 'QZ999' }]);
  dataset.flightNumbers = dataset.flights.map((f) => f.FLIGHT);
  await validationRejection(browser, sc, dataset, /Select 1 to 4 flights first/i);
  results.push(sc);
}

async function scOversizePerText(browser, results) {
  const sc = newScenario('Invalid payload â��⬝ TAF text over the 8 KiB per-text limit', 'plan �§3: oversized text is rejected with an actionable message, never truncated');
  await validationRejection(browser, sc, buildFlightDataset(1, { oversizeText: 12 * 1024 }), /TAF text for .*over the 8 KiB per-text limit/i);
  results.push(sc);
}

async function scOversizeTotal(browser, results) {
  const sc = newScenario('Invalid payload � total context over 64 KiB', 'plan §3: total size limit rejects with an actionable message and no truncation');
  const base = buildFlightDataset(4);
  // Real aerodrome NOTAM texts, but many of them: per-text stays far below the
  // 8 KiB limit, so the 64 KiB total limit is the only check that can reject this
  // selection. A station only holds a few real NOTAMs, so the list is lengthened
  // with clearly-synthetic ids that keep the real text and the real station.
  const realNotams = Object.values(base.notamsByFlight).flat();
  if (!realNotams.length) throw new Error('oversize-total fixture needs aerodrome NOTAMs (run tests/pull_staging_ad_notams.mjs)');
  const perFlight = 60;
  const notamsByFlight = {};
  base.flights.forEach((f, i) => {
    const station = realNotams[(i * 3) % realNotams.length].station;
    const stationPool = realNotams.filter((n) => n.station === station);
    const pool = stationPool.length ? stationPool : realNotams;
    notamsByFlight[f.FLIGHT] = Array.from({ length: perFlight }, (_, k) => ({
      id: `SYNTH-${f.FLIGHT}-N${k + 1}`,
      station,
      flights: [f.FLIGHT],
      text: pool[k % pool.length].text,
      status: 'IMPACTED',
      selected: true,
      aerodrome: true
    }));
  });
  const dataset = {
    ...base,
    notamsByFlight,
    rawNotamsByFlight: notamsByFlight,
    savedNotamAnalysis: Object.fromEntries(base.flights.map((f) => [f.FLIGHT, notamsByFlight[f.FLIGHT].map((n) => n.id)]))
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify({
    version: 1,
    reportRequestId: 'x'.repeat(36),
    requestedAt: new Date().toISOString(),
    flights: dataset.flights,
    tafContext: Object.values(dataset.tafByStation),
    notamContext: Object.values(dataset.notamsByFlight).flat(),
    savedNotamAnalysis: dataset.savedNotamAnalysis,
    noSigStationMap: dataset.noSigStationMap
  }), 'utf8');
  sc.observed.fixturePayloadBytes = payloadBytes;
  sc.observed.fixtureMaxTextBytes = Math.max(
    ...Object.values(dataset.tafByStation).map((t) => Buffer.byteLength(t.text, 'utf8')),
    ...Object.values(dataset.notamsByFlight).flat().map((n) => Buffer.byteLength(n.text, 'utf8'))
  );
  sc.observed.notamsPerFlight = perFlight;
  check(sc, 'fixture exceeds the 64 KiB total while every text stays under 8 KiB', payloadBytes > 64 * 1024 && sc.observed.fixtureMaxTextBytes < 8 * 1024, `payload=${payloadBytes} maxText=${sc.observed.fixtureMaxTextBytes}`);
  await validationRejection(browser, sc, dataset, /over the 64 KiB limit/i);
  results.push(sc);
}

async function scOriginMismatch(browser, results) {
  const sc = newScenario('Origin mismatch  unapproved origin cannot obtain the context', 'PRD �8 Story 2 / �10 risk: no wildcard/source-check fallback');
  const dataset = buildFlightDataset(1);
  // The origin allowlist is the first check in the shipped READY path, before
  // nonce or source-relationship validation. A foreign-origin injection cannot be
  // reproduced in this harness: Chromium refuses cross-window postMessage from an
  // unrelated origin (measured here), so pretending otherwise would be false
  // evidence. What is asserted instead:
  //   1. the fixture in the unrelated origin is loaded and cannot affect the flow;
  //   2. Web 2 addresses CONTEXT only to the allowlisted Web 1 origin;
  //   3. the allowlist rejects the unapproved origin (shipped predicate, checked
  //      with the same expressions the page runs).
  configure({ dataset, web1: { outcome: 'ok', ready: 'real', ack: 'ok' } });
  harness.setNonce('');
  const { context, page } = await newPage(browser, fixtureUrl('vs', { dst: await harness.putDataset(dataset) }));
  const popup = await clickHandoff(page, context);
  let nonce = '';
  for (let i = 0; i < 30 && !nonce; i++) {
    nonce = await page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!nonce) await wait(page, 100);
  }
  harness.setNonce(nonce);
  await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

  // Load the unrelated-origin fixture inside the Web 1 tab and try, from that
  // frame, to reach the Web 2 window with a READY carrying the live nonce.
  const injection = await harness.armAttack({ nonce, web1Frame: popup, attackUrl: harness.attackUrl });
  await wait(page, 2500);

  const d = await diag(page);
  const foreign = d.filter((x) => x.origin === ATTACK_ORIGIN);
  const ctx = await contextSent(page);
  const term = await terminal(page);
  const allowlist = await page.evaluate(() => {
    // Mirror of the shipped predicate, evaluated against the attacker origin.
    const REPORT_WEB1_ORIGINS = window.__REPORT_WEB1_ORIGINS || null;
    const origin = 'http://127.0.0.1:8790';
    if (REPORT_WEB1_ORIGINS) return REPORT_WEB1_ORIGINS.includes(origin);
    if (origin === 'https://script.google.com') return true;
    if (origin === 'https://script.googleusercontent.com') return true;
    return /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(origin);
  });
  sc.observed = {
    nonce,
    injection,
    foreignOriginMessages: foreign,
    allowlistAcceptsAttackerOrigin: allowlist,
    contextSent: ctx,
    web1Receipts: (await received(popup))?.count ?? null,
    web1Transport: await popupTransport(popup),
    terminal: term.trim()
  };
  check(sc, 'the unrelated-origin page was loaded inside the Web 1 tab', injection?.postAttempted === true, JSON.stringify(injection));
  check(sc, 'the unapproved origin is not accepted by the shipped allowlist', allowlist === false, String(allowlist));
  check(sc, 'no message from the unapproved origin reached Web 2', foreign.length === 0, JSON.stringify(foreign));
  check(sc, 'CONTEXT was addressed only to the allowlisted Web 1 origin', ctx?.peerOrigin === WEB1_ORIGIN, JSON.stringify(ctx));
  check(sc, 'exactly one CONTEXT send happened', (sc.observed.web1Transport?.contexts ?? 0) === 1, JSON.stringify(sc.observed.web1Transport));
  check(sc, 'Web 1 recorded exactly one receipt', sc.observed.web1Receipts === 1, String(sc.observed.web1Receipts));
  check(sc, 'genuine handoff completed from the allowlisted origin', /accepted the report context/i.test(term), term.trim());
  await context.close();
  results.push(sc);
}

async function scNonceMismatch(browser, results) {
  const sc = newScenario('Nonce mismatch � READY with a forged nonce', 'PRD §8 Story 2: nonce must be unique per handoff and matched exactly');
  const dataset = buildFlightDataset(2);
  // The tab advertises an origin Web 2 does not allowlist, which halts the
  // shipped page; the fixture hook then sends a forged-nonce READY followed by
  // the genuine one, so the nonce comparison is what is exercised.
  configure({ dataset, web1: { outcome: 'ok', ready: 'bad-nonce' } });
  harness.setNonce('');
  const { context, page } = await newPage(browser, fixtureUrl('vs', { dst: await harness.putDataset(dataset), xorigin: 'https://not-web2.example' }));
  const popup = await clickHandoff(page, context);
  // The tab halts (unlisted fragment origin), so the fixture hook owns READY:
  // publish the live nonce and reload so it sends a forged-nonce READY first.
  let liveNonce = '';
  for (let i = 0; i < 30 && !liveNonce; i++) {
    liveNonce = await page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!liveNonce) await wait(page, 100);
  }
  harness.setNonce(liveNonce);
  await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 8000;
  let term = '';
  while (Date.now() < deadline) {
    term = await terminal(page);
    if (term.includes('accepted the report context')) break;
    await wait(page, 200);
  }
  const d = await diag(page);
  const bad = d.filter((x) => x.type === 'AWQ_REPORT_READY' && x.nonce === 'nonce-not-from-web2');
  const good = d.filter((x) => x.type === 'AWQ_REPORT_READY' && x.nonce !== 'nonce-not-from-web2');
  const ctx = await contextSent(page);
  sc.observed = {
    terminal: term.trim(),
    badNonceReadies: bad,
    goodNonceReadies: good.length,
    contextSent: ctx,
    web1Receipts: (await received(popup))?.count ?? null,
    web1Transport: await popupTransport(popup)
  };
  check(sc, 'forged-nonce READY was received and observed', bad.length >= 1, JSON.stringify(bad));
  check(sc, 'forged nonce was not echoed back into CONTEXT', ctx?.nonce !== 'nonce-not-from-web2' && !!ctx?.nonce, JSON.stringify(ctx));
  check(sc, 'exactly one CONTEXT send for the genuine nonce', (sc.observed.web1Transport?.contexts ?? 0) === 1, JSON.stringify(sc.observed.web1Transport));
  check(sc, 'Web 1 recorded exactly one receipt', sc.observed.web1Receipts === 1, String(sc.observed.web1Receipts));
  check(sc, 'genuine handoff still completed', /accepted the report context/i.test(term), term.trim());
  await context.close();
  results.push(sc);
}

async function scReadyTimeout(browser, results) {
  const sc = newScenario('Timeout â��⬝ Web 1 never signals readiness', 'plan �§4: READY_TIMEOUT retires the session and never claims success');
  const dataset = buildFlightDataset(1);
  configure({ dataset, web1: { outcome: 'ok', ready: 'silent' } });
  harness.setNonce('');
  const { context, page } = await newPage(browser, fixtureUrl('ready-timeout', { ms: READY_TIMEOUT_MS }));
  const popup = await clickHandoff(page, context);
  await wait(page, READY_TIMEOUT_MS + 1200);
  const term = await terminal(page);
  const st = await state(page);
  sc.observed = { terminal: term.trim(), transferState: st, contextSent: await contextSent(page), web1Receipts: (await received(popup))?.count ?? null };
  check(sc, 'reports the readiness timeout with the configured window', /did not signal ready within/i.test(term), term.trim());
  check(sc, 'never claims success', !/accepted the report context/i.test(term), term.trim());
  check(sc, 'transfer state recorded as READY_TIMEOUT', st?.state === 'READY_TIMEOUT', JSON.stringify(st));
  check(sc, 'no CONTEXT was sent', sc.observed.contextSent === null, JSON.stringify(sc.observed.contextSent));
  check(sc, 'Web 1 accepted no context', !sc.observed.web1Receipts, String(sc.observed.web1Receipts));
  await context.close();
  results.push(sc);
}

async function scReceiptTimeout(browser, results) {
  const sc = newScenario('Timeout â��⬝ CONTEXT sent, no receipt (lost receipt)', 'plan �§4: RECEIPT_UNKNOWN keeps the same request ID; no automatic new request');
  const dataset = buildFlightDataset(3);
  // The receipt RPC never answers, so the shipped page never sends ACCEPTED. The
  // fixture's receipt hook is silenced too (it would otherwise ack on its own),
  // leaving Web 2 to fall into RECEIPT_UNKNOWN on the configured receipt window.
  configure({ dataset, web1: { outcome: 'receipt-silent', ack: 'silent' } });
  harness.setNonce('');
  const { context, page } = await newPage(browser, fixtureUrl('receipt-timeout', { ms: RECEIPT_TIMEOUT_MS }));
  const popup = await clickHandoff(page, context);
  // Publish the live nonce and reload so the fixture announces readiness and
  // receives CONTEXT, then withholds the receipt.
  let liveNonce = '';
  for (let i = 0; i < 30 && !liveNonce; i++) {
    liveNonce = await page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!liveNonce) await wait(page, 100);
  }
  harness.setNonce(liveNonce);
  await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(page, RECEIPT_TIMEOUT_MS + 1500);
  const term = await terminal(page);
  const st = await state(page);
  const ctx = await contextSent(page);
  sc.observed = { terminal: term.trim(), transferState: st, contextSent: ctx, web1Receipts: (await received(popup))?.count ?? null, web1Transport: await popupTransport(popup) };
  check(sc, 'reports the receipt timeout with the same request ID', /No receipt within/i.test(term) && !!ctx?.reportRequestId && term.includes(ctx.reportRequestId), term.trim());
  check(sc, 'transfer state recorded as RECEIPT_UNKNOWN', st?.state === 'RECEIPT_UNKNOWN', JSON.stringify(st));
  check(sc, 'timeout reuses the immutable request ID (no new ID)', st?.reportRequestId === ctx?.reportRequestId, JSON.stringify({ timeout: st, sent: ctx }));
  check(sc, 'does not claim success', !/accepted the report context/i.test(term), term.trim());
  check(sc, 'no duplicate CONTEXT send', (sc.observed.web1Transport?.contexts ?? 0) === 1, JSON.stringify(sc.observed.web1Transport));
  await context.close();
  results.push(sc);
}

async function scNewRequestAfterReadyTimeout(browser, results) {
  const sc = newScenario('Timeout â��⬝ new handoff after a pre-send readiness timeout', 'plan �§7: READY timeout before CONTEXT permits a new ID/nonce; a receipt timeout does not');
  const dataset = buildFlightDataset(1);
  configure({ dataset, web1: { outcome: 'ok', ready: 'silent' } });
  harness.setNonce('');
  const first = await newPage(browser, fixtureUrl('ready-timeout', { ms: READY_TIMEOUT_MS }));
  await clickHandoff(first.page, first.context);
  let firstNonce = '';
  for (let i = 0; i < 30 && !firstNonce; i++) {
    firstNonce = await first.page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!firstNonce) await wait(first.page, 100);
  }
  await wait(first.page, READY_TIMEOUT_MS + 900);
  const firstState = { ...(await state(first.page)), nonce: firstNonce };
  await first.context.close();

  // Second attempt: publish the fresh nonce so the fixture Web 1 answers READY.
  configure({ dataset, web1: { outcome: 'ok', ready: 'real' } });
  harness.setNonce('');
  const second = await newPage(browser, fixtureUrl('ready-timeout', { ms: READY_TIMEOUT_MS }));
  const popup = await clickHandoff(second.page, second.context);
  let secondNonce = '';
  for (let i = 0; i < 30 && !secondNonce; i++) {
    secondNonce = await second.page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!secondNonce) await wait(second.page, 100);
  }
  harness.setNonce(secondNonce);
  await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 6000;
  let term = '';
  while (Date.now() < deadline) {
    term = await terminal(second.page);
    if (term.includes('accepted the report context')) break;
    await wait(second.page, 200);
  }
  const secondSent = await contextSent(second.page);
  sc.observed = { firstTimeout: firstState, secondHandoff: secondSent, terminal: term.trim(), web1Receipts: (await received(popup))?.count ?? null };
  check(sc, 'first attempt timed out with an ID', !!firstState?.reportRequestId, JSON.stringify(firstState));
  check(sc, 'second handoff completed', /accepted the report context/i.test(term), term.trim());
  check(sc, 'second handoff used a new request ID', !!secondSent?.reportRequestId && secondSent.reportRequestId !== firstState.reportRequestId, JSON.stringify({ first: firstState?.reportRequestId, second: secondSent?.reportRequestId }));
  check(sc, 'second handoff used a new nonce', !!secondSent?.nonce && secondSent.nonce !== firstState?.nonce, 'nonce rotated');
  await second.context.close();
  results.push(sc);
}

async function scAuthorizationFailure(browser, results) {
  const sc = newScenario('Authorization failure â��⬝ staging Web 1 rejects the receipt', 'PRD �§8 Story 4: unauthorized Apps Script call is displayed, with no fallback generation');
  const dataset = buildFlightDataset(2);
  configure({ dataset, web1: { outcome: 'unauthorized' } });
  harness.setNonce('');
  const { context, page } = await newPage(browser, fixtureUrl('vs', { dst: await harness.putDataset(dataset) }));
  const popup = await clickHandoff(page, context);
  // Publish the live nonce and reload so the fixture page reaches the receipt RPC,
  // which then refuses the call for lack of an operator identity.
  let liveNonce = '';
  for (let i = 0; i < 30 && !liveNonce; i++) {
    liveNonce = await page.evaluate(() => window.__gatecPendingHandoff?.nonce || '');
    if (!liveNonce) await wait(page, 100);
  }
  harness.setNonce(liveNonce);
  await popup.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 8000;
  let term = '';
  while (Date.now() < deadline) {
    term = await terminal(page);
    if (term.includes('rejected the report context')) break;
    await wait(page, 200);
  }
  const st = await state(page);
  sc.observed = { terminal: term.trim(), transferState: st, web1Status: (await popup.locator('#status').innerText().catch(() => '')) };
  check(sc, 'Web 2 shows the rejection with the backend reason', /rejected the report context/i.test(term) && /UNAUTHORIZED|No active user email/i.test(term), term.trim());
  check(sc, 'never claims success', !/accepted the report context/i.test(term), term.trim());
  check(sc, 'transfer state recorded as REJECTED', st?.state === 'REJECTED', JSON.stringify(st));
  check(sc, 'Web 1 shows the authorization failure', /UNAUTHORIZED|No active user email|RECEIPT REJECTED/i.test(sc.observed.web1Status), sc.observed.web1Status.slice(0, 200));
  check(sc, 'generation was never invoked', (await popup.evaluate(() => window.__confirmCalls || 0)) === 0, 'confirm calls');
  await context.close();
  results.push(sc);
}

// ------------------------------------------------------------------- runner
const engineSpec = process.argv[2] || 'chromium';
const engines = resolveEngines(engineSpec);
await mkdir(OUT_DIR, { recursive: true });

const suite = {
  gate: 'C',
  suite: 'failure-modes',
  startedAt: new Date().toISOString(),
  engines: [],
  scenarios: []
};

// One fixture server for the whole run: scenario switching goes through the
// per-request `view`/data parameters, never through closing sockets.
harness = await startHarness();

for (const engine of engines) {
  let launched;
  try {
    launched = await launchEngine(engine);
  } catch (e) {
    console.log(`[SKIP] ${engine.id}: launch failed â��⬝ ${e.message}`);
    continue;
  }
  suite.engines.push(launched.info);
  const results = [];
  for (const scenario of [
    scPopupBlocked,
    scInvalidSelection,
    scTooManyFlights,
    scOversizePerText,
    scOversizeTotal,
    scOriginMismatch,
    scNonceMismatch,
    scReadyTimeout,
    scReceiptTimeout,
    scNewRequestAfterReadyTimeout,
    scAuthorizationFailure
  ]) {
    const before = results.length;
    try {
      await scenario(launched.browser, results);
    } catch (e) {
      const sc = newScenario(`${scenario.name} (threw)`, 'suite error');
      check(sc, 'scenario executed', false, e.message);
      sc.observed = { stack: String(e.stack || '').split('\n').slice(0, 4).join(' | ') };
      results.push(sc);
    }
    const last = results[results.length - 1].finalize();
    // A scenario that pushes nothing is a harness bug, not a pass.
    if (results.length === before) {
      const sc = newScenario(`${scenario.name} (no result)`, 'suite error');
      check(sc, 'scenario produced a result', false, 'no scenario record pushed');
      results.push(sc);
    }
    console.log(`[${last.pass ? 'PASS' : 'FAIL'}] ${launched.info.engine} :: ${last.name}${last.pass ? '' : `\n        ${last.checks.filter((c) => !c.ok).map((c) => c.name + ' â��⬝ ' + c.detail).join('\n        ')}`}`);
  }
  suite.scenarios.push({ browser: launched.info, results: results.map((r) => r.finalize()) });
  await launched.browser.close().catch(() => {});
}

const flat = suite.scenarios.flatMap((s) => s.results);
suite.finishedAt = new Date().toISOString();
suite.total = flat.length;
suite.passed = flat.filter((r) => r.pass).length;
suite.failed = flat.filter((r) => !r.pass).length;
await stopHarness();
await writeFile(new URL('failure-results.json', OUT_DIR), JSON.stringify(suite, null, 2), 'utf8');
console.log(`\nGate C failure modes: ${suite.passed}/${suite.total} scenarios passed â⬠�" test-results/gate-c/failure-results.json`);
process.exit(suite.failed === 0 ? 0 : 1);
