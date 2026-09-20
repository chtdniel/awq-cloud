// Gate B protocol tests: drive the real archive/Report_Handoff.gs state machine
// against an in-memory Apps Script mock (SpreadsheetApp / LockService / Utilities /
// Session). Verifies idempotency, two-phase writes, terminal-state rules,
// reconciliation blocking, lazy expiry, header validation and lock BUSY.
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const src = await readFile(new URL('../archive/Report_Handoff.gs', import.meta.url), 'utf8');

const factory = new Function(
  'Utilities', 'LockService', 'SpreadsheetApp', 'Session', 'PropertiesService', 'getActiveSS', 'requireAuthorized', 'getCurrentUserEmail', 'cleanAviationText',
  src + '\n;return {' +
  ' recordReportReceived: recordReportReceived, confirmReport: confirmReport, getReportStatus: getReportStatus,' +
  ' resetReportAudit: resetReportAudit, trimAudit: reportTrimAudit_,' +
  ' setGenerator: function (fn) { reportGenerateSheet_ = fn; } };'
);

const STATUS_COL = 8; // REPORT_AUDIT_HEADER index of STATUS

function makeEnv() {
  const state = { user: 'ops@x.com', lockAvailable: true, generateCalls: 0, generateMode: 'ok' };
  const sheets = {};

  function makeRange(rows, row, col, numRows, numCols) {
    const rng = {
      getRow: () => row, getColumn: () => col,
      setValues(values) {
        for (let i = 0; i < values.length; i++) {
          const r = row - 1 + i; if (!rows[r]) rows[r] = [];
          for (let j = 0; j < values[i].length; j++) { const c = col - 1 + j; while (rows[r].length <= c) rows[r].push(''); rows[r][c] = values[i][j]; }
        }
        return rng;
      },
      getValues() {
        const out = [];
        for (let i = 0; i < (numRows || 1); i++) {
          const r = rows[row - 1 + i] || []; const line = [];
          for (let j = 0; j < (numCols || 1); j++) { const v = r[col - 1 + j]; line.push(v === undefined ? '' : v); }
          out.push(line);
        }
        return out;
      },
      setValue(v) { const r = row - 1; if (!rows[r]) rows[r] = []; while (rows[r].length < col) rows[r].push(''); rows[r][col - 1] = v; return rng; },
      getValue() { const r = rows[row - 1] || []; const v = r[col - 1]; return v === undefined ? '' : v; },
      clearContent() { for (let i = 0; i < (numRows || 1); i++) { const r = rows[row - 1 + i]; if (r) for (let j = 0; j < (numCols || 1); j++) r[col - 1 + j] = ''; } return rng; },
      setFontWeight() { return rng; }, setFontFamily() { return rng; }, setFontSize() { return rng; },
      setVerticalAlignment() { return rng; }, setWrap() { return rng; }
    };
    return rng;
  }

  function makeTextFinder(rows, query) {
    let entire = false, regex = false;
    const finder = {
      matchEntireCell: (v) => { entire = !!v; return finder; },
      useRegularExpression: (v) => { regex = !!v; return finder; },
      findAll: () => {
        const out = [];
        for (let r = 0; r < rows.length; r++) {
          const line = rows[r] || [];
          for (let c = 0; c < line.length; c++) {
            const cell = String(line[c] === undefined || line[c] === null ? '' : line[c]);
            let hit = false;
            if (regex) { try { hit = new RegExp(query).test(cell); } catch (e) { hit = false; } }
            else if (entire) hit = cell === query;
            else hit = cell.indexOf(query) !== -1;
            if (hit) out.push({ getRow: () => r + 1 });
          }
        }
        return out;
      }
    };
    return finder;
  }

  function makeSheet(name) {
    const rows = [];
    return {
      __rows: rows,
      getName: () => name,
      getLastRow: () => rows.length,
      getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
      appendRow: (r) => { rows.push(r.slice()); },
      getRange: (a, b, c, d) => makeRange(rows, a, b, c, d),
      insertRowBefore: (i) => { rows.splice(i - 1, 0, []); },
      deleteRows: (rowIndex, numRows) => { rows.splice(rowIndex - 1, numRows); },
      createTextFinder: (q) => makeTextFinder(rows, String(q)),
      clearContent: () => { rows.length = 0; }
    };
  }

  const ss = {
    getId: () => 'SS_TEST', getName: () => 'AWQ Test SS',
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => Object.keys(sheets).map((k) => sheets[k]),
    insertSheet: (n) => { sheets[n] = makeSheet(n); return sheets[n]; },
    deleteSheet: () => {}
  };

  const SpreadsheetApp = {
    create: (name) => ({ getId: () => 'SS_NEW', getName: () => name, getUrl: () => 'https://docs.google.com/spreadsheets/d/SS_NEW/edit' }),
    flush: () => {}
  };
  const LockService = { getScriptLock: () => ({ tryLock: () => state.lockAvailable, releaseLock: () => {} }) };
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    formatDate: (d) => new Date(d).toISOString()
  };
  const Session = {
    getScriptTimeZone: () => 'UTC',
    getActiveUser: () => ({ getEmail: () => state.user }),
    getEffectiveUser: () => ({ getEmail: () => 'owner@x.com' })
  };

  const props = {};
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (props[k] === undefined ? null : props[k]),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; }
    })
  };

  const api = factory(Utilities, LockService, SpreadsheetApp, Session, PropertiesService,
    () => ss, () => {}, () => state.user, (t) => String(t));

  api.setGenerator(function (payload, templateName) {
    state.generateCalls++;
    if (state.generateMode === 'throw') throw new Error('simulated create failure');
    const id = 'SS_GEN_' + state.generateCalls;
    return { getId: () => id, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
  });

  return { api, sheets, state, makeSheet, props, audit: () => sheets['REPORT_AUDIT'] };
}

