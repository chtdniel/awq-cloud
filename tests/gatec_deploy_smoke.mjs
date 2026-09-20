// Gate C — real-deployment smoke checks that need NO Google session.
//
// The Apps Script web app was deployed as "execute as the accessing user", so an
// anonymous call is rejected by authorization. That rejection is itself required
// evidence: PRD §8 Story 4 (unauthorized call is refused, never falls back) and
// §5 (empty/failed operator identity fails closed).
//
// The authenticated half of the deployment smoke test needs an operator Google
// session and is recorded by the manual Firefox/Live checklist.
//
// Usage: node tests/gatec_deploy_smoke.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const DEPLOYMENT = 'https://script.google.com/macros/s/AKfycbz0gdvfrKdGu-7LovIZylT7q-REolKKBNmCRUOL13Dd9gdUZhDmeb6134hMKfv5wLPajA/exec';
const OUT_DIR = new URL('../test-results/gate-c/', import.meta.url);

const record = {
  gate: 'C',
  suite: 'deployment-smoke',
  startedAt: new Date().toISOString(),
  deployment: DEPLOYMENT,
  checks: [],
  observed: {},
  pass: false
};
const chk = (name, ok, detail) => record.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

// ---- 1. deployment response -------------------------------------------------
const res = await fetch(`${DEPLOYMENT}?page=report`);
const html = await res.text();
record.observed.status = res.status;
record.observed.bytes = html.length;
record.observed.isAppsScriptSandbox = !html.includes('<base target="_top">');
record.observed.servedReportPageText = /Report Handoff \(Web 1\)/.test(html) || html.includes('AWQ OCC');
record.observed.hasConfirmControl = html.includes('GENERATE GOOGLE SHEET');
record.observed.hasStatusControl = html.includes('CHECK REPORT STATUS');
record.observed.usesGetLocationCallback = html.includes('google.script.url.getLocation');
record.observed.noLoginWall = !/accounts\.google\.com\/ServiceLogin/.test(html);
chk('deployment answers ?page=report with 200', res.status === 200, `status=${res.status}`);
chk('anonymous request is not redirected to a Google login wall (server-side answer exists)', record.observed.noLoginWall, 'login wall');
chk('deployment response is a non-empty Apps Script document', html.length > 1000 && /<html/i.test(html), `${html.length} bytes`);

// ---- 2. anonymous browser run: ready path must not produce a transfer -------
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`${DEPLOYMENT}?page=report`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);

  // The real page renders inside the Apps Script user-content frame, and Apps
  // Script populates that frame asynchronously — poll rather than sampling once.
  let reportFrame = null;
  const frameDeadline = Date.now() + 25000;
  while (!reportFrame && Date.now() < frameDeadline) {
    for (const frame of page.frames()) {
      if (await frame.locator('#status').count().catch(() => 0)) { reportFrame = frame; break; }
    }
    if (!reportFrame) await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1200); // let the diagnostic RPC answer
  record.observed.frames = page.frames().map((f) => f.url());
  record.observed.reportFrameFound = !!reportFrame;
  // The diagnostic RPC answers asynchronously and its status line can land either
  // before or after the fragment lines — poll for it instead of sampling once.
  let status = reportFrame ? await reportFrame.locator('#status').innerText().catch(() => '(unreadable)') : '(no #status frame)';
  const diagDeadline = Date.now() + 20000;
  while (reportFrame && !/DIAGNOSTIC/.test(status) && Date.now() < diagDeadline) {
    await page.waitForTimeout(500);
    status = await reportFrame.locator('#status').innerText().catch(() => status);
  }
  const previewVisible = reportFrame ? await reportFrame.locator('#preview').isVisible().catch(() => null) : null;
  const confirmVisible = reportFrame ? await reportFrame.locator('#btn-confirm').isVisible().catch(() => null) : null;
  record.observed.web1Status = status;
  record.observed.previewVisible = previewVisible;
  record.observed.confirmVisible = confirmVisible;
  record.observed.diagnosticLine = /DIAGNOSTIC[^\n]*/.exec(status)?.[0] || '';
  record.observed.pageErrors = consoleErrors;

  chk('the deployed report page renders inside the Apps Script user-content frame', !!reportFrame, JSON.stringify(record.observed.frames));
  chk('deployed page contains the confirmation and status controls', await (reportFrame?.locator('#btn-confirm').count().catch(() => 0)) === 1, 'controls');
  chk('deployed page reads the fragment through google.script.url.getLocation', /getLocation|fragment/i.test(status), status.slice(0, 200));
  chk('direct anonymous open halts in the safe waiting state (no opener/payload)', /HALT/.test(status), status.slice(0, 300));
  chk('direct anonymous open never renders the preview', previewVisible === false && confirmVisible === false, `preview=${previewVisible} confirm=${confirmVisible}`);
  chk('direct anonymous open sends no READY (no opener relationship)', !/SENT AWQ_REPORT_READY/.test(status), 'ready');
  // The diagnostic RPC is the one authorized surface. Anonymous access must not
  // hand back a usable operator identity: the deployment runs "execute as the
  // accessing user", so activeUser must be empty and isAuthorized false. The
  // script owner (effectiveUser) may legitimately appear — it is not an operator.
  let diag = null;
  try { diag = JSON.parse((record.observed.diagnosticLine || '').replace(/^DIAGNOSTIC\s*/, '')); } catch { /* not JSON */ }
  record.observed.diagnostic = diag;
  const activeUser = diag ? String(diag.activeUser ?? '') : null;
  chk(
    'anonymous diagnostic returns no operator identity (activeUser empty, isAuthorized false)',
    !!diag && activeUser === '' && diag.isAuthorized === false,
    JSON.stringify(diag)
  );
  chk(
    'anonymous diagnostic confirms the deployment mode (allowedEmailsConfigured / template access)',
    !!diag && diag.allowedEmailsConfigured === true && !!diag.templates && Object.keys(diag.templates).length === 3,
    JSON.stringify(diag && { allowedEmailsConfigured: diag.allowedEmailsConfigured, templates: diag.templates })
  );
  chk('no unhandled page error during the anonymous run', consoleErrors.length === 0, JSON.stringify(consoleErrors));
} finally {
  await browser.close().catch(() => {});
}

record.finishedAt = new Date().toISOString();
record.pass = record.checks.every((c) => c.ok);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('deployment-smoke-results.json', OUT_DIR), JSON.stringify(record, null, 2), 'utf8');
for (const c of record.checks) console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.ok ? '' : ' — ' + c.detail}`);
console.log(`\nGate C deployment smoke: ${record.checks.filter((c) => c.ok).length}/${record.checks.length} checks passed → test-results/gate-c/deployment-smoke-results.json`);
process.exit(record.pass ? 0 : 1);