function payload(rid, overrides) {
  return Object.assign({
    version: 1,
    reportRequestId: rid,
    requestedAt: '2026-09-19T00:00:00.000Z',
    flights: [{ FLIGHT: 'QZ646', DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS', STD: '0300', STA: '0600', REG: 'PK-AZK', ALT: 'WMKK', ENR1: 'WARA' }],
    tafContext: [{ station: 'WIII', roles: ['DEP'], flights: ['QZ646'], text: 'TAF WIII 121700Z 1218/1324 27005KT 9999 SCT020', issueTime: '2026-09-12T18:35:44.700Z', available: true }],
    notamContext: [{ id: 'A0001/26', station: 'WIII', flights: ['QZ646'], text: 'A0001/26 NOTAMN E) SAMPLE', status: 'IMPACTED', selected: true }],
    savedNotamAnalysis: { QZ646: ['A0001/26'] },
    noSigStationMap: { WMKK: true }
  }, overrides || {});
}

const statuses = (env) => env.audit().__rows.slice(1).map((r) => r[STATUS_COL]);

const HEADER = ['REQUEST_ID', 'REQUESTED_AT', 'UPDATED_AT', 'PREVIEW_EXPIRES_AT', 'OPERATOR', 'FLIGHTS_JSON', 'PAYLOAD_HASH', 'TEMPLATE', 'STATUS', 'SPREADSHEET_ID', 'SPREADSHEET_URL', 'ERROR'];
function seedRows(env, specs) {
  const sheet = env.makeSheet('REPORT_AUDIT');
  sheet.__rows.push(HEADER.slice());
  specs.forEach((s) => {
    const r = new Array(HEADER.length).fill('');
    r[0] = s.rid; r[2] = s.updatedAt; r[4] = 'ops@x.com'; r[8] = s.status;
    r[9] = s.sheetId || ''; r[10] = s.url || '';
    sheet.__rows.push(r);
  });
  env.sheets['REPORT_AUDIT'] = sheet;
  return sheet;
}

let pass = 0;
function check(name, fn) { fn(); pass++; console.log('  ok - ' + name); }

console.log('gate B protocol tests');

check('receipt registers RECEIVED -> AWAITING_CONFIRMATION', () => {
  const env = makeEnv();
  const r = env.api.recordReportReceived(payload('r1'));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'AWAITING_CONFIRMATION');
  assert.equal(r.template, 'CBR1');
  assert.deepEqual(statuses(env), ['RECEIVED', 'AWAITING_CONFIRMATION']);
});

check('idempotent re-receipt appends nothing and resets nothing', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  const before = env.audit().__rows.length;
  const expiresBefore = env.audit().__rows[1][3];
  const r = env.api.recordReportReceived(payload('r1'));
  assert.equal(r.status, 'AWAITING_CONFIRMATION');
  assert.equal(env.audit().__rows.length, before);
  assert.equal(env.audit().__rows[1][3], expiresBefore);
});

check('changed payload under same request ID is REQUEST_CONFLICT', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  const r = env.api.recordReportReceived(payload('r1', { notamContext: [] }));
  assert.equal(r.status, 'REQUEST_CONFLICT');
});

check('different operator cannot re-receive an existing request', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  env.state.user = 'other@x.com';
  assert.equal(env.api.recordReportReceived(payload('r1')).status, 'UNAUTHORIZED');
  assert.equal(env.api.getReportStatus('r1').status, 'UNAUTHORIZED');
});

check('status lookup: awaiting + NOT_FOUND', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  assert.equal(env.api.getReportStatus('r1').status, 'AWAITING_CONFIRMATION');
  assert.equal(env.api.getReportStatus('missing').status, 'NOT_FOUND');
});

check('lazy expiry: past PREVIEW_EXPIRES_AT reads EXPIRED', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  const rows = env.audit().__rows;
  rows[rows.length - 1][3] = new Date(Date.now() - 1000).toISOString();
  assert.equal(env.api.getReportStatus('r1').status, 'EXPIRED');
  assert.equal(env.api.confirmReport(payload('r1')).status, 'EXPIRED');
});

check('confirm writes the two-phase sequence and SUCCEEDS once', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  const c = env.api.confirmReport(payload('r1'));
  assert.equal(c.ok, true);
  assert.equal(c.status, 'SUCCEEDED');
  assert.equal(env.state.generateCalls, 1);
  assert.deepEqual(statuses(env), ['RECEIVED', 'AWAITING_CONFIRMATION', 'GENERATING', 'CREATE_ATTEMPTED', 'CREATED', 'SUCCEEDED']);
  const created = env.audit().__rows.find((r) => r[STATUS_COL] === 'CREATED');
  assert.equal(created[9], 'SS_GEN_1'); // SPREADSHEET_ID persisted at CREATED
});

check('double confirm returns the same Sheet and never regenerates', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  const c1 = env.api.confirmReport(payload('r1'));
  const c2 = env.api.confirmReport(payload('r1'));
  assert.equal(c2.status, 'SUCCEEDED');
  assert.equal(c2.url, c1.url);
  assert.equal(env.state.generateCalls, 1);
});

check('confirm with a changed payload hash is REQUEST_CONFLICT', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  assert.equal(env.api.confirmReport(payload('r1', { tafContext: [] })).status, 'REQUEST_CONFLICT');
  assert.equal(env.state.generateCalls, 0);
});

check('generator failure after intent -> UNKNOWN, then reconciliation (no retry)', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  env.state.generateMode = 'throw';
  const c1 = env.api.confirmReport(payload('r1'));
  assert.equal(c1.status, 'UNKNOWN');
  env.state.generateMode = 'ok';
  const c2 = env.api.confirmReport(payload('r1'));
  assert.equal(c2.status, 'RECONCILIATION_REQUIRED');
  assert.equal(env.state.generateCalls, 1);
});

check('create-attempt history vetoes retry even if latest row reads FAILED', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  env.state.generateMode = 'throw';
  env.api.confirmReport(payload('r1'));
  const rows = env.audit().__rows;
  rows[rows.length - 1][STATUS_COL] = 'FAILED'; // malformed/regressed latest row
  assert.equal(env.api.confirmReport(payload('r1')).status, 'RECONCILIATION_REQUIRED');
});

check('unresolved same-flight-set request blocks a new request ID', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('a1'));
  env.state.generateMode = 'throw';
  env.api.confirmReport(payload('a1')); // a1 unresolved (UNKNOWN)
  env.state.generateMode = 'ok';
  env.api.recordReportReceived(payload('a2')); // same flights, new ID
  const c = env.api.confirmReport(payload('a2'));
  assert.equal(c.status, 'RECONCILIATION_REQUIRED');
  assert.equal(c.reportRequestId, 'a1');
});

check('different flight set is not blocked', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('a1'));
  env.state.generateMode = 'throw';
  env.api.confirmReport(payload('a1'));
  env.state.generateMode = 'ok';
  const other = payload('b1', { flights: [{ FLIGHT: 'QZ999', DOF: '2026-09-19', DEP: 'WADD', ARR: 'WATO', STD: '0700' }] });
  env.api.recordReportReceived(other);
  assert.equal(env.api.confirmReport(other).status, 'SUCCEEDED');
});

check('invalid REPORT_AUDIT header fails loudly and is not overwritten', () => {
  const env = makeEnv();
  const bad = env.makeSheet('REPORT_AUDIT');
  bad.__rows.push(['WRONG', 'HEADER']);
  env.sheets['REPORT_AUDIT'] = bad;
  const r = env.api.recordReportReceived(payload('r1'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ERROR');
  assert.match(r.error, /mismatch/i);
  assert.equal(bad.__rows.length, 1);
});

check('lock unavailable yields BUSY and no state change', () => {
  const env = makeEnv();
  env.state.lockAvailable = false;
  const r = env.api.recordReportReceived(payload('r1'));
  assert.equal(r.status, 'BUSY');
  assert.equal(env.sheets['REPORT_AUDIT'], undefined);
});

check('CBR template mapping follows flight count', () => {
  const env = makeEnv();
  const two = payload('r2', { flights: [payload('x').flights[0], { FLIGHT: 'QZ647', DOF: '2026-09-19', DEP: 'WSSS', ARR: 'WIII', STD: '0800' }] });
  assert.equal(env.api.recordReportReceived(two).template, 'CBR2');
  const four = payload('r4', { flights: Array.from({ length: 4 }, (_, i) => ({ FLIGHT: 'QZ65' + i, DOF: '2026-09-19', DEP: 'WIII', ARR: 'WSSS', STD: '030' + i })) });
  assert.equal(env.api.recordReportReceived(four).template, 'CBR4');
});

check('audit retention: trim removes settled requests down to the cap', () => {
  const env = makeEnv();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const specs = [];
  for (let i = 0; i < 12; i++) specs.push({ rid: 'r' + i, updatedAt: old, status: 'SUCCEEDED' });
  const sheet = seedRows(env, specs);
  assert.equal(env.api.trimAudit(sheet, 5, 24 * 3600 * 1000), 7);
  assert.equal(sheet.__rows.length, 6); // header + 5
});

check('audit retention: trim NEVER removes unresolved rows', () => {
  const env = makeEnv();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const specs = [];
  for (let i = 0; i < 4; i++) specs.push({ rid: 'u' + i, updatedAt: old, status: 'UNKNOWN' });
  for (let i = 0; i < 4; i++) specs.push({ rid: 't' + i, updatedAt: old, status: 'SUCCEEDED' });
  const sheet = seedRows(env, specs);
  assert.equal(env.api.trimAudit(sheet, 2, 24 * 3600 * 1000), 4);
  assert.deepEqual(sheet.__rows.slice(1).map((r) => r[0]), ['u0', 'u1', 'u2', 'u3']);
});

check('audit retention: trim NEVER removes rows younger than the minimum age', () => {
  const env = makeEnv();
  const fresh = new Date().toISOString();
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push({ rid: 'r' + i, updatedAt: fresh, status: 'SUCCEEDED' });
  const sheet = seedRows(env, specs);
  assert.equal(env.api.trimAudit(sheet, 3, 24 * 3600 * 1000), 0);
  assert.equal(sheet.__rows.length, 11);
});

check('resetReportAudit removes settled requests as whole units', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('r1'));
  env.api.confirmReport(payload('r1'));
  const before = env.audit().__rows.length - 1; // 6 rows, one settled request
  const res = env.api.resetReportAudit(2, true);
  assert.equal(res.rowsBefore, before);
  assert.equal(res.deleted, before); // whole request, no partial trail
  assert.equal(env.audit().__rows.length - 1, 0);
});

check('TextFinder lookup resolves the right request among many', () => {
  const env = makeEnv();
  for (let i = 0; i < 20; i++) env.api.recordReportReceived(payload('req' + i));
  const s = env.api.getReportStatus('req7');
  assert.equal(s.ok, true);
  assert.equal(s.status, 'AWAITING_CONFIRMATION');
  assert.equal(s.reportRequestId, 'req7');
});

// Found live in staging (Gate C, 2026-09-20): a request that SUCCEEDED still blocks new
// requests for the same flight set. reportFindBlockingRequest_ scans only rows whose
// STATUS is unresolved (CREATED / CREATE_ATTEMPTED / …) and asks whether the *request*
// is unresolved, so a completed generation leaves permanent blocking rows behind.
// Operators cannot clear it: the block refuses every new ID, and the old ID reports
// SUCCEEDED without generating. Any second briefing for the same flights is impossible.
check('a SUCCEEDED request does not block a new request for the same flight set', () => {
  const env = makeEnv();
  env.api.recordReportReceived(payload('done1'));
  const first = env.api.confirmReport(payload('done1'));
  assert.equal(first.status, 'SUCCEEDED', 'first generation should succeed');

  env.api.recordReportReceived(payload('next1')); // same flights, new ID
  const second = env.api.confirmReport(payload('next1'));
  assert.equal(second.status, 'SUCCEEDED', `second generation blocked by a finished request (got ${second.status})`);
  assert.notEqual(second.reportRequestId, 'done1');
});

console.log('\n' + pass + ' checks passed');
